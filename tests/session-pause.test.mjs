import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { privacyChrome } from './helpers/privacy-chrome.mjs';
import { createClassicContext, runClassicScript } from './helpers/load-classic-script.mjs';
import { createOverlayDocument } from './helpers/overlay-dom.mjs';
import { activeElapsedMs, budgetEndsAt, isSessionPaused } from '../session-metrics.js';

const MIN = 60_000;

test('pause-aware timer helpers exclude paused time', () => {
  const session = { startTime: 0, timeBudget: 30, pausedMs: 5 * MIN };
  assert.equal(activeElapsedMs(session, 20 * MIN), 15 * MIN);
  assert.equal(budgetEndsAt(session), 35 * MIN);
  const paused = { ...session, pausedAt: 10 * MIN };
  assert.equal(isSessionPaused(paused), true);
  assert.equal(activeElapsedMs(paused, 50 * MIN), 5 * MIN, 'the clock stops at pausedAt');
  assert.equal(budgetEndsAt({ startTime: 0, timeBudget: 'abc' }), null);
  assert.equal(activeElapsedMs({ startTime: 'x' }), 0);
});

// A worker with alarms and tabs that the test can observe.
const h = privacyChrome();
const alarms = new Map();
const shown = [];
h.chrome.alarms = {
  onAlarm: { addListener() {} },
  create: (name, info) => alarms.set(name, info),
  clear: (name) => alarms.delete(name),
  get: (name, cb) => cb(alarms.get(name)),
};
h.chrome.tabs.get = (id, cb) => { const tab = { id, url: 'https://unrelated.example/a' }; cb?.(tab); return Promise.resolve(tab); };
h.chrome.tabs.sendMessage = (id, message, cb) => { if (message.type === 'SHOW_INTERVENTION') shown.push({ id, reason: message.reason }); cb?.({ shown: true }); };
h.chrome.tabs.group = () => Promise.resolve(1);
h.chrome.tabGroups = { update: () => Promise.resolve(), get: () => Promise.resolve() };
globalThis.chrome = h.chrome;
const worker = await import('../background.js');
const queue = await import('../storage-queue.js');
await queue.enqueueStorageMutation(() => {});
await worker.reloadConfig();
const client = await import('../storage-client.js');
await client.initializeStorageClient();
const settle = async () => { for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 5)); await queue.enqueueStorageMutation(() => {}); } };
const content = { id: 'privacy-test', tab: { id: 4 }, url: 'https://unrelated.example/a' };

async function start(extra = {}) {
  await client.sendStorageAction({ type: 'SESSION_STARTED', session: {
    id: `pause-${Math.random()}`, intent: 'write the quarterly budget memo', isActive: true, startTime: Date.now(), events: [], ...extra,
  } });
  shown.length = 0;
  return h.local.activeSession;
}
const pause = (paused, session) => client.sendStorageAction({ type: 'PAUSE_SESSION', paused, sessionId: session.id });
async function dwell(n) {
  await h.send({ type: 'CONTENT_EVENT', payload: { actionType: 'PAGE_DWELL', url: 'https://unrelated.example/a',
    dwellMs: n * 30_000, dwellDeltaMs: 30_000 } }, content);
  await settle();
}

test('pausing stops the budget alarm and resuming shifts it by the paused time', async () => {
  const session = await start({ timeBudget: 30 });
  assert.equal(alarms.get('intentlock-budget-alarm').when, session.startTime + 30 * MIN);
  await pause(true, session);
  assert.ok(isSessionPaused(h.local.activeSession));
  assert.equal(alarms.has('intentlock-budget-alarm'), false);
  // Pretend the pause lasted ten minutes.
  h.local.activeSession.pausedAt -= 10 * MIN;
  const resumed = (await pause(false, session)).session;
  assert.equal(isSessionPaused(resumed), false);
  assert.ok(resumed.pausedMs >= 10 * MIN && resumed.pausedMs < 10 * MIN + 5000);
  assert.equal(alarms.get('intentlock-budget-alarm').when, session.startTime + 30 * MIN + resumed.pausedMs);
  const again = (await pause(false, session)).session;
  assert.equal(again.pausedMs, resumed.pausedMs, 'a repeated resume changes nothing');
});

test('two minutes of active dwell locks the page in place, once, without AI', async () => {
  await start();
  for (const n of [1, 2, 3]) await dwell(n);
  assert.deepEqual(shown, [], '90 seconds is below the limit');
  await dwell(4);
  assert.equal(shown.length, 1);
  assert.match(shown[0].reason, /long time on an unrelated site/);
  await dwell(5);
  await dwell(6);
  assert.equal(shown.length, 1, 'an already displayed lock is not fired again');
});

test('an override cooldown suppresses further dwell locks on that site', async () => {
  const session = await start();
  for (const n of [1, 2, 3, 4]) await dwell(n);
  const state = Object.values(h.local.interventionStates).find(s => s.sessionId === session.id);
  const result = await h.send({ type: 'INTERVENTION_TRANSITION', transition: 'override', sessionId: session.id,
    nonce: state.nonce, reflection: 'synthetic reason' }, content);
  assert.equal(result.ok, true);
  shown.length = 0;
  for (const n of [5, 6, 7, 8]) await dwell(n);
  assert.deepEqual(shown, []);
});

test('while paused, dwell is not recorded and no dwell lock fires', async () => {
  const session = await start();
  await pause(true, session);
  const before = structuredClone(h.local.activeSession);
  for (const n of [1, 2, 3, 4, 5, 6]) await dwell(n);
  assert.deepEqual(shown, []);
  assert.equal(h.local.activeSession.events.filter(e => e.actionType === 'PAGE_DWELL').length, 0);
  assert.equal(h.local.activeSession.metrics.activeMs, before.metrics.activeMs);
  await pause(false, session);
  for (const n of [1, 2, 3, 4]) await dwell(n);
  assert.equal(shown.length, 1, 'enforcement resumes with the timer');
});

test('pause requests need an extension page and an epoch', async () => {
  const session = await start();
  const fromContent = await h.send({ type: 'PAUSE_SESSION', paused: true, sessionId: session.id,
    epoch: h.local.privacyMutationState.epoch }, content);
  assert.equal(fromContent.status, 'error');
  const noEpoch = await h.send({ type: 'PAUSE_SESSION', paused: true, sessionId: session.id });
  assert.equal(noEpoch.status, 'error');
  const bad = await h.send({ type: 'PAUSE_SESSION', paused: 'yes', sessionId: session.id, epoch: h.local.privacyMutationState.epoch });
  assert.equal(bad.status, 'error');
  assert.equal(isSessionPaused(h.local.activeSession), false);
});

function restartWorker(activeSession) {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { privacyChrome } from './tests/helpers/privacy-chrome.mjs';
    const h = privacyChrome({ activeSession: ${JSON.stringify(activeSession)} });
    const alarms = new Map(); const shown = [];
    h.chrome.alarms = { onAlarm: { addListener() {} }, create: (n, i) => alarms.set(n, i), clear: n => alarms.delete(n), get: (n, cb) => cb(alarms.get(n)) };
    h.chrome.tabs.query = (_q, cb) => { const t = [{ id: 4, url: 'https://unrelated.example/a' }]; cb?.(t); return Promise.resolve(t); };
    h.chrome.tabs.sendMessage = (id, m, cb) => { if (m.type === 'SHOW_INTERVENTION') shown.push(m.reason); cb?.({ shown: true }); };
    globalThis.chrome = h.chrome;
    await import('./background.js');
    const queue = await import('./storage-queue.js');
    for (let i = 0; i < 5; i++) { await new Promise(r => setTimeout(r, 5)); await queue.enqueueStorageMutation(() => {}); }
    console.log(JSON.stringify({ shown, alarms: Object.fromEntries(alarms), session: h.local.activeSession }));
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

test('a paused timer survives a worker restart without firing the budget', () => {
  const now = Date.now();
  const result = restartWorker({ id: 'p', intent: 'synthetic', isActive: true, events: [],
    startTime: now - 60 * MIN, timeBudget: 30, pausedAt: now - 50 * MIN, pausedMs: 0 });
  assert.equal(result.session.pausedAt, now - 50 * MIN);
  assert.deepEqual(result.shown, []);
  assert.equal('intentlock-budget-alarm' in result.alarms, false);
});

test('after a restart the budget alarm accounts for earlier pauses', () => {
  const now = Date.now();
  const running = restartWorker({ id: 'r', intent: 'synthetic', isActive: true, events: [],
    startTime: now - 40 * MIN, timeBudget: 30, pausedAt: null, pausedMs: 20 * MIN });
  assert.deepEqual(running.shown, []);
  assert.equal(running.alarms['intentlock-budget-alarm'].when, now - 40 * MIN + 50 * MIN);
  const exhausted = restartWorker({ id: 'e', intent: 'synthetic', isActive: true, events: [],
    startTime: now - 40 * MIN, timeBudget: 30, pausedAt: null, pausedMs: 5 * MIN });
  assert.deepEqual(exhausted.shown, ['Time budget exceeded.']);
});

test('the content tracker stops counting dwell while the session is paused', async () => {
  const { document, MutationObserver, matchMedia } = createOverlayDocument();
  document.removeEventListener = () => {};
  let storageListener; let tick; let clock = 1_000_000;
  const reports = [];
  const session = { id: 's', isActive: true, startTime: 0 };
  const chromeStub = {
    runtime: { getURL: p => p, onMessage: { addListener() {} },
      sendMessage(message, cb) { if (message.type === 'CONTENT_EVENT') reports.push(message.payload); cb?.({}); } },
    storage: { onChanged: { addListener(fn) { storageListener = fn; } },
      local: { get(_k, cb) { cb({ activeSession: session, trackingEnabled: true }); } } },
  };
  const context = createClassicContext({ chrome: chromeStub, document, MutationObserver,
    window: { matchMedia, addEventListener() {}, removeEventListener() {} },
    location: { href: 'https://unrelated.example/a' }, history: { pushState() {}, replaceState() {} },
    Date: { now: () => clock }, setInterval: fn => { tick = fn; return 1; }, clearInterval() {},
    requestAnimationFrame: cb => cb() });
  for (const file of ['page-tracker.js', 'intervention-overlay.js', 'content.js']) {
    await runClassicScript(new URL('../' + file, import.meta.url), context);
  }
  const dwellDelta = () => reports.filter(r => r.actionType === 'PAGE_DWELL').at(-1)?.dwellDeltaMs;
  clock += 30_000; tick();
  assert.equal(dwellDelta(), 30_000);
  storageListener({ activeSession: { oldValue: session, newValue: { ...session, pausedAt: clock } } }, 'local');
  clock += 60_000; tick();
  assert.equal(dwellDelta(), 0, 'paused time is not dwell');
  storageListener({ activeSession: { oldValue: { ...session, pausedAt: 1 }, newValue: { ...session, pausedAt: null, pausedMs: 60_000 } } }, 'local');
  clock += 30_000; tick();
  assert.equal(dwellDelta(), 30_000);
});
