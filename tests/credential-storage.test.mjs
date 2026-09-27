import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { privacyChrome } from './helpers/privacy-chrome.mjs';

const h = privacyChrome();
globalThis.chrome = h.chrome;
const worker = await import('../background.js');
const queue = await import('../storage-queue.js');
const authority = await import('../storage-authority.js');
await queue.enqueueStorageMutation(() => {});
await worker.reloadConfig();
const client = await import('../storage-client.js');
await client.initializeStorageClient();

const openai = { providerId: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1/chat/completions' };

function runIsolated(script) {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

test('saved key is written only to session storage', async () => {
  await client.mutateStorage('saveProvider', { config: openai, key: 'sk-synthetic-session' });
  assert.equal(h.session.llmApiKey, 'sk-synthetic-session');
  assert.equal(h.local.llmApiKey, undefined);
  assert.equal(h.local.openaiApiKey, undefined);
  assert.equal(JSON.stringify(h.local).includes('sk-synthetic-session'), false);
});

test('explicit key removal clears every legacy alias in both areas', async () => {
  h.session.llmApiKey = 'sk-synthetic-a';
  h.session.openaiApiKey = 'sk-synthetic-b';
  h.local.llmApiKey = 'sk-synthetic-c';
  h.local.openaiApiKey = 'sk-synthetic-d';
  await client.mutateStorage('clearKey', {});
  for (const area of [h.session, h.local]) {
    assert.equal(area.llmApiKey, undefined);
    assert.equal(area.openaiApiKey, undefined);
  }
});

test('migration moves a session-only legacy alias without losing it', async () => {
  h.session.openaiApiKey = 'sk-synthetic-legacy-session';
  await authority.migrateKeys(queue.getStorageGeneration());
  assert.equal(h.session.llmApiKey, 'sk-synthetic-legacy-session');
  assert.equal(h.session.openaiApiKey, undefined);
  await client.mutateStorage('clearKey', {});
});

test('migration keeps the local source when the canonical write fails', async () => {
  h.local.openaiApiKey = 'sk-synthetic-local-legacy';
  h.failNext(op => op.area === 'session' && op.method === 'set');
  await assert.rejects(authority.migrateKeys(queue.getStorageGeneration()), /synthetic session set failure/);
  assert.equal(h.local.openaiApiKey, 'sk-synthetic-local-legacy');
  assert.equal(h.session.llmApiKey, undefined);
  await authority.migrateKeys(queue.getStorageGeneration());
  assert.equal(h.session.llmApiKey, 'sk-synthetic-local-legacy');
  assert.equal(h.local.openaiApiKey, undefined);
  await client.mutateStorage('clearKey', {});
});

test('a replacement saved during migration is not overwritten by a legacy alias', async () => {
  h.local.openaiApiKey = 'sk-synthetic-older';
  const save = client.mutateStorage('saveProvider', { config: openai, key: 'sk-synthetic-newer' });
  const migrate = authority.migrateKeys(queue.getStorageGeneration());
  await Promise.all([save, migrate]);
  assert.equal(h.session.llmApiKey, 'sk-synthetic-newer');
  assert.equal(h.local.openaiApiKey, undefined);
  await client.mutateStorage('clearKey', {});
});

test('without session storage a key cannot be saved and legacy local keys are dropped', () => {
  const result = runIsolated(`
    import { privacyChrome } from './tests/helpers/privacy-chrome.mjs';
    const h = privacyChrome({ openaiApiKey: 'sk-synthetic-local-only' });
    delete h.chrome.storage.session;
    globalThis.chrome = h.chrome;
    await import('./background.js');
    await h.send({ type: 'CONFIG_UPDATED' });
    const marker = h.local.privacyMutationState;
    const saved = await h.send({ type: 'STORAGE_MUTATION', command: 'saveProvider', epoch: marker.epoch,
      payload: { config: { providerId: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1/chat/completions' }, key: 'sk-synthetic-new' } });
    const { getLlmConfig } = await import('./providers.js');
    const config = await getLlmConfig();
    console.log(JSON.stringify({ saved, local: h.local, apiKey: config.apiKey }));
  `);
  assert.equal(result.saved.status, 'error');
  assert.match(result.saved.message, /Session storage is unavailable/);
  assert.equal(result.local.openaiApiKey, undefined);
  assert.equal(result.local.llmApiKey, undefined);
  assert.equal(JSON.stringify(result.local).includes('sk-synthetic'), false);
  assert.equal(result.apiKey, null);
});
