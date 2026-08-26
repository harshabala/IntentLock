import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
let pauseStorageGets = false;
const pausedStorageGets = [];

function flushPausedStorageGets() {
  const pending = pausedStorageGets.splice(0);
  for (const { snapshot, callback } of pending) {
    callback(snapshot);
  }
}

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
      },
      clear: (callback) => {
        sessionStorageData = {};
        if (callback) callback();
      },
    },
    local: {
      get: (keys, callback) => {
        const res = {};
        const keysArr = Array.isArray(keys) ? keys : [keys];
        for (const key of keysArr) {
          if (storageData[key] !== undefined) {
            res[key] = structuredClone(storageData[key]);
          }
        }
        if (pauseStorageGets) {
          pausedStorageGets.push({ snapshot: res, callback });
          return;
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
      },
      clear: (callback) => {
        storageData = {};
        if (callback) callback();
      },
    }
  }
};

// Import background.js to execute its loadConfig
const {
  getInMemoryState,
  reloadConfig,
  loadConfig,
  createHistoryEntry,
  isTrackableUrl,
} = await import('../background.js');
const { beginStorageDeletion, endStorageDeletion, enqueueStorageMutation } = await import('../storage-queue.js');

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

test('loadConfig queued sanitize does not overwrite a newer history written while the get is in flight', async () => {
  const now = Date.now();
  storageData.sessionHistory = [{ id: 'stale-entry', endTime: now, overrides: [] }];
  pauseStorageGets = true;
  try {
    const pendingLoad = reloadConfig();
    storageData.sessionHistory = [{ id: 'fresh-entry', endTime: now, overrides: [] }];
    flushPausedStorageGets();
    pauseStorageGets = false;
    await pendingLoad;
    await enqueueStorageMutation(() => {});
  } finally {
    pauseStorageGets = false;
    pausedStorageGets.length = 0;
  }

  assert.equal(storageData.sessionHistory[0].id, 'fresh-entry');
  assert.equal(storageData.sessionHistory.some((entry) => entry.id === 'stale-entry'), false);
});

test('aborted loadConfig allows a later loadConfig to apply storage', async () => {
  storageData.activeSession = { id: 'stale-session', intent: 'old', isActive: true, startTime: 1, events: [] };
  pauseStorageGets = true;
  try {
    const aborted = reloadConfig();
    beginStorageDeletion();
    flushPausedStorageGets();
    await aborted;
  } finally {
    endStorageDeletion();
    pauseStorageGets = false;
    pausedStorageGets.length = 0;
  }

  storageData.activeSession = { id: 'fresh-session', intent: 'new', isActive: true, startTime: 2, events: [] };
  await loadConfig();
  assert.equal(getInMemoryState().currentSession?.id, 'fresh-session');
});

test('javascript: and data: URLs are not trackable; https:// is', () => {
  assert.equal(isTrackableUrl('javascript:alert(1)'), false);
  assert.equal(isTrackableUrl('data:text/html,hi'), false);
  assert.equal(isTrackableUrl('https://example.com/work'), true);
  assert.equal(isTrackableUrl('http://example.com/work'), true);
});

test('idle context-switch copy does not ask if the user is still aligned', async () => {
  const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  assert.equal(source.includes('Are you still aligned?'), false);
  assert.match(source, /You switched context after being idle\./);
});
