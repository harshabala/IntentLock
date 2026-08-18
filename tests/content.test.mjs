import assert from 'node:assert/strict';
import test from 'node:test';
import { createClassicContext, runClassicScript } from './helpers/load-classic-script.mjs';

test('failed final flushes are retried so later dwell can be persisted', async () => {
  const listeners = [];
  const contentEvents = [];
  let trackerOptions;
  let flushAttempts = 0;

  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        if (message.type === 'GET_INTERVENTION_STATE') {
          callback({ ok: false });
          return;
        }
        if (message.type === 'CONTENT_EVENT') {
          contentEvents.push(message.payload);
          callback({
            status: 'ok',
            persisted: true,
            sessionId: message.payload.sessionId,
            generation: message.payload.generation,
            requestId: message.payload.flushRequestId,
          });
        }
      },
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        },
      },
    },
    storage: {
      local: {
        get(_keys, callback) {
          callback({
            activeSession: { isActive: true },
            trackingEnabled: true,
          });
        },
      },
      onChanged: {
        addListener() {},
      },
    },
  };

  const tracker = {
    start() {},
    stop() {},
    flush(extra) {
      flushAttempts += 1;
      if (flushAttempts === 1) return Promise.reject(new Error('temporary flush failure'));
      return trackerOptions.onReport({
        actionType: 'PAGE_DWELL',
        url: 'https://docs.example.com/later',
        dwellMs: 9_000,
        dwellDeltaMs: 4_000,
        sessionId: extra.sessionId,
        generation: extra.generation,
        flushRequestId: extra.flushRequestId,
      });
    },
  };

  const context = createClassicContext({
    chrome,
    IntentLock: {
      pageTracker: {
        createPageTracker(options) {
          trackerOptions = options;
          return tracker;
        },
      },
      interventionOverlay: {
        createInterventionOverlay() {
          return { hide() {}, show() {}, setError() {} };
        },
      },
    },
    document: { hidden: false, title: 'Example' },
    window: {},
    history: {},
    location: { href: 'https://docs.example.com/later' },
    setInterval() { return 1; },
    clearInterval() {},
  });
  await runClassicScript(new URL('../content.js', import.meta.url), context);

  const listener = listeners.at(-1);
  const sendFlush = (requestId) => new Promise((resolve) => {
    assert.equal(listener({
      type: 'FLUSH_DWELL',
      sessionId: 'session-1',
      generation: 3,
      requestId,
    }, {}, resolve), true);
  });

  const first = await sendFlush('session-1:tab-1');
  const second = await sendFlush('session-1:tab-1');

  assert.equal(first.status, 'error');
  assert.equal(second.status, 'ok');
  assert.equal(second.persisted, true);
  assert.equal(flushAttempts, 2);
  assert.equal(contentEvents.length, 1);
  assert.equal(contentEvents[0].dwellDeltaMs, 4_000);
});
