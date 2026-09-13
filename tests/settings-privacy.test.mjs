import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { privacyChrome, until } from './helpers/privacy-chrome.mjs';
import { createOverlayDocument } from './helpers/overlay-dom.mjs';
import * as providers from '../providers.js';
import * as policy from '../heuristic-policy.js';
import * as logs from '../error-log.js';
import * as privacy from '../privacy-utils.js';
import * as client from '../storage-client.js';

const h = privacyChrome();
globalThis.chrome = h.chrome;
await import('../background.js');
await h.send({ type: 'CONFIG_UPDATED' });

async function loadSettings(client) {
  for (const area of ['local', 'session']) {
    const get = h.chrome.storage[area].get;
    h.chrome.storage[area].get = (keys, callback) => get(keys, data => queueMicrotask(() => callback(data)));
  }
  const { document } = createOverlayDocument();
  const source = await readFile(new URL('../options.js', import.meta.url), 'utf8');
  for (const [, id] of source.matchAll(/getElementById\('([^']+)'\)/g)) {
    if (document.getElementById(id)) continue;
    const el = document.createElement(id.includes('btn') ? 'button' : 'input');
    el.id = id; el.value = '';
    document.body.appendChild(el);
  }
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.documentElement.style.removeProperty = () => {};
  let onReady;
  document.addEventListener = (type, handler) => { if (type === 'DOMContentLoaded') onReady = handler; };
  const context = vm.createContext({
    ...providers, ...policy, ...logs, ...privacy, ...client, document, chrome: h.chrome,
    window: { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) },
    console, setTimeout: () => 0, clearTimeout() {},
  });
  vm.runInContext(source.replace(/^import[\s\S]*?;\n/gm, ''), context);
  await onReady();
  return document;
}

test('real Settings save cannot attach a late-read epoch to old config and key', async () => {
  const document = await loadSettings(client);
  await until(() => document.getElementById('provider-select').value !== '');
  document.getElementById('provider-select').value = 'ollama';
  document.getElementById('model-input').value = 'synthetic-old-model';
  document.getElementById('base-url-input').value = 'http://127.0.0.1:11434/api/chat';
  document.getElementById('api-key').value = 'synthetic-old-key';
  const get = chrome.storage.local.get;
  let releaseRead;
  chrome.storage.local.get = (keys, callback) => {
    if (keys?.includes('privacyMutationState')) releaseRead = () => get(keys, callback);
    else get(keys, callback);
  };
  const button = document.getElementById('save-provider-btn');
  button.click();
  chrome.storage.local.get = get;
  const deleted = await h.send({ type: 'DELETE_ALL_DATA' });
  assert.equal(deleted.status, 'ok');
  releaseRead?.();
  await until(() => button.disabled === false);
  assert.equal(h.local.llmProviderConfig, undefined);
  assert.equal(h.session.llmApiKey, undefined);
  assert.deepEqual(Object.keys(h.local), ['privacyMutationState']);
});

test('a newly opened Settings page retains deletion retry while its client is blocked', async () => {
  h.session.llmApiKey = 'synthetic-leftover';
  h.failNext(op => op.area === 'session' && op.method === 'clear');
  const failure = await h.send({ type: 'DELETE_ALL_DATA' });
  assert.equal(failure.status, 'error');
  const retryClient = await import('../storage-client.js?new-retry-page');
  const document = await loadSettings(retryClient);
  const button = document.getElementById('delete-data-btn');
  button.click();
  button.click();
  await until(() => h.local.privacyMutationState.deleting === false);
  assert.equal(h.session.llmApiKey, undefined);
  assert.equal(document.getElementById('data-status').textContent, 'All data deleted.');
});
