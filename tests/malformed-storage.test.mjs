import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

// Corrupted or old-schema storage must neither crash the worker nor lock a tab.
function exercise(local) {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const errors = [];
    process.on('uncaughtException', e => errors.push(String(e && e.stack || e)));
    process.on('unhandledRejection', e => errors.push(String(e && e.stack || e)));
    const { privacyChrome } = await import('./tests/helpers/privacy-chrome.mjs');
    const h = privacyChrome(${JSON.stringify(local)});
    const updated = [];
    const shown = [];
    h.chrome.tabs.onUpdated = { addListener: fn => updated.push(fn) };
    h.chrome.tabs.get = (id, cb) => { const t = { id, url: 'https://unrelated.example/x' }; cb?.(t); return Promise.resolve(t); };
    h.chrome.tabs.query = (_q, cb) => { const t = [{ id: 3, url: 'https://unrelated.example/x' }]; cb?.(t); return Promise.resolve(t); };
    h.chrome.tabs.sendMessage = (id, m, cb) => { if (m.type === 'SHOW_INTERVENTION') shown.push(m.reason); cb?.({ shown: true }); };
    h.chrome.tabs.update = (_i, _p, cb) => cb?.({});
    h.chrome.tabs.create = (_p, cb) => cb?.({ id: 9 });
    h.chrome.tabs.group = () => Promise.resolve(1);
    h.chrome.tabGroups = { update: () => Promise.resolve(), get: () => Promise.resolve() };
    globalThis.chrome = h.chrome;
    await import('./background.js');
    const queue = await import('./storage-queue.js');
    const settle = async () => { for (let i = 0; i < 5; i++) { await new Promise(r => setTimeout(r, 5)); await queue.enqueueStorageMutation(() => {}); } };
    await settle();
    const content = { id: 'privacy-test', tab: { id: 3 }, url: 'https://unrelated.example/x' };
    const replies = [];
    replies.push(await h.send({ type: 'CONTENT_EVENT', payload: { actionType: 'PAGE_DWELL', url: 'https://unrelated.example/x', dwellMs: 1000, dwellDeltaMs: 1000 } }, content));
    replies.push(await h.send({ type: 'CONTENT_EVENT', payload: { actionType: 'SPA_NAVIGATION', url: 'https://unrelated.example/x', previousUrl: 'https://unrelated.example/x', navigationUrl: 'https://unrelated.example/y', dwellMs: 1000, dwellDeltaMs: 1000 } }, content));
    for (const fn of updated) fn(3, { status: 'complete' }, { id: 3, url: 'https://unrelated.example/x' });
    await settle();
    replies.push(await h.send({ type: 'GET_INTERVENTION_STATE' }, content));
    replies.push(await h.send({ type: 'END_ACTIVE_SESSION', epoch: h.local.privacyMutationState.epoch }));
    await settle();
    console.log(JSON.stringify({ errors, shown, replies, local: h.local }));
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

const now = Date.now();

test('a corrupted time budget does not read as already exceeded', () => {
  const result = exercise({ activeSession: { id: 's', intent: 'unrelated work', isActive: true, startTime: now, events: [], timeBudget: 'abc' } });
  assert.deepEqual(result.errors, []);
  assert.equal(result.shown.includes('Time budget exceeded.'), false);
});

test('malformed session, policy, cooldown and history values are tolerated', () => {
  const result = exercise({
    activeSession: { id: 's', intent: 'work', isActive: true, startTime: now, events: [null, 1, { url: 5 }], metrics: 7 },
    heuristicPolicy: { version: 1, categoryPolicies: null, customAllowDomains: [null, 5], customBlockDomains: {} },
    overrideCooldowns: 'bad', relatedDomainMarks: [1, 2], interventionStates: 'bad',
    completedInterventionTransitions: 5, sessionHistory: { a: 1 }, errorLog: 'bad', llmBackoffUntil: 'soon',
  });
  assert.deepEqual(result.errors, []);
  assert.ok(result.replies.every(reply => reply.status !== 'error'), JSON.stringify(result.replies));
  assert.equal(result.replies[3].session.id, 's', 'a session with corrupted events can still be ended');
  assert.equal(result.local.activeSession, undefined, 'the session still ends cleanly');
  assert.ok(Array.isArray(result.local.sessionHistory));
  assert.ok(Array.isArray(result.local.errorLog));
});

test('legacy history entries of the wrong shape are dropped rather than crashing', () => {
  const result = exercise({
    sessionHistory: [null, 'x', { endTime: 'x' }, { id: 'ok', endTime: now, overrides: 'x', topDomains: [null] }],
    overrideCooldowns: [[1], ['a.example', 'b'], null],
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.local.sessionHistory.map(entry => entry?.id), ['ok'], JSON.stringify(result.local.sessionHistory));
});
