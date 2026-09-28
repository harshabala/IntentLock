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

test('session events store origins only, with the path keyword verdict precomputed', async () => {
  await client.sendStorageAction({ type: 'SESSION_STARTED', session: {
    id: 'origins', intent: 'quarterly budget memo', startTime: Date.now(), isActive: true, events: [],
  } });
  const secret = 'https://docs.example/budget/q3?token=synthetic-secret#frag';
  await h.send({ type: 'CONTENT_EVENT', payload: {
    actionType: 'SPA_NAVIGATION', url: secret, previousUrl: secret,
    navigationUrl: 'https://docs.example/other/private-path', dwellMs: 1000, dwellDeltaMs: 1000,
  } }, { id: 'privacy-test', tab: { id: 7 }, url: secret });
  await queue.enqueueStorageMutation(() => {});
  const event = h.local.activeSession.events.at(-1);
  assert.equal(event.url, 'https://docs.example');
  assert.equal(event.previousUrl, 'https://docs.example');
  assert.equal(event.navigationUrl, 'https://docs.example');
  assert.equal(event.intentMatch, true, 'the path mentioned "budget" before it was dropped');
  const stored = JSON.stringify(h.local.activeSession);
  for (const fragment of ['/budget/', 'synthetic-secret', 'private-path', 'frag']) {
    assert.equal(stored.includes(fragment), false, fragment);
  }
});

test('the evaluator uses stored keyword verdicts and per-origin dwell', async () => {
  const { buildDefaultPolicy, evaluatePolicyDrift, minimizeSessionEvent } = await import('../heuristic-policy.js');
  const intent = 'quarterly budget memo';
  const policy = buildDefaultPolicy('deep_work', 'balanced');
  const now = 1_000_000;
  const related = [0, 1, 2].map(i => minimizeSessionEvent({ actionType: 'PAGE_LOAD', timestamp: now - i * 1000,
    url: `https://unknown.example/budget/${i}` }, intent));
  assert.ok(related.every(e => e.url === 'https://unknown.example' && e.intentMatch === true));
  const aligned = evaluatePolicyDrift({ intent, policy, now, events: related, url: 'https://unknown.example/budget/3' });
  assert.equal(aligned.signals.some(s => s.startsWith('unrelated_events')), false);
  const dwell = [0, 1, 2, 3].map(i => minimizeSessionEvent({ actionType: 'PAGE_DWELL', timestamp: now - i * 30_000,
    url: `https://unrelated.example/page-${i}`, dwellMs: 30_000, dwellDeltaMs: 30_000 }, intent));
  const drift = evaluatePolicyDrift({ intent, policy, now, events: dwell, url: 'https://unrelated.example/page-9' });
  assert.equal(drift.reason, 'extended_unrelated_dwell');
});
