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
        flushCorrelationId: extra.flushCorrelationId,
        reportId: 'report-later',
      }).then((result) => ({ receiptId: result.response.requestId }));
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
  assert.equal(second.receiptId, 'report-later');
  assert.equal(flushAttempts, 2);
  assert.equal(contentEvents.length, 1);
  assert.equal(contentEvents[0].dwellDeltaMs, 4_000);
});

test('content tracking is recreated and stale reports are rejected at a session boundary', async () => {
  const storageChangedListeners = [];
  const runtimeMessageListeners = [];
  const trackers = [];
  const contentEvents = [];
  let activeSession = { id: 'session-one', generation: 7, isActive: true };

  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        if (message.type === 'CONTENT_EVENT') {
          contentEvents.push(message.payload);
          callback({
            status: 'ok',
            persisted: true,
            sessionId: message.payload.sessionId,
            generation: message.payload.generation,
            requestId: message.payload.flushRequestId,
          });
          return;
        }
        callback({ ok: false });
      },
      onMessage: {
        addListener(listener) {
          runtimeMessageListeners.push(listener);
        },
      },
    },
    storage: {
      local: {
        get(_keys, callback) {
          callback({ activeSession, trackingEnabled: true });
        },
      },
      onChanged: {
        addListener(listener) {
          storageChangedListeners.push(listener);
        },
      },
    },
  };

  const context = createClassicContext({
    chrome,
    IntentLock: {
      pageTracker: {
        createPageTracker(options) {
          const tracker = {
            options,
            starts: 0,
            stops: [],
            start() {
              this.starts += 1;
            },
            stop(settings) {
              this.stops.push(settings);
            },
          };
          trackers.push(tracker);
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
    location: { href: 'https://docs.example.com/session-boundary' },
  });
  await runClassicScript(new URL('../content.js', import.meta.url), context);

  assert.equal(trackers.length, 1);
  const firstTracker = trackers[0];
  const previousSession = activeSession;
  activeSession = { id: 'session-two', generation: 7, isActive: true };
  storageChangedListeners[0]({
    activeSession: { oldValue: previousSession, newValue: activeSession },
  }, 'local');

  assert.equal(trackers.length, 2);
  assert.equal(firstTracker.stops.length, 1);
  assert.equal(firstTracker.stops[0].discard, true);
  assert.equal(trackers[1].starts, 1);
  await assert.rejects(
    firstTracker.options.onReport({
      actionType: 'PAGE_DWELL',
      url: 'https://docs.example.com/session-boundary',
      dwellMs: 8_000,
      dwellDeltaMs: 8_000,
    }),
    /stale/i,
  );
  assert.equal(contentEvents.length, 0);
  assert.equal(runtimeMessageListeners.length, 1);

  runtimeMessageListeners[0]({ type: 'DATA_DELETION_STARTED', generation: 7 });
  assert.equal(trackers[1].stops.at(-1).discard, true);
  assert.equal(trackers[1].stops.at(-1).reportFinal, false);
  const trackerCountDuringDeletion = trackers.length;
  runtimeMessageListeners[0]({ type: 'DATA_DELETION_FAILED', generation: 6 });
  assert.equal(trackers.length, trackerCountDuringDeletion);
});

test('tracking opt-out invalidates a delayed session sync before restarting tracking', async () => {
  const storageChangedListeners = [];
  const runtimeMessageListeners = [];
  const trackers = [];
  const pendingReads = [];
  let delayReads = false;
  let activeSession = { id: 'session-one', generation: 7, isActive: true };

  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(_message, callback) {
        callback?.({ ok: false });
      },
      onMessage: {
        addListener(listener) {
          runtimeMessageListeners.push(listener);
        },
      },
    },
    storage: {
      local: {
        get(_keys, callback) {
          if (delayReads) {
            pendingReads.push(() => callback({ activeSession, trackingEnabled: true }));
            return;
          }
          callback({ activeSession, trackingEnabled: true });
        },
      },
      onChanged: {
        addListener(listener) {
          storageChangedListeners.push(listener);
        },
      },
    },
  };

  const context = createClassicContext({
    chrome,
    IntentLock: {
      pageTracker: {
        createPageTracker(options) {
          const tracker = {
            options,
            stops: [],
            start() {},
            stop(settings) {
              this.stops.push(settings);
            },
          };
          trackers.push(tracker);
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
    location: { href: 'https://docs.example.com/opt-out-race' },
  });
  await runClassicScript(new URL('../content.js', import.meta.url), context);

  assert.equal(trackers.length, 1);
  delayReads = true;
  activeSession = { id: 'session-two', generation: 7, isActive: true };
  storageChangedListeners[0]({
    activeSession: { oldValue: { id: 'session-one' }, newValue: activeSession },
  }, 'local');
  assert.equal(pendingReads.length, 1);

  storageChangedListeners[0]({
    trackingEnabled: { oldValue: true, newValue: false },
  }, 'local');
  assert.equal(trackers[0].stops.at(-1).discard, true);
  assert.equal(trackers.length, 1);

  pendingReads.shift()();
  assert.equal(trackers.length, 1);
  assert.equal(runtimeMessageListeners.length, 1);
});
