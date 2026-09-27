import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Each case imports a fresh worker against synthetic storage.
function startWorker(local, after = '') {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { privacyChrome } from './tests/helpers/privacy-chrome.mjs';
    const h = privacyChrome(${JSON.stringify(local)});
    const alarms = new Map();
    const alarmListeners = [];
    h.chrome.alarms = {
      onAlarm: { addListener: fn => alarmListeners.push(fn) },
      create: (name, info) => { alarms.set(name, info); h.calls.push('alarm:create:' + name); },
      clear: (name) => { alarms.delete(name); h.calls.push('alarm:clear:' + name); },
      get: (name, cb) => cb(alarms.get(name)),
    };
    globalThis.chrome = h.chrome;
    const worker = await import('./background.js');
    const queue = await import('./storage-queue.js');
    const settle = async () => { for (let i = 0; i < 5; i++) { await new Promise(r => setTimeout(r, 5)); await queue.enqueueStorageMutation(() => {}); } };
    await settle();
    ${after}
    await settle();
    console.log(JSON.stringify({ local: h.local, calls: h.calls, alarms: [...alarms.keys()],
      current: worker.getInMemoryState().currentSession }));
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

const session = (ageMs, extra = {}) => ({
  id: 'abandoned', intent: 'synthetic intent', isActive: true, startTime: Date.now() - ageMs, events: [], timeBudget: 30, ...extra,
});

test('a session older than 24 hours is ended at worker start and stops collecting', () => {
  const result = startWorker({ activeSession: session(25 * HOUR) });
  assert.equal(result.local.activeSession, undefined);
  assert.equal(result.current, null);
  assert.equal(result.local.sessionHistory.length, 1);
  assert.equal(result.local.sessionHistory[0].id, 'abandoned');
  assert.equal(result.calls.includes('alarm:create:intentlock-budget-alarm'), false, 'no time budget restore');
});

test('a session younger than 24 hours is kept', () => {
  const result = startWorker({ activeSession: session(23 * HOUR, { timeBudget: null }) });
  assert.equal(result.local.activeSession.id, 'abandoned');
  assert.equal(result.current.id, 'abandoned');
  assert.ok(result.alarms.includes('intentlock-retention'));
});

test('a malformed active session without a start time is ended', () => {
  const result = startWorker({ activeSession: session(0, { startTime: 'yesterday' }) });
  assert.equal(result.local.activeSession, undefined);
  assert.equal(result.current, null);
});

test('startup prunes old summaries and diagnostics in storage', () => {
  const now = Date.now();
  const errorLog = [
    ...Array.from({ length: 205 }, (_, i) => ({ id: `e${i}`, timestamp: now - i * 1000, message: 'recent', type: 'api' })),
  ];
  errorLog.push({ id: 'old', timestamp: now - 15 * DAY, message: 'expired token=abc123', type: 'api' });
  const result = startWorker({
    sessionHistory: [
      { id: 'expired', startTime: now - 40 * DAY, endTime: now - 31 * DAY },
      { id: 'kept', startTime: now - 2 * DAY, endTime: now - 2 * DAY + HOUR },
    ],
    errorLog,
  });
  assert.deepEqual(result.local.sessionHistory.map(entry => entry.id), ['kept']);
  assert.equal(result.local.errorLog.length, 200);
  assert.equal(result.local.errorLog.some(entry => entry.id === 'old'), false);
  assert.ok(result.alarms.includes('intentlock-retention'));
});

test('the retention alarm ends a session that crossed 24 hours while the worker ran', () => {
  const result = startWorker({ activeSession: session(23 * HOUR, { timeBudget: null }) }, `
    h.local.activeSession.startTime = Date.now() - 25 * ${HOUR};
    for (const fn of alarmListeners) fn({ name: 'intentlock-retention' });
  `);
  assert.equal(result.local.activeSession, undefined);
  assert.equal(result.local.sessionHistory[0].id, 'abandoned');
  assert.equal(result.current, null);
});

test('no retention alarm is kept when nothing personal remains', () => {
  const result = startWorker({ sessionHistory: [{ id: 'expired', startTime: 1, endTime: 2 }] });
  assert.deepEqual(result.local.sessionHistory, []);
  assert.equal(result.alarms.includes('intentlock-retention'), false);
});
