import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDefaultPolicy } from '../heuristic-policy.js';
import { beginStorageDeletion, endStorageDeletion, getStorageGeneration } from '../storage-queue.js';

// Setup global mock for Chrome APIs
let sessionStorageData = {};
let storageErrorMessage = null;
let storageGetErrorMessage = null;
let storageRemoveErrorMessage = null;
let storageSetFailures = 0;
let tabsCreateCount = 0;
const tabUrls = new Map();
let trackedTabs = [];
const finalDwellPayloads = new Map();
const flushBehaviors = new Map();
let tabsQueryBehavior = 'normal';
let onTabsQueryStarted = null;
let flushAttempts = 0;
let storageData = {
  openaiApiKey: 'test-migration-key',
  activeSession: { id: 'session-123', intent: 'work', isActive: true, startTime: Date.now() },
  trackingEnabled: false,
  customDistractionSites: ['only-one-site.com'],
  sessionTabGroupId: 456,
  isCurrentlyIdle: true,
  lastIdleTime: 9999,
  overrideCooldowns: [['cooldown-site.com', 99999]]
};

let messageListener = null;
let idleStateChangedListener = null;
let commandListener = null;
let alarmListener = null;
let tabUpdatedListener = null;
let tabActivatedListener = null;

globalThis.chrome = {
  idle: {
    setDetectionInterval: () => {},
    onStateChanged: { addListener: (listener) => { idleStateChangedListener = listener; } }
  },
  commands: {
    onCommand: { addListener: (listener) => { commandListener = listener; } }
  },
  runtime: {
    onMessage: { addListener: (fn) => { messageListener = fn; } },
    getURL: (path) => `chrome-extension://mock/${path}`,
    lastError: null,
  },
  alarms: {
    create: () => {},
    clear: () => {},
    onAlarm: { addListener: (listener) => { alarmListener = listener; } }
  },
  tabs: {
    query: (_query, callback) => {
      onTabsQueryStarted?.();
      if (tabsQueryBehavior === 'timeout') return;
      if (tabsQueryBehavior === 'delayed') {
        setTimeout(() => callback?.(trackedTabs), 25);
        return;
      }
      callback?.(trackedTabs);
      return Promise.resolve(trackedTabs);
    },
    create: () => { tabsCreateCount += 1; },
    get: (tabId, callback) => {
      callback?.({ id: tabId, url: tabUrls.get(tabId) || 'https://example.com' });
    },
    sendMessage: (tabId, message, callback) => {
      if (message?.type === 'FLUSH_DWELL') flushAttempts += 1;
      if (message?.type === 'FLUSH_DWELL' && flushBehaviors.get(tabId) === 'timeout') {
        return;
      }
      if (message?.type === 'FLUSH_DWELL' && flushBehaviors.get(tabId) === 'inactive') {
        callback?.({
          status: 'error',
          persisted: false,
          sessionId: message.sessionId,
          generation: message.generation,
          requestId: message.requestId,
          message: 'Page tracking is not active.',
        });
        return;
      }
      if (message?.type === 'FLUSH_DWELL' && flushBehaviors.get(tabId) === 'empty') {
        callback?.();
        return;
      }
      if (message?.type === 'FLUSH_DWELL' && flushBehaviors.get(tabId) === 'closed') {
        chrome.runtime.lastError = { message: 'The message port closed before a response was received.' };
        callback?.();
        chrome.runtime.lastError = null;
        return;
      }
      if (message?.type === 'FLUSH_DWELL' && flushBehaviors.get(tabId) === 'reject') {
        callback?.({
          status: 'error',
          persisted: false,
          sessionId: message.sessionId,
          generation: message.generation,
          requestId: message.requestId,
        });
        return;
      }
      if (message?.type === 'FLUSH_DWELL' && finalDwellPayloads.has(tabId) && messageListener) {
        const payload = {
          ...finalDwellPayloads.get(tabId),
          sessionId: message.sessionId,
          generation: message.generation,
          flushRequestId: message.requestId,
        };
        messageListener(
          { type: 'CONTENT_EVENT', payload },
          { tab: { id: tabId } },
          (response) => callback?.(response),
        );
        return;
      }
      callback?.(message?.type === 'SHOW_INTERVENTION' ? { shown: true } : {});
    },
    update: (tabId, properties, callback) => {
      if (properties?.url) tabUrls.set(tabId, properties.url);
      callback?.({ id: tabId, url: tabUrls.get(tabId) });
    },
    remove: (_tabId, callback) => callback?.(),
    onUpdated: { addListener: (listener) => { tabUpdatedListener = listener; } },
    onActivated: { addListener: (listener) => { tabActivatedListener = listener; } }
  },
  storage: {
    session: {
      get: (keys, callback) => {
        const res = {};
        const keysArr = Array.isArray(keys) ? keys : [keys];
        for (const key of keysArr) {
          if (sessionStorageData[key] !== undefined) {
            res[key] = sessionStorageData[key];
          }
        }
        callback(res);
      },
      set: (data, callback) => {
        Object.assign(sessionStorageData, data);
        if (callback) callback();
      },
      remove: (keys, callback) => {
        const keysArr = Array.isArray(keys) ? keys : [keys];
        for (const k of keysArr) {
          delete sessionStorageData[k];
        }
        if (callback) callback();
      },
      clear: (callback) => {
        sessionStorageData = {};
        if (callback) callback();
      },
    },
    local: {
      get: (keys, callback) => {
        if (storageGetErrorMessage) {
          chrome.runtime.lastError = { message: storageGetErrorMessage };
          callback({});
          chrome.runtime.lastError = null;
          return;
        }
        const res = {};
        for (const key of keys) {
          if (storageData[key] !== undefined) {
            res[key] = storageData[key];
          }
        }
        callback(res);
      },
      set: (data, callback) => {
        if (storageSetFailures > 0) {
          storageSetFailures -= 1;
          chrome.runtime.lastError = { message: 'one-sided storage write failed' };
          if (callback) callback();
          chrome.runtime.lastError = null;
          return;
        }
        if (storageErrorMessage) {
          chrome.runtime.lastError = { message: storageErrorMessage };
          if (callback) callback();
          chrome.runtime.lastError = null;
          return;
        }
        Object.assign(storageData, data);
        if (callback) callback();
      },
      remove: (keys, callback) => {
        const keysArr = Array.isArray(keys) ? keys : [keys];
        if (storageRemoveErrorMessage && keysArr.includes('sessionTabGroupId')) {
          chrome.runtime.lastError = { message: storageRemoveErrorMessage };
          if (callback) callback();
          chrome.runtime.lastError = null;
          return;
        }
        for (const k of keysArr) {
          delete storageData[k];
        }
        if (callback) callback();
      },
      clear: (callback) => {
        storageData = {};
        if (callback) callback();
      },
    },
    onChanged: { addListener: () => {} }
  }
};

// Import background.js to execute its loadConfig
const {
  getInMemoryState,
  reloadConfig,
  createHistoryEntry,
  triggerIntervention,
} = await import('../background.js');

function requestMessage(message, sender = {}, timeoutMs = 100) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (response) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    messageListener(message, sender, finish);
    setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
  });
}

function makeSession(id, intent = id) {
  return {
    id,
    intent,
    startTime: Date.now(),
    timeBudget: null,
    isActive: true,
    events: [],
  };
}

function waitForCallbacks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('loadConfig resets in-memory variables to defaults when storage is cleared', async () => {
  // Verify initially loaded values (non-defaults)
  const initial = getInMemoryState();
  assert.equal(initial.currentSession?.id, 'session-123');
  assert.equal(initial.trackingEnabled, false);
  assert.deepEqual(initial.customDistractionSites, ['only-one-site.com']);
  assert.equal(initial.sessionTabGroupId, 456);
  assert.equal(initial.isCurrentlyIdle, true);
  assert.equal(initial.lastIdleTime, 9999);
  assert.equal(initial.overrideCooldowns.get('cooldown-site.com'), 99999);

  // Clear storage data completely
  storageData = {};

  // Trigger config reload
  await reloadConfig();

  // Retrieve new in-memory state
  const reset = getInMemoryState();

  // Assert default values
  assert.equal(reset.currentSession, null, 'currentSession should be reset to null');
  assert.equal(reset.trackingEnabled, true, 'trackingEnabled should be reset to true');
  assert.deepEqual(
    reset.customDistractionSites,
    [
      'twitter.com', 'x.com', 'facebook.com', 'reddit.com',
      'instagram.com', 'youtube.com', 'netflix.com', 'tiktok.com'
    ],
    'customDistractionSites should be reset to default sites list'
  );
  assert.equal(reset.sessionTabGroupId, null, 'sessionTabGroupId should be reset to null');
  assert.equal(reset.isCurrentlyIdle, false, 'isCurrentlyIdle should be reset to false');
  assert.equal(reset.lastIdleTime, 0, 'lastIdleTime should be reset to 0');
  assert.equal(reset.overrideCooldowns.size, 0, 'overrideCooldowns map should be cleared');
});

test('migrateLlmStorage migrates legacy key to llmApiKey in session storage on load', () => {
  assert.equal(sessionStorageData.llmApiKey, 'test-migration-key');
  assert.equal(sessionStorageData.openaiApiKey, undefined);
  assert.equal(storageData.openaiApiKey, undefined);
});

test('createHistoryEntry includes overrides array with reflection text', () => {
  const session = {
    id: 'abc123',
    intent: 'write report',
    startTime: 1000,
    endTime: 2000,
    timeBudget: null,
    events: [
      { actionType: 'PAGE_LOAD', url: 'https://github.com', timestamp: 1100 },
      { actionType: 'OVERRIDE', url: 'https://reddit.com', timestamp: 1200, reflection: 'needed a break' },
      { actionType: 'OVERRIDE', url: 'https://twitter.com', timestamp: 1300, reflection: null },
    ],
  };
  const entry = createHistoryEntry(session);
  assert.equal(entry.driftCount, 2);
  assert.ok(Array.isArray(entry.overrides), 'overrides should be an array');
  assert.equal(entry.overrides.length, 2);
  // Privacy: history stores hostname only (not full URL)
  assert.equal(entry.overrides[0].hostname, 'reddit.com');
  assert.equal(entry.overrides[0].reflection, 'needed a break');
  assert.equal(entry.overrides[1].hostname, 'twitter.com');
  assert.equal(entry.overrides[1].reflection, null);
  assert.equal(entry.reportViewed, false);
  assert.ok('onIntentRatio' in entry);
});

test('SESSION_CLEARED message resets background in-memory variables and clears LLM backoff', async () => {
  assert.ok(messageListener, 'messageListener should be registered');

  const { setQuotaBackoff, isLlmBackedOff } = await import('../llm-backoff.js');
  setQuotaBackoff({ retryAfterMs: 100000 });
  assert.ok(isLlmBackedOff(), 'LLM should be backed off initially');

  storageData.activeSession = { id: 'session-456', intent: 'code', isActive: true };
  storageData.overrideCooldowns = [['some-site.com', 8888]];
  await reloadConfig();

  const stateBefore = getInMemoryState();
  assert.equal(stateBefore.currentSession?.id, 'session-456');

  storageData = {};

  let response = null;
  await new Promise((resolve) => {
    messageListener({ type: 'SESSION_CLEARED' }, {}, (res) => {
      response = res;
      resolve();
    });
  });

  assert.deepEqual(response, { status: 'ok' });

  const stateAfter = getInMemoryState();
  assert.equal(stateAfter.currentSession, null);
  assert.equal(stateAfter.overrideCooldowns.size, 0);
  assert.equal(isLlmBackedOff(), false, 'LLM backoff should be cleared');
});

test('SESSION_STARTED rejects a session while tracking is disabled', async () => {
  storageData = { trackingEnabled: false };
  await reloadConfig();

  const response = await requestMessage({
    type: 'SESSION_STARTED',
    session: makeSession('disabled-session'),
  });

  assert.equal(response.status, 'error');
  assert.match(response.message, /tracking is disabled/i);
  assert.equal(storageData.activeSession, undefined);
});

test('concurrent SESSION_STARTED messages keep the first active session authoritative', async () => {
  storageData = { trackingEnabled: true };
  await reloadConfig();

  const firstRequest = requestMessage({ type: 'SESSION_STARTED', session: makeSession('first-session') });
  const secondRequest = requestMessage({ type: 'SESSION_STARTED', session: makeSession('second-session') });
  const [firstResponse, secondResponse] = await Promise.all([firstRequest, secondRequest]);

  assert.equal(firstResponse.status, 'ok');
  assert.equal(secondResponse.status, 'error');
  assert.match(secondResponse.message, /active session/i);
  assert.equal(storageData.activeSession.id, 'first-session');
});

test('SESSION_STARTED reports deletion cancellation when it races with data deletion', async () => {
  storageData = { trackingEnabled: true };
  await reloadConfig();

  const startRequest = requestMessage({
    type: 'SESSION_STARTED',
    session: makeSession('racing-session'),
  });
  const deletionRequest = requestMessage({ type: 'DELETE_ALL_DATA' });
  const [startResponse, deletionResponse] = await Promise.all([startRequest, deletionRequest]);

  assert.equal(deletionResponse.status, 'ok');
  assert.equal(startResponse.status, 'error');
  assert.equal(startResponse.code, 'SESSION_MUTATION_CANCELLED');
  assert.match(startResponse.message, /cancel|delet/i);
  assert.equal(storageData.activeSession, undefined);
});

test('SESSION_STARTED propagates storage read failures without overwriting the active session', async () => {
  storageData = { trackingEnabled: true, activeSession: makeSession('existing-session') };
  await reloadConfig();
  storageGetErrorMessage = 'storage read failed';

  const response = await requestMessage({
    type: 'SESSION_STARTED',
    session: makeSession('replacement-session'),
  });

  storageGetErrorMessage = null;
  assert.equal(response.status, 'error');
  assert.match(response.message, /storage read failed/i);
  assert.equal(storageData.activeSession.id, 'existing-session');
});

test('lifecycle event callbacks handle storage read failures without acting on empty results', async () => {
  storageData = { trackingEnabled: true, activeSession: makeSession('event-failure-session') };
  await reloadConfig();
  storageGetErrorMessage = 'event storage read failed';
  tabsCreateCount = 0;
  const loggedErrors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => loggedErrors.push(args.join(' '));

  try {
    idleStateChangedListener('idle');
    commandListener('toggle-session');
    alarmListener({ name: 'intentlock-budget-alarm' });
    tabUpdatedListener(1, { status: 'complete' }, { url: 'https://example.com' });
    tabActivatedListener({ tabId: 1 });
    await waitForCallbacks();
  } finally {
    console.error = originalConsoleError;
    storageGetErrorMessage = null;
  }

  assert.equal(tabsCreateCount, 0);
  assert.equal(storageData.activeSession.isActive, true);
  assert.equal(storageData.isCurrentlyIdle, undefined);
  assert.equal(loggedErrors.length, 5);
  assert.match(loggedErrors.join('\n'), /Idle state storage read failed/);
  assert.match(loggedErrors.join('\n'), /Toggle session storage read failed/);
  assert.match(loggedErrors.join('\n'), /Alarm storage read failed/);
  assert.match(loggedErrors.join('\n'), /Tab update storage read failed/);
  assert.match(loggedErrors.join('\n'), /Tab activation storage read failed/);
});

test('delayed override cannot resurrect cleared session data', async () => {
  const session = makeSession('override-race-session');
  storageData = { trackingEnabled: true, activeSession: session };
  await reloadConfig();

  const overrideRequest = requestMessage({
    type: 'OVERRIDE_INTERVENTION',
    sessionData: { ...session, events: [{ actionType: 'OVERRIDE', url: 'https://example.com' }] },
  });
  const deletionRequest = requestMessage({ type: 'DELETE_ALL_DATA' });
  const [overrideResponse, deletionResponse] = await Promise.all([overrideRequest, deletionRequest]);

  assert.equal(deletionResponse.status, 'ok');
  assert.equal(overrideResponse.status, 'error');
  assert.equal(overrideResponse.code, 'SESSION_MUTATION_CANCELLED');
  assert.equal(storageData.activeSession, undefined);
});

test('delayed content event cannot resurrect cleared session data', async () => {
  storageData = { trackingEnabled: true, activeSession: makeSession('content-race-session') };
  await reloadConfig();

  const contentRequest = requestMessage({
    type: 'CONTENT_EVENT',
    payload: { actionType: 'PAGE_LOAD', url: 'https://example.com/after-delete' },
  }, { tab: { id: 9 } });
  const deletionRequest = requestMessage({ type: 'DELETE_ALL_DATA' });
  const [contentResponse, deletionResponse] = await Promise.all([contentRequest, deletionRequest]);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(contentResponse, { status: 'ok' });
  assert.equal(deletionResponse.status, 'ok');
  assert.equal(storageData.activeSession, undefined);
});

test('config read failures do not poison the next message-triggered reload', async () => {
  storageData = { trackingEnabled: true };
  storageGetErrorMessage = 'initial config read failed';
  await assert.rejects(reloadConfig(), /initial config read failed/i);

  storageGetErrorMessage = null;
  const response = await requestMessage({
    type: 'SESSION_STARTED',
    session: makeSession('retry-after-config-failure'),
  });

  assert.equal(response.status, 'ok');
  assert.equal(storageData.activeSession.id, 'retry-after-config-failure');
});

test('intent edits require the expected active session and cannot resurrect a stale session', async () => {
  storageData = { trackingEnabled: true, activeSession: makeSession('edit-session', 'old intent') };
  await reloadConfig();

  const updated = await requestMessage({
    type: 'UPDATE_SESSION_INTENT',
    sessionId: 'edit-session',
    intent: 'new intent',
  });

  assert.equal(updated.status, 'ok');
  assert.equal(storageData.activeSession.intent, 'new intent');

  storageData = { trackingEnabled: true };
  await reloadConfig();
  const stale = await requestMessage({
    type: 'UPDATE_SESSION_INTENT',
    sessionId: 'edit-session',
    intent: 'resurrected intent',
  });

  assert.equal(stale.status, 'error');
  assert.match(stale.message, /stale|active session/i);
  assert.equal(storageData.activeSession, undefined);
});

test('END_ACTIVE_SESSION returns an error when there is no active session', async () => {
  storageData = { trackingEnabled: true };
  await reloadConfig();

  const response = await requestMessage({
    type: 'END_ACTIVE_SESSION',
    sessionId: 'missing-session',
  });

  assert.equal(response.status, 'error');
  assert.match(response.message, /active session|already ended/i);
  assert.equal(response.session, undefined);
});

test('END_ACTIVE_SESSION returns an error when finalization storage fails', async () => {
  storageData = { trackingEnabled: true, activeSession: makeSession('failing-session') };
  await reloadConfig();
  storageErrorMessage = 'storage write failed';

  const response = await requestMessage({
    type: 'END_ACTIVE_SESSION',
    sessionId: 'failing-session',
  });

  storageErrorMessage = null;
  assert.equal(response.status, 'error');
  assert.match(response.message, /storage write failed/i);
  assert.equal(storageData.activeSession?.isActive, true);
});

test('END_ACTIVE_SESSION returns the completed report with a tab cleanup warning', async () => {
  storageData = {
    trackingEnabled: true,
    activeSession: makeSession('tab-cleanup-warning-session'),
    sessionTabGroupId: 321,
  };
  await reloadConfig();
  storageRemoveErrorMessage = 'tab group cleanup failed';

  const response = await requestMessage({
    type: 'END_ACTIVE_SESSION',
    sessionId: 'tab-cleanup-warning-session',
  });

  storageRemoveErrorMessage = null;
  assert.equal(response.status, 'ok');
  assert.equal(response.session.isActive, false);
  assert.match(response.session.cleanupWarning, /tab group cleanup failed/i);
  assert.equal(storageData.activeSession, undefined);
  assert.ok(Array.isArray(storageData.sessionHistory));
});

test('unsupported content URLs are not recorded as session events', async () => {
  storageData = { trackingEnabled: true, activeSession: makeSession('url-session') };
  await reloadConfig();

  const response = await requestMessage({
    type: 'CONTENT_EVENT',
    payload: {
      actionType: 'PAGE_LOAD',
      url: 'chrome://settings',
    },
  }, { tab: { id: 1 } });

  assert.deepEqual(response, { status: 'ok' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(storageData.activeSession.events, []);
});

test('HTTP and HTTPS content URLs are recorded as session events', async () => {
  storageData = { trackingEnabled: true, activeSession: makeSession('supported-url-session') };
  await reloadConfig();

  await requestMessage({
    type: 'CONTENT_EVENT',
    payload: { actionType: 'PAGE_LOAD', url: 'http://example.com/http' },
  }, { tab: { id: 1 } });
  await requestMessage({
    type: 'CONTENT_EVENT',
    payload: { actionType: 'PAGE_LOAD', url: 'https://example.com/https' },
  }, { tab: { id: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(
    storageData.activeSession.events.map((event) => event.url),
    ['http://example.com/http', 'https://example.com/https'],
  );
});

test('history overrides ignore unsupported URLs', () => {
  const entry = createHistoryEntry({
    id: 'url-history-session',
    intent: 'work',
    startTime: 1000,
    endTime: 2000,
    timeBudget: null,
    events: [
      { actionType: 'OVERRIDE', url: 'chrome://settings', reflection: 'not a web page' },
      { actionType: 'OVERRIDE', url: 'https://example.com', reflection: 'relevant' },
    ],
  });

  assert.equal(entry.driftCount, 1);
  assert.deepEqual(entry.overrides.map((override) => override.hostname), ['example.com']);
});

test('rehydrated intervention intent is enumerable in the runtime response', async () => {
  storageData = {
    trackingEnabled: true,
    activeSession: makeSession('rehydrated-intent-session', 'persisted intent'),
    interventionStates: {
      'rehydrated-intent-session:7': {
        sessionId: 'rehydrated-intent-session',
        nonce: 'rehydrated-nonce',
        reason: 'drift',
        originalTabId: 7,
        originalUrl: 'https://example.com/work',
        mode: 'overlay',
        timestamp: 1,
      },
    },
  };
  await reloadConfig();

  const response = await requestMessage(
    { type: 'GET_INTERVENTION_STATE' },
    { tab: { id: 7 } },
  );

  assert.equal(response.ok, true);
  assert.equal(response.state.intent, 'persisted intent');
  assert.equal(Object.keys(response.state).includes('intent'), true);
  assert.equal(JSON.parse(JSON.stringify(response.state)).intent, 'persisted intent');
});

test('session start drops unsupported event URLs before persistence', async () => {
  const unsupportedUrls = [
    'data:text/plain,unsupported',
    'blob:https://example.com/unsupported',
    'javascript:alert(1)',
    'ftp://example.com/unsupported',
    'chrome://settings',
  ];

  for (const [index, unsupportedUrl] of unsupportedUrls.entries()) {
    storageData = { trackingEnabled: true };
    await reloadConfig();
    const response = await requestMessage({
      type: 'SESSION_STARTED',
      session: {
        ...makeSession(`unsupported-session-${index}`),
        events: [
          { actionType: 'PAGE_LOAD', url: unsupportedUrl },
          { actionType: 'PAGE_LOAD', url: 'https://example.com/supported' },
        ],
      },
    });

    assert.equal(response.status, 'ok');
    assert.deepEqual(
      storageData.activeSession.events.map((event) => event.url),
      ['https://example.com/supported'],
      `unsupported URL should be dropped: ${unsupportedUrl}`,
    );
  }
});

test('restored active sessions drop unsupported event URLs before use and persistence', async () => {
  const unsupportedUrls = [
    'data:text/plain,unsupported',
    'blob:https://example.com/unsupported',
    'javascript:alert(1)',
    'ftp://example.com/unsupported',
    'chrome://settings',
  ];
  storageData = {
    trackingEnabled: true,
    activeSession: {
      ...makeSession('restored-events-session'),
      events: unsupportedUrls.map((url) => ({ actionType: 'PAGE_LOAD', url })),
    },
  };

  await reloadConfig();

  assert.deepEqual(getInMemoryState().currentSession.events, []);
  assert.deepEqual(storageData.activeSession.events, []);
});

test('PAGE_DWELL evaluates static pages after the dwell event is persisted', async () => {
  const url = 'https://reddit.com/r/programming';
  tabUrls.set(1, url);
  storageData = {
    trackingEnabled: true,
    heuristicPolicy: buildDefaultPolicy('coding', 'balanced'),
    activeSession: makeSession('static-dwell-session', 'coding the new feature'),
  };
  await reloadConfig();

  const response = await requestMessage({
    type: 'CONTENT_EVENT',
    payload: {
      actionType: 'PAGE_DWELL',
      url,
      dwellMs: 120_000,
      dwellDeltaMs: 120_000,
    },
  }, { tab: { id: 1 } });
  await waitForCallbacks();

  assert.deepEqual(response, { status: 'ok' });
  assert.equal(storageData.activeSession.metrics.activeMs, 120_000);
  assert.ok(storageData.interventionStates, 'static dwell should create an intervention');
});

test('normal content-event write failures are not acknowledged as success', async () => {
  const url = 'https://docs.example.com/normal-write-failure';
  storageData = {
    trackingEnabled: true,
    activeSession: makeSession('normal-write-failure-session', 'coding the new feature'),
  };
  await reloadConfig();
  storageErrorMessage = 'normal content write failed';

  const response = await requestMessage({
    type: 'CONTENT_EVENT',
    payload: {
      actionType: 'PAGE_DWELL',
      url,
      dwellMs: 5_000,
      dwellDeltaMs: 5_000,
    },
  }, { tab: { id: 1 } });

  storageErrorMessage = null;
  assert.equal(response.status, 'error');
  assert.match(response.message, /normal content write failed|persistence failed/i);
  assert.equal(storageData.activeSession.metrics, undefined);
});

test('normal dwell retries reuse a receipt after a one-sided metric write', async () => {
  const url = 'https://docs.example.com/normal-dwell-receipt';
  const sessionId = 'normal-dwell-receipt-session';
  const generation = getStorageGeneration();
  storageData = {
    trackingEnabled: true,
    activeSession: makeSession(sessionId, 'coding the new feature'),
  };
  await reloadConfig();
  storageSetFailures = 1;

  const payload = {
    actionType: 'PAGE_DWELL',
    url,
    dwellMs: 5_000,
    dwellDeltaMs: 5_000,
    sessionId,
    generation,
    reportId: 'normal-dwell-report-1',
  };
  const first = await requestMessage({ type: 'CONTENT_EVENT', payload }, { tab: { id: 1 } });
  storageSetFailures = 0;
  const second = await requestMessage({ type: 'CONTENT_EVENT', payload }, { tab: { id: 1 } });

  assert.equal(first.status, 'error');
  assert.equal(second.status, 'ok');
  assert.equal(storageData.activeSession.metrics.activeMs, 5_000);
  assert.equal(
    storageData.activeSession.events.filter((event) => event.actionType === 'PAGE_DWELL').length,
    1,
  );
});

test('normal SPA navigation retries reuse a receipt after a one-sided metric write', async () => {
  const previousUrl = 'https://docs.example.com/normal-spa-old';
  const navigationUrl = 'https://docs.example.com/normal-spa-new';
  const sessionId = 'normal-spa-receipt-session';
  const generation = getStorageGeneration();
  storageData = {
    trackingEnabled: true,
    activeSession: makeSession(sessionId, 'coding the new feature'),
  };
  await reloadConfig();
  storageSetFailures = 1;

  const payload = {
    actionType: 'SPA_NAVIGATION',
    url: previousUrl,
    previousUrl,
    navigationUrl,
    dwellMs: 5_000,
    dwellDeltaMs: 5_000,
    sessionId,
    generation,
    reportId: 'normal-spa-report-1',
  };
  const first = await requestMessage({ type: 'CONTENT_EVENT', payload }, { tab: { id: 1 } });
  storageSetFailures = 0;
  const second = await requestMessage({ type: 'CONTENT_EVENT', payload }, { tab: { id: 1 } });

  assert.equal(first.status, 'error');
  assert.equal(second.status, 'ok');
  assert.equal(storageData.activeSession.metrics.activeMs, 5_000);
  assert.equal(
    storageData.activeSession.events.filter((event) => event.actionType === 'SPA_NAVIGATION').length,
    1,
  );
});

test('stale normal reports are rejected instead of acknowledged', async () => {
  const url = 'https://docs.example.com/stale-normal-report';
  const sessionId = 'stale-normal-report-session';
  const generation = getStorageGeneration();
  storageData = {
    trackingEnabled: true,
    activeSession: makeSession(sessionId, 'coding the new feature'),
  };
  await reloadConfig();

  const response = await requestMessage({
    type: 'CONTENT_EVENT',
    payload: {
      actionType: 'PAGE_DWELL',
      url,
      dwellMs: 5_000,
      dwellDeltaMs: 5_000,
      sessionId,
      generation: generation + 1,
      reportId: 'stale-normal-report-1',
    },
  }, { tab: { id: 9001 } });

  assert.equal(response.status, 'error');
  assert.match(response.message, /stale/i);
  assert.equal(storageData.activeSession.metrics, undefined);
  assert.equal(storageData.activeSession.events.length, 0);
});

test('rate-limited normal reports are rejected instead of acknowledged', async () => {
  const url = 'https://docs.example.com/rate-limited-normal-report';
  const sessionId = 'rate-limited-normal-report-session';
  const generation = getStorageGeneration();
  const tabId = 9002;
  storageData = {
    trackingEnabled: true,
    activeSession: makeSession(sessionId, 'coding the new feature'),
  };
  await reloadConfig();

  for (let index = 0; index < 120; index += 1) {
    const response = await requestMessage({
      type: 'CONTENT_EVENT',
      payload: {
        actionType: 'TAB_SWITCH',
        url,
      },
    }, { tab: { id: tabId } });
    assert.equal(response.status, 'ok');
  }

  const response = await requestMessage({
    type: 'CONTENT_EVENT',
    payload: {
      actionType: 'PAGE_DWELL',
      url,
      dwellMs: 5_000,
      dwellDeltaMs: 5_000,
      sessionId,
      generation,
      reportId: 'rate-limited-normal-report-1',
    },
  }, { tab: { id: tabId } });

  assert.equal(response.status, 'error');
  assert.match(response.message, /rate limit/i);
  assert.equal(storageData.activeSession.metrics, undefined);
});

test('PAGE_DWELL does not call the configured provider for every snapshot', async () => {
  const url = 'https://dwell-provider-check.example/work';
  const previousFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"aligned":false,"confidence":0.9}' } }] }),
    };
  };
  storageData = {
    trackingEnabled: true,
    llmProviderConfig: {
      providerId: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      authType: 'bearer',
      apiStyle: 'openai',
    },
    activeSession: makeSession('dwell-provider-session', 'coding the new feature'),
  };
  sessionStorageData.llmApiKey = 'test-provider-key';
  await reloadConfig();

  await requestMessage({
    type: 'CONTENT_EVENT',
    payload: {
      actionType: 'PAGE_DWELL',
      url,
      dwellMs: 30_000,
      dwellDeltaMs: 30_000,
    },
  }, { tab: { id: 1 } });
  await waitForCallbacks();
  await waitForCallbacks();

  if (previousFetch) globalThis.fetch = previousFetch;
  else delete globalThis.fetch;
  assert.equal(fetchCount, 0);
});

test('final session history includes the final dwell delta before it is written', async () => {
  const url = 'https://docs.example.com/work';
  storageData = {
    trackingEnabled: true,
    heuristicPolicy: buildDefaultPolicy('coding', 'balanced'),
    activeSession: makeSession('final-dwell-session', 'coding the new feature'),
  };
  await reloadConfig();

  await requestMessage({
    type: 'CONTENT_EVENT',
    payload: {
      actionType: 'PAGE_DWELL',
      url,
      dwellMs: 5_000,
      dwellDeltaMs: 5_000,
    },
  }, { tab: { id: 1 } });
  const ended = await requestMessage({
    type: 'END_ACTIVE_SESSION',
    sessionId: 'final-dwell-session',
  });

  assert.equal(ended.status, 'ok');
  assert.equal(ended.session.activeMs, 5_000);
  assert.equal(storageData.sessionHistory.at(-1).activeMs, 5_000);
});

test('session finalization flushes unreported tracker dwell into metrics and history', async () => {
  const url = 'https://docs.example.com/final-work';
  trackedTabs = [{ id: 11, url }];
  tabUrls.set(11, url);
  finalDwellPayloads.set(11, {
    actionType: 'PAGE_DWELL',
    url,
    dwellMs: 7_000,
    dwellDeltaMs: 7_000,
  });
  storageData = {
    trackingEnabled: true,
    heuristicPolicy: buildDefaultPolicy('coding', 'balanced'),
    activeSession: makeSession('flush-dwell-session', 'coding the new feature'),
  };
  await reloadConfig();

  const ended = await requestMessage({
    type: 'END_ACTIVE_SESSION',
    sessionId: 'flush-dwell-session',
  });

  trackedTabs = [];
  finalDwellPayloads.clear();
  assert.equal(ended.status, 'ok');
  assert.equal(ended.session.activeMs, 7_000);
  assert.equal(ended.session.metrics.activeMs, 7_000);
  assert.equal(storageData.sessionHistory.at(-1).activeMs, 7_000);
});

test('partial multi-tab finalization preserves later dwell on an already flushed tab', async () => {
  const firstTabUrl = 'https://docs.example.com/partial-tab-one';
  const secondTabUrl = 'https://docs.example.com/partial-tab-two';
  trackedTabs = [
    { id: 21, url: firstTabUrl },
    { id: 22, url: secondTabUrl },
  ];
  tabUrls.set(21, firstTabUrl);
  tabUrls.set(22, secondTabUrl);
  finalDwellPayloads.set(21, {
    actionType: 'PAGE_DWELL',
    url: firstTabUrl,
    dwellMs: 5_000,
    dwellDeltaMs: 5_000,
  });
  finalDwellPayloads.set(22, {
    actionType: 'PAGE_DWELL',
    url: secondTabUrl,
    dwellMs: 2_000,
    dwellDeltaMs: 2_000,
  });
  flushBehaviors.set(22, 'reject');
  storageData = {
    trackingEnabled: true,
    heuristicPolicy: buildDefaultPolicy('coding', 'balanced'),
    activeSession: makeSession('partial-multi-tab-session', 'coding the new feature'),
  };
  await reloadConfig();

  const firstEnd = await requestMessage({
    type: 'END_ACTIVE_SESSION',
    sessionId: 'partial-multi-tab-session',
  });
  assert.equal(firstEnd.status, 'error');
  assert.equal(storageData.activeSession.metrics.activeMs, 5_000);

  flushBehaviors.delete(22);
  finalDwellPayloads.set(21, {
    actionType: 'PAGE_DWELL',
    url: firstTabUrl,
    dwellMs: 8_000,
    dwellDeltaMs: 3_000,
  });
  const secondEnd = await requestMessage({
    type: 'END_ACTIVE_SESSION',
    sessionId: 'partial-multi-tab-session',
  });

  trackedTabs = [];
  finalDwellPayloads.clear();
  flushBehaviors.clear();
  assert.equal(secondEnd.status, 'ok');
  assert.equal(secondEnd.session.activeMs, 10_000);
  assert.equal(storageData.sessionHistory.at(-1).activeMs, 10_000);
});

test('retrying a one-sided final dwell write does not duplicate metrics or events', async () => {
  const url = 'https://docs.example.com/one-sided-final-dwell';
  const generation = getStorageGeneration();
  const payload = {
    actionType: 'PAGE_DWELL',
    url,
    dwellMs: 5_000,
    dwellDeltaMs: 5_000,
    sessionId: 'one-sided-final-dwell-session',
    generation,
    flushRequestId: 'one-sided-final-dwell-session:tab-19',
  };
  storageData = {
    trackingEnabled: true,
    activeSession: makeSession(payload.sessionId, 'coding the new feature'),
  };
  await reloadConfig();
  storageSetFailures = 1;

  const first = await requestMessage(
    { type: 'CONTENT_EVENT', payload },
    { tab: { id: 19 } },
  );
  assert.equal(first.status, 'error');
  assert.equal(storageData.activeSession.metrics, undefined);
  assert.equal(
    storageData.activeSession.events.filter((event) => event.actionType === 'PAGE_DWELL').length,
    1,
  );

  const second = await requestMessage(
    { type: 'CONTENT_EVENT', payload },
    { tab: { id: 19 } },
  );
  storageSetFailures = 0;
  assert.equal(second.status, 'ok');
  assert.equal(storageData.activeSession.metrics.activeMs, 5_000);
  assert.equal(
    storageData.activeSession.events.filter((event) => event.actionType === 'PAGE_DWELL').length,
    1,
  );
});

test('inactive content tabs are successful no-ops during final dwell flush', async () => {
  const url = 'https://docs.example.com/inactive-tracker';
  trackedTabs = [{ id: 14, url }];
  tabUrls.set(14, url);
  flushBehaviors.set(14, 'inactive');
  storageData = {
    trackingEnabled: true,
    activeSession: makeSession('inactive-tracker-session', 'coding the new feature'),
  };
  await reloadConfig();

  const response = await requestMessage({
    type: 'END_ACTIVE_SESSION',
    sessionId: 'inactive-tracker-session',
  });

  trackedTabs = [];
  flushBehaviors.clear();
  assert.equal(response.status, 'ok');
  assert.equal(storageData.activeSession, undefined);
  assert.equal(storageData.sessionHistory.at(-1).activeMs, 0);
});

test('empty final dwell acknowledgements block finalization', async () => {
  const url = 'https://docs.example.com/empty-ack';
  trackedTabs = [{ id: 17, url }];
  tabUrls.set(17, url);
  flushBehaviors.set(17, 'empty');
  storageData = {
    trackingEnabled: true,
    activeSession: makeSession('empty-ack-session', 'coding the new feature'),
  };
  await reloadConfig();

  const response = await requestMessage({
    type: 'END_ACTIVE_SESSION',
    sessionId: 'empty-ack-session',
  });

  trackedTabs = [];
  flushBehaviors.clear();
  assert.equal(response.status, 'error');
  assert.equal(response.code, 'FINAL_DWELL_FLUSH_FAILED');
  assert.equal(storageData.activeSession?.isActive, true);
  assert.equal(storageData.sessionHistory, undefined);
});

test('generic message-port closure blocks finalization', async () => {
  const url = 'https://docs.example.com/closed-port';
  trackedTabs = [{ id: 18, url }];
  tabUrls.set(18, url);
  flushBehaviors.set(18, 'closed');
  storageData = {
    trackingEnabled: true,
    activeSession: makeSession('closed-port-session', 'coding the new feature'),
  };
  await reloadConfig();

  const response = await requestMessage({
    type: 'END_ACTIVE_SESSION',
    sessionId: 'closed-port-session',
  });

  trackedTabs = [];
  flushBehaviors.clear();
  assert.equal(response.status, 'error');
  assert.equal(response.code, 'FINAL_DWELL_FLUSH_FAILED');
  assert.equal(storageData.activeSession?.isActive, true);
  assert.equal(storageData.sessionHistory, undefined);
});

test('rejected final dwell flush prevents finalization and history writes', async () => {
  const url = 'https://docs.example.com/rejected-flush';
  trackedTabs = [{ id: 12, url }];
  tabUrls.set(12, url);
  flushBehaviors.set(12, 'reject');
  storageData = {
    trackingEnabled: true,
    activeSession: makeSession('rejected-flush-session', 'coding the new feature'),
  };
  await reloadConfig();

  const response = await requestMessage({
    type: 'END_ACTIVE_SESSION',
    sessionId: 'rejected-flush-session',
  });

  trackedTabs = [];
  flushBehaviors.clear();
  assert.equal(response.status, 'error');
  assert.equal(response.code, 'FINAL_DWELL_FLUSH_FAILED');
  assert.match(response.message, /final dwell flush/i);
  assert.equal(storageData.activeSession?.isActive, true);
  assert.equal(storageData.sessionHistory, undefined);
});

test('timed-out final dwell flush prevents finalization and history writes', async () => {
  const url = 'https://docs.example.com/timed-out-flush';
  trackedTabs = [{ id: 13, url }];
  tabUrls.set(13, url);
  flushBehaviors.set(13, 'timeout');
  storageData = {
    trackingEnabled: true,
    activeSession: makeSession('timed-out-flush-session', 'coding the new feature'),
  };
  await reloadConfig();

  const response = await requestMessage({
    type: 'END_ACTIVE_SESSION',
    sessionId: 'timed-out-flush-session',
  }, {}, 1_500);

  trackedTabs = [];
  flushBehaviors.clear();
  assert.equal(response.status, 'error');
  assert.equal(response.code, 'FINAL_DWELL_FLUSH_FAILED');
  assert.match(response.message, /timed out|final dwell flush/i);
  assert.equal(storageData.activeSession?.isActive, true);
  assert.equal(storageData.sessionHistory, undefined);
});

test('hung final dwell tab queries fail boundedly without finalizing', async () => {
  trackedTabs = [{ id: 15, url: 'https://docs.example.com/query-timeout' }];
  tabsQueryBehavior = 'timeout';
  storageData = {
    trackingEnabled: true,
    activeSession: makeSession('query-timeout-session', 'coding the new feature'),
  };
  await reloadConfig();

  const response = await requestMessage({
    type: 'END_ACTIVE_SESSION',
    sessionId: 'query-timeout-session',
  }, {}, 500);

  tabsQueryBehavior = 'normal';
  trackedTabs = [];
  assert.equal(response.status, 'error');
  assert.equal(response.code, 'FINAL_DWELL_FLUSH_FAILED');
  assert.equal(storageData.activeSession?.isActive, true);
  assert.equal(storageData.sessionHistory, undefined);
});

test('final dwell flush rechecks generation after a delayed tab query', async () => {
  trackedTabs = [{ id: 16, url: 'https://docs.example.com/query-race' }];
  tabsQueryBehavior = 'delayed';
  flushAttempts = 0;
  onTabsQueryStarted = () => {
    onTabsQueryStarted = null;
    beginStorageDeletion();
    endStorageDeletion();
  };
  storageData = {
    trackingEnabled: true,
    activeSession: makeSession('query-race-session', 'coding the new feature'),
  };
  await reloadConfig();

  const response = await requestMessage({
    type: 'END_ACTIVE_SESSION',
    sessionId: 'query-race-session',
  }, {}, 500);

  tabsQueryBehavior = 'normal';
  trackedTabs = [];
  assert.equal(response.status, 'error');
  assert.equal(response.code, 'FINAL_DWELL_FLUSH_FAILED');
  assert.equal(flushAttempts, 0);
  assert.equal(storageData.activeSession?.isActive, true);
  assert.equal(storageData.sessionHistory, undefined);
});

test('late final dwell events cannot write into a newer session', async () => {
  const url = 'https://docs.example.com/late-dwell';
  const generation = getStorageGeneration();
  storageData = {
    trackingEnabled: true,
    activeSession: makeSession('new-session', 'coding the new feature'),
  };
  await reloadConfig();

  const response = await requestMessage({
    type: 'CONTENT_EVENT',
    payload: {
      actionType: 'PAGE_DWELL',
      url,
      dwellMs: 10_000,
      dwellDeltaMs: 10_000,
      sessionId: 'old-session',
      generation,
      flushRequestId: 'old-session:flush',
    },
  }, { tab: { id: 1 } });

  assert.equal(response.status, 'error');
  assert.equal(storageData.activeSession.id, 'new-session');
  assert.deepEqual(storageData.activeSession.events, []);
});

test('final dwell event reports a write failure instead of acknowledging persistence', async () => {
  const url = 'https://docs.example.com/failed-dwell';
  const generation = getStorageGeneration();
  storageData = {
    trackingEnabled: true,
    activeSession: makeSession('failed-flush-session', 'coding the new feature'),
  };
  await reloadConfig();
  storageErrorMessage = 'dwell write failed';

  const response = await requestMessage({
    type: 'CONTENT_EVENT',
    payload: {
      actionType: 'PAGE_DWELL',
      url,
      dwellMs: 10_000,
      dwellDeltaMs: 10_000,
      sessionId: 'failed-flush-session',
      generation,
      flushRequestId: 'failed-flush-session:flush',
    },
  }, { tab: { id: 1 } });

  storageErrorMessage = null;
  assert.equal(response.status, 'error');
});

test('related-domain marks do not carry into a new session', async () => {
  const youtubeUrl = 'https://youtube.com/watch?v=abc';
  tabUrls.set(1, youtubeUrl);
  storageData = {
    trackingEnabled: true,
    heuristicPolicy: buildDefaultPolicy('coding', 'strict'),
    activeSession: makeSession('related-session-one', 'coding the new feature'),
  };
  await reloadConfig();

  const state = await triggerIntervention('test intervention', 1);
  const marked = await requestMessage({
    type: 'INTERVENTION_TRANSITION',
    transition: 'mark-related',
    sessionId: state.sessionId,
    nonce: state.nonce,
    reflection: 'This is relevant to the task.',
  }, { tab: { id: 1 } });
  assert.equal(marked.ok, true);

  const ended = await requestMessage({
    type: 'END_ACTIVE_SESSION',
    sessionId: 'related-session-one',
  });
  assert.equal(ended.status, 'ok');

  storageData = {
    trackingEnabled: true,
    heuristicPolicy: buildDefaultPolicy('coding', 'strict'),
    activeSession: makeSession('related-session-two', 'coding the new feature'),
  };
  await reloadConfig();
  tabUpdatedListener(1, { status: 'complete' }, { url: youtubeUrl });
  await waitForCallbacks();
  await waitForCallbacks();

  assert.ok(storageData.interventionStates, 'old related mark must not suppress a new-session block');
});

test('idle context switching requires an unaligned destination and another signal', async () => {
  const now = Date.now();
  storageData = {
    trackingEnabled: true,
    heuristicPolicy: buildDefaultPolicy('writing', 'strict'),
    activeSession: makeSession('idle-alignment-session', 'write the project article'),
    isCurrentlyIdle: false,
    lastIdleTime: now - 1_000,
  };
  await reloadConfig();
  tabUrls.set(2, 'https://docs.google.com/document/d/abc');
  tabActivatedListener({ tabId: 2 });
  await waitForCallbacks();
  assert.equal(storageData.interventionStates, undefined);

  storageData = {
    trackingEnabled: true,
    heuristicPolicy: buildDefaultPolicy('writing', 'strict'),
    activeSession: {
      ...makeSession('idle-signal-session', 'write the project article'),
      events: [{
        timestamp: now - 1_000,
        actionType: 'PAGE_LOAD',
        url: 'https://reddit.com/r/unrelated',
      }],
    },
    isCurrentlyIdle: false,
    lastIdleTime: now - 1_000,
  };
  await reloadConfig();
  tabUrls.set(2, 'https://example.com/unrelated');
  tabActivatedListener({ tabId: 2 });
  await waitForCallbacks();
  await waitForCallbacks();
  assert.ok(storageData.interventionStates, 'an unaligned destination plus recent unrelated activity should intervene');
});

test('drift debounce is independent for two tabs on the same URL', async () => {
  const url = 'https://youtube.com/watch?v=same';
  tabUrls.set(3, url);
  tabUrls.set(4, url);
  storageData = {
    trackingEnabled: true,
    heuristicPolicy: buildDefaultPolicy('coding', 'strict'),
    activeSession: makeSession('two-tab-debounce-session', 'coding the new feature'),
  };
  await reloadConfig();

  tabUpdatedListener(3, { status: 'complete' }, { url });
  tabUpdatedListener(4, { status: 'complete' }, { url });
  await waitForCallbacks();
  await waitForCallbacks();

  assert.equal(Object.keys(storageData.interventionStates || {}).length, 2);
});

test('drift debounce state is capped at its named limit', async () => {
  storageData = {
    trackingEnabled: true,
    activeSession: makeSession('debounce-cap-session', 'coding the new feature'),
  };
  await reloadConfig();

  const { MAX_DRIFT_DEBOUNCE_ENTRIES, getDriftDebounceSize } = await import('../background.js');
  for (let tabId = 100; tabId < 100 + MAX_DRIFT_DEBOUNCE_ENTRIES + 5; tabId += 1) {
    const url = `https://debounce-${tabId}.example/work`;
    tabUrls.set(tabId, url);
    tabUpdatedListener(tabId, { status: 'complete' }, { url });
  }
  await waitForCallbacks();
  await waitForCallbacks();

  assert.equal(getDriftDebounceSize(), MAX_DRIFT_DEBOUNCE_ENTRIES);
});
