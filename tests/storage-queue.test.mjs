import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { privacyChrome, until } from './helpers/privacy-chrome.mjs';

const h = privacyChrome();
globalThis.chrome = h.chrome;
const worker = await import('../background.js');
const queue = await import('../storage-queue.js');
await queue.enqueueStorageMutation(() => {});
await worker.reloadConfig();
// Independent page modules cross the real worker message boundary.
const a = await import('../storage-client.js?page-a');
const b = await import('../storage-client.js?page-b');
await a.initializeStorageClient();
await b.initializeStorageClient();
const marker = queue.PRIVACY_MARKER;
const config = { providerId: 'ollama', model: 'synthetic', baseUrl: 'http://127.0.0.1:11434/api/chat' };
const session = id => ({ id, intent: 'synthetic work', startTime: Date.now(), isActive: true, events: [] });
async function erase() {
  const result = await h.send({ type: 'DELETE_ALL_DATA' });
  assert.equal(result.status, 'ok', result.message);
}
function onlyMarker() {
  assert.deepEqual(Object.keys(h.local), [marker]);
  assert.deepEqual(h.session, {});
  assert.equal(h.local[marker].deleting, false);
}

test('two page runtimes serialize commands without losing another page entry', async () => {
  await Promise.all([
    a.mutateStorage('appendError', { entry: { message: 'first', timestamp: Date.now() } }),
    b.mutateStorage('appendError', { entry: { message: 'second', timestamp: Date.now() } }),
  ]);
  assert.deepEqual(h.local.errorLog.map(entry => entry.message).sort(), ['first', 'second']);
  await erase();
});

test('delayed Settings save cannot restore data after completed deletion', async () => {
  const originalEpoch = a.captureStorageEpoch();
  let release;
  const epoch = new Promise(resolve => { release = async () => resolve(await originalEpoch); });
  await erase();
  release();
  await assert.rejects(a.mutateStorage('saveProvider', { config, key: 'synthetic-key' }, epoch), /changed|deletion/);
  onlyMarker();
  await b.mutateStorage('theme', { theme: 'dark' });
  assert.equal(h.local.theme, 'dark');
  await erase();
});

test('deletion drains submitted write and rejects its delayed key continuation', async () => {
  h.holdNext(op => op.area === 'local' && op.method === 'set' && op.value?.llmProviderConfig);
  const saving = a.mutateStorage('saveProvider', { config, key: 'synthetic-old-key' });
  const rejected = assert.rejects(saving, /changed|deletion/);
  await until(() => h.isHeld);
  const deleting = erase();
  h.release();
  await Promise.all([rejected, deleting]);
  onlyMarker();
});

test('stale start end and clear callbacks cannot cross completed deletion', async () => {
  const oldEpoch = await a.captureStorageEpoch();
  await erase();
  await b.sendStorageAction({ type: 'SESSION_STARTED', session: session('new-session') });
  for (const message of [
    { type: 'SESSION_STARTED', session: session('stale-session') },
    { type: 'END_ACTIVE_SESSION', sessionId: 'new-session' },
    { type: 'SESSION_CLEARED' },
  ]) await assert.rejects(a.sendStorageAction(message, oldEpoch), /changed|deletion/);
  assert.equal(h.local.activeSession.id, 'new-session');
  assert.equal(h.local.sessionHistory, undefined);
  await erase();
});

test('in-flight end read cannot persist history after the deletion fence', async () => {
  await a.sendStorageAction({ type: 'SESSION_STARTED', session: session('ending') });
  h.holdNext(op => op.area === 'local' && op.method === 'get' && op.value?.includes('sessionHistory'));
  const ending = a.sendStorageAction({ type: 'END_ACTIVE_SESSION', sessionId: 'ending' });
  const rejected = assert.rejects(ending, /changed|deletion/);
  await until(() => h.isHeld);
  const deleting = erase();
  h.release();
  await Promise.all([rejected, deleting]);
  onlyMarker();
});

for (const area of ['local', 'session']) test('partial ' + area + ' clear failure leaves durable barrier and retry', async () => {
  await a.mutateStorage('saveProvider', { config, key: 'synthetic-key' });
  h.failNext(op => op.area === area && op.method === (area === 'local' ? 'remove' : 'clear'));
  const result = await h.send({ type: 'DELETE_ALL_DATA' });
  assert.equal(result.status, 'error');
  assert.equal(h.local[marker].deleting, true);
  assert.equal(queue.isStorageDeletionActive(), true);
  assert.equal(worker.getInMemoryState().currentSession, null);
  await assert.rejects(a.mutateStorage('theme', { theme: 'dark' }), /deletion/);
  if (area === 'local') { assert.ok(h.local.llmProviderConfig); assert.deepEqual(h.session, {}); }
  else { assert.equal(h.local.llmProviderConfig, undefined); assert.equal(h.session.llmApiKey, 'synthetic-key'); }
  await erase();
  onlyMarker();
});

test('fresh worker import resumes persisted deletion before key migration or collection', () => {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { privacyChrome } from './tests/helpers/privacy-chrome.mjs';
    const h = privacyChrome({ privacyMutationState: { epoch: 41, deleting: true },
      activeSession: { id: 'old', intent: 'secret', isActive: true, startTime: Date.now(), timeBudget: 10 },
      openaiApiKey: 'synthetic-legacy' }, { llmApiKey: 'synthetic-session' });
    globalThis.chrome = h.chrome;
    const worker = await import('./background.js');
    const result = await h.send({ type: 'CONFIG_UPDATED' });
    console.log(JSON.stringify({ local: h.local, session: h.session, calls: h.calls,
      state: worker.getInMemoryState().currentSession, result }));
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim());
  assert.deepEqual(result.local, { [marker]: { epoch: 41, deleting: false } });
  assert.deepEqual(result.session, {});
  assert.equal(result.state, null);
  assert.equal(result.calls.includes('alarm:create'), false);
});

test('sender allowlist rejects destructive and arbitrary mutations from content scripts', async () => {
  await a.mutateStorage('theme', { theme: 'light' });
  for (const sender of [
    { id: 'privacy-test', tab: { id: 7 }, url: 'https://example.test' },
    { id: 'other-extension', url: chrome.runtime.getURL('options.html') },
    { id: 'privacy-test', url: chrome.runtime.getURL('options.html.evil') }, {},
  ]) for (const type of ['DELETE_ALL_DATA', 'SESSION_CLEARED', 'SESSION_STARTED', 'END_ACTIVE_SESSION', 'STORAGE_MUTATION']) {
    const response = await h.send({ type, epoch: queue.getStorageGeneration(), command: 'theme', payload: { theme: 'dark' } }, sender);
    assert.equal(response.status, 'error');
    assert.equal(h.local.theme, 'light');
  }
  await assert.rejects(a.mutateStorage('theme', { theme: 'dark', activeSession: session('injected') }), /fields/);
  await assert.rejects(a.mutateStorage('set', { trackingEnabled: true }), /Unknown/);
  assert.equal(h.local.activeSession, undefined);
  await erase();
});

test('site policy authority preserves existing warn radio value', async () => {
  await a.mutateStorage('saveSites', { categoryPolicies: { social_media: 'warn' }, customBlockDomains: [], customAllowDomains: [] });
  assert.equal(h.local.heuristicPolicy.categoryPolicies.social_media, 'warn');
  await erase();
});

test('session payloads without their action epoch cannot mint a current epoch', async () => {
  const response = await h.send({ type: 'SESSION_STARTED', session: session('missing-epoch') });
  assert.equal(response.status, 'error');
  assert.equal(h.local.activeSession, undefined);
  await erase();
});

test('foreign extension cannot use content diagnostic route', async () => {
  const response = await h.send({ type: 'LOG_ERROR', payload: { message: 'injected' } },
    { id: 'foreign', tab: { id: 7 }, url: 'https://example.test' });
  assert.equal(response.status, 'error');
  assert.equal(h.local.errorLog, undefined);
});

test('provider configuration rejects arbitrary nested storage fields', async () => {
  await assert.rejects(a.mutateStorage('saveProvider', {
    config: { ...config, sessionHistory: ['injected'] },
  }), /fields/);
  assert.equal(h.local.llmProviderConfig, undefined);
});

test('reader pruning cannot write a snapshot taken before deletion', async () => {
  await a.mutateStorage('appendError', { entry: { message: 'synthetic', timestamp: Date.now() } });
  h.holdNext(op => op.method === 'get' && op.value?.includes('errorLog'));
  const reading = b.mutateStorage('readErrors');
  const rejected = assert.rejects(reading, /changed|deletion/);
  await until(() => h.isHeld);
  const deleting = erase();
  h.release();
  await Promise.all([rejected, deleting]);
  onlyMarker();
});

test('session start callback in flight cannot restore a session after fencing', async () => {
  h.holdNext(op => op.method === 'remove' && op.value?.includes('llmBackoffUntil'));
  const starting = a.sendStorageAction({ type: 'SESSION_STARTED', session: session('starting') });
  const rejected = assert.rejects(starting, /changed|deletion/);
  await until(() => h.isHeld);
  const deleting = erase();
  h.release();
  await Promise.all([rejected, deleting]);
  onlyMarker();
});

test('legitimate content LOG_ERROR remains supported and redacted', async () => {
  const response = await h.send({ type: 'LOG_ERROR', payload: {
    message: 'synthetic diagnostic', details: { apiKey: 'synthetic-secret' }, source: 'content',
  } }, { id: 'privacy-test', tab: { id: 7 }, url: 'https://example.test' });
  assert.equal(response.status, 'ok');
  assert.equal(h.local.errorLog.length, 1);
  assert.equal(h.local.errorLog[0].source, 'content');
  assert.equal(h.local.errorLog[0].details.apiKey, '[redacted]');
  await erase();
});

test('failed worker revival keeps the persisted deletion barrier active', () => {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { privacyChrome } from './tests/helpers/privacy-chrome.mjs';
    const h = privacyChrome({ privacyMutationState: { epoch: 57, deleting: true },
      openaiApiKey: 'synthetic-old' }, { llmApiKey: 'synthetic-session' });
    h.failNext(op => op.area === 'session' && op.method === 'clear');
    globalThis.chrome = h.chrome;
    await import('./background.js');
    const result = await h.send({ type: 'CONFIG_UPDATED' });
    console.log(JSON.stringify({ local: h.local, session: h.session, result }));
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim());
  assert.deepEqual(result.local, { [marker]: { epoch: 57, deleting: true } });
  assert.equal(result.session.llmApiKey, 'synthetic-session');
  assert.equal(result.result.status, 'error');
});

test('legacy key migration delayed read is fenced before it can restore credentials', async () => {
  h.local.openaiApiKey = 'synthetic-legacy';
  const { migrateKeys } = await import('../storage-authority.js');
  h.holdNext(op => op.area === 'session' && op.method === 'get');
  const migrating = migrateKeys(queue.getStorageGeneration());
  const rejected = assert.rejects(migrating, /changed|deletion/);
  await until(() => h.isHeld);
  const deleting = erase();
  h.release();
  await Promise.all([rejected, deleting]);
  onlyMarker();
});

test('failed start persistence does not expose an in-memory active session', async () => {
  h.failNext(op => op.area === 'local' && op.method === 'set' && op.value?.activeSession);
  await assert.rejects(a.sendStorageAction({ type: 'SESSION_STARTED', session: session('failed') }), /failure/);
  assert.equal(h.local.activeSession, undefined);
  assert.equal(worker.getInMemoryState().currentSession, null);
  const response = await h.send({ type: 'GET_SESSION' });
  assert.equal(response.session, null);
});

test('actual late marker read cannot bless a predeletion Settings payload', async () => {
  const get = chrome.storage.local.get;
  let releaseRead;
  chrome.storage.local.get = (keys, callback) => {
    if (keys?.includes(marker)) releaseRead = () => get(keys, callback);
    else get(keys, callback);
  };
  const epoch = a.captureStorageEpoch();
  const payload = { config, key: 'predeletion-key' };
  chrome.storage.local.get = get;
  await erase();
  releaseRead?.(); // Read the NEW marker now, not an old invocation snapshot.
  await assert.rejects(a.mutateStorage('saveProvider', payload, epoch), /changed|deletion|ready/);
  onlyMarker();
});

test('delayed real provider failure cannot recreate deleted diagnostic data', async () => {
  await a.mutateStorage('saveProvider', { config });
  const { chatCompletion } = await import('../providers.js');
  const oldFetch = globalThis.fetch;
  let releaseResponse;
  globalThis.fetch = () => new Promise(resolve => { releaseResponse = resolve; });
  try {
    const pending = chatCompletion('synthetic prior intent');
    await until(() => Boolean(releaseResponse));
    await erase();
    onlyMarker();
    releaseResponse({ ok: false, status: 500, text: async () => JSON.stringify({
      error: { message: 'synthetic prior intent echoed' },
    }) });
    await pending;
    onlyMarker();
  } finally { globalThis.fetch = oldFetch; }
});

test('intervention read paused across deletion never returns deleted state', async () => {
  await a.sendStorageAction({ type: 'SESSION_STARTED', session: session('locked') });
  h.local.interventionStates = { 'locked:7': {
    sessionId: 'locked', originalTabId: 7, nonce: 'old-nonce', intent: 'deleted intent',
  } };
  h.holdNext(op => op.method === 'get' && op.value?.includes('interventionStates'));
  const reading = h.send({ type: 'GET_INTERVENTION_STATE' },
    { id: 'privacy-test', tab: { id: 7 }, url: 'https://example.test' });
  await until(() => h.isHeld);
  await erase();
  h.release();
  const response = await reading;
  assert.equal(response.state ?? null, null);
  assert.equal(response.ok, false);
  onlyMarker();
});

test('fallback GET_SESSION read paused across deletion never returns old session', async () => {
  h.local.activeSession = session('uncached');
  h.holdNext(op => op.method === 'get' && op.value?.includes('activeSession'));
  const reading = h.send({ type: 'GET_SESSION' });
  await until(() => h.isHeld);
  await erase();
  h.release();
  const response = await reading;
  assert.equal(response.session ?? null, null);
  onlyMarker();
});

test('failed initial marker persistence stays closed to idle writes and deletion retry recovers', () => {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { privacyChrome } from './tests/helpers/privacy-chrome.mjs';
    const h = privacyChrome();
    let idle;
    h.chrome.idle.onStateChanged = { addListener(fn) { idle = fn; } };
    h.failNext(op => op.method === 'set' && op.value?.privacyMutationState);
    globalThis.chrome = h.chrome;
    await import('./background.js');
    const queue = await import('./storage-queue.js');
    const failed = await h.send({ type: 'CONFIG_UPDATED' });
    const blocked = queue.isStorageDeletionActive();
    idle('idle');
    await queue.enqueueStorageMutation(() => {});
    const beforeRetry = structuredClone(h.local);
    const retry = await h.send({ type: 'DELETE_ALL_DATA' });
    const saved = await h.send({ type: 'STORAGE_MUTATION', command: 'theme',
      payload: { theme: 'dark' }, epoch: queue.getStorageGeneration() });
    console.log(JSON.stringify({ failed, blocked, beforeRetry, retry, saved, local: h.local }));
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.failed.status, 'error');
  assert.equal(result.blocked, true);
  assert.deepEqual(result.beforeRetry, {});
  assert.equal(result.retry.status, 'ok');
  assert.equal(result.saved.status, 'ok');
  assert.equal(result.local[marker].deleting, false);
  assert.equal(result.local.theme, 'dark');
});

test('plan work keeps its origin when a delayed config read spans deletion and new settings', async () => {
  await a.mutateStorage('saveProvider', { config });
  const { generateIntentPlan } = await import('../llm.js');
  h.holdNext(op => op.method === 'get' && op.value?.includes('llmProviderConfig'));
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, json: async () => ({ message: { content: '{"steps":["old plan"]}' } }) };
  };
  try {
    const pending = generateIntentPlan('synthetic deleted intent');
    await until(() => h.isHeld);
    await erase();
    await b.mutateStorage('saveProvider', { config });
    h.release();
    await pending;
    assert.equal(calls, 0, 'old plan must not be sent using the new settings epoch');
    assert.equal(h.local.errorLog, undefined);
    await erase();
  } finally { globalThis.fetch = oldFetch; }
});

for (const type of ['SESSION_STARTED', 'END_ACTIVE_SESSION']) {
  test(`successful ${type} reply delivered after deletion rejects the old action`, async () => {
    if (type === 'END_ACTIVE_SESSION') await a.sendStorageAction({ type: 'SESSION_STARTED', session: session('reply-race') });
    h.holdNextReply((message, response) => message.type === type && response?.status === 'ok');
    const pending = a.sendStorageAction(type === 'SESSION_STARTED'
      ? { type, session: session('reply-race') } : { type, sessionId: 'reply-race' });
    await until(() => h.isReplyHeld);
    if (type === 'SESSION_STARTED') assert.equal(h.local.activeSession.id, 'reply-race');
    else assert.equal(h.local.sessionHistory.at(-1).id, 'reply-race');
    await erase();
    onlyMarker();
    const rejected = assert.rejects(pending, /changed|deletion/);
    h.releaseReply();
    await rejected;
    onlyMarker();
  });
}
