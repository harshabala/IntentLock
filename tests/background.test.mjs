import assert from 'node:assert/strict';
import test from 'node:test';

// Setup global mock for Chrome APIs
let sessionStorageData = {};
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

globalThis.chrome = {
  idle: {
    setDetectionInterval: () => {},
    onStateChanged: { addListener: () => {} }
  },
  commands: {
    onCommand: { addListener: () => {} }
  },
  runtime: {
    onMessage: { addListener: (fn) => { messageListener = fn; } },
    getURL: (path) => `chrome-extension://mock/${path}`
  },
  alarms: {
    create: () => {},
    clear: () => {},
    onAlarm: { addListener: () => {} }
  },
  tabs: {
    onUpdated: { addListener: () => {} },
    onActivated: { addListener: () => {} }
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
      }
    },
    local: {
      get: (keys, callback) => {
        const res = {};
        for (const key of keys) {
          if (storageData[key] !== undefined) {
            res[key] = storageData[key];
          }
        }
        callback(res);
      },
      set: (data, callback) => {
        Object.assign(storageData, data);
        if (callback) callback();
      },
      remove: (keys, callback) => {
        const keysArr = Array.isArray(keys) ? keys : [keys];
        for (const k of keysArr) {
          delete storageData[k];
        }
        if (callback) callback();
      }
    }
  }
};

// Import background.js to execute its loadConfig
const { getInMemoryState, reloadConfig, createHistoryEntry } = await import('../background.js');

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
