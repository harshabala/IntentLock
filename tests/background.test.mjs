import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildDefaultPolicy,
  evaluatePolicyDrift,
  mergePolicyWithIntent,
} from '../heuristic-policy.js';

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
const mockTabs = new Map([
  [7, { id: 7, url: 'https://www.linkedin.com/jobs', active: true }],
]);

function flushPausedStorageGets() {
  const pending = pausedStorageGets.splice(0);
  for (const { snapshot, callback } of pending) {
    callback(snapshot);
  }
}

function flushOnePausedStorageGet() {
  const item = pausedStorageGets.shift();
  if (item) item.callback(item.snapshot);
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
    lastError: undefined,
    onMessage: { addListener: (fn) => { messageListener = fn; } },
    getURL: (path) => `chrome-extension://mock/${path}`
  },
  alarms: {
    create: () => {},
    clear: () => {},
    onAlarm: { addListener: () => {} }
  },
  tabGroups: {
    update: () => Promise.resolve(),
    get: () => Promise.resolve(),
  },
  tabs: {
    onUpdated: { addListener: () => {} },
    onActivated: { addListener: () => {} },
    query: (_query, callback) => {
      const result = [...mockTabs.values()];
      callback?.(result);
      return Promise.resolve(result);
    },
    get: (tabId, callback) => {
      const tab = mockTabs.get(tabId);
      if (tab) {
        callback?.(tab);
        return Promise.resolve(tab);
      }
      chrome.runtime.lastError = { message: 'No tab with id' };
      callback?.();
      chrome.runtime.lastError = undefined;
      return Promise.resolve();
    },
    sendMessage: (_tabId, _message, callback) => {
      callback?.({ shown: true });
      return Promise.resolve({ shown: true });
    },
    update: (tabId, updateProperties, callback) => {
      const tab = mockTabs.get(tabId) || { id: tabId };
      Object.assign(tab, updateProperties);
      mockTabs.set(tabId, tab);
      callback?.(tab);
      return Promise.resolve(tab);
    },
    create: (createProperties, callback) => {
      const tab = { id: 99, ...createProperties };
      mockTabs.set(tab.id, tab);
      callback?.(tab);
      return Promise.resolve(tab);
    },
    group: () => Promise.resolve(456),
  },
  storage: {
    session: {
      get: (keys, callback) => {
        const res = {};
        const keysArr = keys == null ? Object.keys(storageData) : Array.isArray(keys) ? keys : [keys];
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
        const keysArr = keys == null ? Object.keys(storageData) : Array.isArray(keys) ? keys : [keys];
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
        const keysArr = keys == null ? Object.keys(storageData) : Array.isArray(keys) ? keys : [keys];
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
        const keysArr = keys == null ? Object.keys(storageData) : Array.isArray(keys) ? keys : [keys];
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
const { beginStorageDeletion, endStorageDeletion, enqueueStorageMutation, getStorageGeneration } = await import('../storage-queue.js');

// Model the epoch attached by actual extension-page clients.
const originalListener = messageListener;
messageListener = (message, sender, respond) => originalListener({ epoch: getStorageGeneration(), ...message }, sender, respond);

test('content-script senders cannot delete personal storage', async () => {
  storageData.syntheticSentinel = 'keep';
  const response = await new Promise(resolve => messageListener(
    { type: 'DELETE_ALL_DATA' }, { tab: { id: 7 }, url: 'https://example.test/' }, resolve,
  ));
  assert.equal(storageData.syntheticSentinel, 'keep');
  assert.equal(response.status, 'error');
  delete storageData.syntheticSentinel;
});

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
    messageListener({ type: 'SESSION_CLEARED' }, { url: 'chrome-extension://mock/newtab.html' }, (res) => {
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
    flushPausedStorageGets();
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
    flushPausedStorageGets();
  }

  storageData.activeSession = { id: 'fresh-session', intent: 'new', isActive: true, startTime: 2, events: [] };
  await loadConfig();
  assert.equal(getInMemoryState().currentSession?.id, 'fresh-session');
});

test('aborted loadConfig does not null a newer in-flight configPromise', async () => {
  storageData.activeSession = { id: 'stale-session', intent: 'old', isActive: true, startTime: 1, events: [] };
  pauseStorageGets = true;
  let aborted;
  let later;
  let third;
  try {
    aborted = reloadConfig();
    beginStorageDeletion();
    endStorageDeletion();
    storageData.activeSession = { id: 'from-B', intent: 'keep', isActive: true, startTime: 2, events: [] };
    later = reloadConfig();
    flushOnePausedStorageGet();
    storageData.activeSession = { id: 'from-C', intent: 'should-not-apply', isActive: true, startTime: 3, events: [] };
    third = loadConfig();
    flushPausedStorageGets();
    await Promise.all([aborted, later, third]);
  } finally {
    pauseStorageGets = false;
    flushPausedStorageGets();
  }

  assert.equal(getInMemoryState().currentSession?.id, 'from-B');
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

const JOB_SEARCH_INTENT = 'update my resume and prepare for interviews';
const LINKEDIN_FEED_URL = 'https://www.linkedin.com/feed';

function linkedinBurstEvents(now = Date.now()) {
  return [
    { actionType: 'TAB_SWITCH', url: 'https://www.linkedin.com/feed', timestamp: now - 10000 },
    { actionType: 'TAB_SWITCH', url: 'https://www.linkedin.com/in/someone', timestamp: now - 8000 },
    { actionType: 'TAB_SWITCH', url: 'https://www.linkedin.com/messaging', timestamp: now - 6000 },
    { actionType: 'TAB_SWITCH', url: LINKEDIN_FEED_URL, timestamp: now - 4000 },
    { actionType: 'PAGE_LOAD', url: LINKEDIN_FEED_URL, timestamp: now - 2000 },
  ];
}

async function sendContentEvent(payload, tabId = 7) {
  pauseStorageGets = false;
  flushPausedStorageGets();
  await new Promise((resolve) => {
    messageListener(
      { type: 'CONTENT_EVENT', payload },
      { tab: { id: tabId } },
      resolve
    );
  });
  await enqueueStorageMutation(() => {});
}

test('evaluateDrift uses session-merged heuristicPolicy so job_search does not lock LinkedIn', async () => {
  const deepWorkPolicy = buildDefaultPolicy('deep_work', 'balanced');
  const sessionPolicy = mergePolicyWithIntent(JOB_SEARCH_INTENT, deepWorkPolicy);
  assert.equal(sessionPolicy.intentCategoryId, 'job_search');

  const events = linkedinBurstEvents();
  const deepWorkDrift = evaluatePolicyDrift({
    intent: JOB_SEARCH_INTENT,
    url: LINKEDIN_FEED_URL,
    events,
    policy: deepWorkPolicy,
    now: Date.now(),
  });
  const jobSearchDrift = evaluatePolicyDrift({
    intent: JOB_SEARCH_INTENT,
    url: LINKEDIN_FEED_URL,
    events,
    policy: sessionPolicy,
    now: Date.now(),
  });
  assert.equal(deepWorkDrift.shouldIntervene, true, 'deep_work default treats LinkedIn as a distraction');
  assert.equal(jobSearchDrift.shouldIntervene, false, 'job_search merged policy does not');

  delete sessionStorageData.llmApiKey;
  storageData.trackingEnabled = true;
  storageData.heuristicPolicy = deepWorkPolicy;
  storageData.interventionStates = {};
  storageData.activeSession = {
    id: 'job-search-session',
    intent: JOB_SEARCH_INTENT,
    isActive: true,
    startTime: Date.now(),
    events,
    heuristicPolicy: sessionPolicy,
  };
  mockTabs.set(7, { id: 7, url: LINKEDIN_FEED_URL, active: true });
  await reloadConfig();
  assert.equal(getInMemoryState().heuristicPolicy.intentCategoryId, 'deep_work');

  await sendContentEvent({
    actionType: 'SPA_NAVIGATION',
    url: LINKEDIN_FEED_URL,
    navigationUrl: LINKEDIN_FEED_URL,
  });

  const states = storageData.interventionStates || {};
  assert.equal(Object.keys(states).length, 0, 'live lock must use session.heuristicPolicy, not module deep_work');
  assert.equal(storageData.activeSession?.metrics?.interventionCount || 0, 0);
});

test('PAGE_DWELL alignment uses session-merged heuristicPolicy for LinkedIn during job_search', async () => {
  const deepWorkPolicy = buildDefaultPolicy('deep_work', 'balanced');
  const sessionPolicy = mergePolicyWithIntent(JOB_SEARCH_INTENT, deepWorkPolicy);
  delete sessionStorageData.llmApiKey;
  storageData.trackingEnabled = true;
  storageData.heuristicPolicy = deepWorkPolicy;
  storageData.activeSession = {
    id: 'job-search-dwell',
    intent: JOB_SEARCH_INTENT,
    isActive: true,
    startTime: Date.now(),
    events: [],
    heuristicPolicy: sessionPolicy,
  };
  await reloadConfig();

  await sendContentEvent({
    actionType: 'PAGE_DWELL',
    url: LINKEDIN_FEED_URL,
    dwellDeltaMs: 4000,
  });

  const metrics = storageData.activeSession.metrics;
  assert.equal(metrics.activeMs, 4000);
  assert.equal(metrics.alignedActiveMs, 4000, 'LinkedIn dwell is on-intent under session job_search policy');
  assert.equal(metrics.domains['linkedin.com'].alignedMs, 4000);
});

test('TEST_INTERVENTION without a trackable http(s) tab errors and does not create about:blank', async () => {
  assert.ok(messageListener, 'messageListener should be registered');
  const previousTabs = new Map(mockTabs);
  const previousTracking = storageData.trackingEnabled;
  const previousSession = storageData.activeSession;
  mockTabs.clear();
  mockTabs.set(1, { id: 1, url: 'chrome-extension://mock/newtab.html', active: true });
  storageData.trackingEnabled = true;
  storageData.activeSession = {
    id: 'try-lock-session',
    intent: 'write the report',
    isActive: true,
    startTime: Date.now(),
    events: [],
  };

  try {
    let response = null;
    await new Promise((resolve) => {
      messageListener({ type: 'TEST_INTERVENTION' }, { url: 'chrome-extension://mock/options.html' }, (res) => {
        response = res;
        resolve();
      });
    });
    await enqueueStorageMutation(() => {});

    assert.deepEqual(response, {
      ok: false,
      error: 'Open a website first, then try the lock.',
    });
    assert.equal(
      [...mockTabs.values()].some((tab) => tab.url === 'about:blank'),
      false,
      'must not open about:blank as a lock fallback',
    );
  } finally {
    mockTabs.clear();
    for (const [id, tab] of previousTabs) mockTabs.set(id, tab);
    storageData.trackingEnabled = previousTracking;
    storageData.activeSession = previousSession;
  }
});

test('starting a session clears related-domain exceptions from the previous session', async () => {
  storageData.relatedDomainMarks = { 'distraction.localhost': { count: 1, lastMarkedAt: Date.now() } };
  await reloadConfig();
  const response = await new Promise(resolve => messageListener({
    type: 'SESSION_STARTED',
    session: { id: 'fresh-related-scope', intent: 'Draft quarterly report',
      startTime: Date.now(), isActive: true, timeBudget: null, events: [] },
  }, { url: 'chrome-extension://mock/newtab.html' }, resolve));
  assert.equal(response.status, 'ok');
  assert.deepEqual(storageData.relatedDomainMarks || {}, {});
});

test('ending a session removes its related-domain exceptions', async () => {
  storageData.activeSession = { id: 'ending-related-scope', intent: 'Draft quarterly report',
    startTime: Date.now(), isActive: true, events: [] };
  storageData.relatedDomainMarks = { 'distraction.localhost': { count: 1, lastMarkedAt: Date.now() } };
  await reloadConfig();
  const response = await new Promise(resolve => messageListener({
    type: 'END_ACTIVE_SESSION', sessionId: 'ending-related-scope',
  }, { url: 'chrome-extension://mock/newtab.html' }, resolve));
  assert.equal(response.status, 'ok');
  assert.deepEqual(storageData.relatedDomainMarks || {}, {});
});
