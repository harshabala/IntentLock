import assert from 'node:assert/strict';
import test from 'node:test';
import { privacyChrome } from './helpers/privacy-chrome.mjs';

const h = privacyChrome();
globalThis.chrome = h.chrome;
const worker = await import('../background.js');
const queue = await import('../storage-queue.js');
await queue.enqueueStorageMutation(() => {});
await worker.reloadConfig();
const client = await import('../storage-client.js');
await client.initializeStorageClient();

test('content events never persist page titles', async () => {
  await client.sendStorageAction({ type: 'SESSION_STARTED', session: {
    id: 'titles', intent: 'synthetic work', startTime: Date.now(), isActive: true, events: [],
  } });
  const url = 'https://mail.example/inbox';
  await h.send({ type: 'CONTENT_EVENT', payload: {
    actionType: 'PAGE_DWELL', url, pageTitle: 'Synthetic private subject', dwellMs: 30_000, dwellDeltaMs: 30_000,
  } }, { id: 'privacy-test', tab: { id: 7 }, url });
  await queue.enqueueStorageMutation(() => {});
  const events = h.local.activeSession.events;
  assert.equal(events.at(-1).actionType, 'PAGE_DWELL');
  assert.equal(JSON.stringify(h.local).includes('Synthetic private subject'), false);
});
