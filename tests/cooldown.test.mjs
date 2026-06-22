import assert from 'node:assert/strict';
import test from 'node:test';

// Setup global mock for Chrome APIs before importing background.js
let sessionStorageData = {};
let storageData = {};

let messageListeners = [];
let tabUpdatedListeners = [];
let tabActivatedListeners = [];
let alarmListeners = [];

let tabsGetMock = (tabId) => ({ id: tabId, url: '' });
let tabsQueryMock = (queryInfo) => [];
let tabsUpdateCalls = [];
let tabsSendMessageCalls = [];

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
    onMessage: {
      addListener: (listener) => {
        messageListeners.push(listener);
      }
    },
    sendMessage: () => {},
    getURL: (path) => `chrome-extension://mock/${path}`
  },
  alarms: {
    create: () => {},
    clear: () => {},
    onAlarm: {
      addListener: (listener) => {
        alarmListeners.push(listener);
      }
    }
  },
  tabs: {
    onUpdated: {
      addListener: (listener) => {
        tabUpdatedListeners.push(listener);
      }
    },
    onActivated: {
      addListener: (listener) => {
        tabActivatedListeners.push(listener);
      }
    },
    get: (tabId, callback) => {
      const res = tabsGetMock(tabId);
      if (callback) callback(res);
      return Promise.resolve(res);
    },
    query: (queryInfo, callback) => {
      const res = tabsQueryMock(queryInfo);
      if (callback) callback(res);
      return Promise.resolve(res);
    },
    update: (tabId, updateProperties, callback) => {
      tabsUpdateCalls.push({ tabId, updateProperties });
      if (callback) callback();
      return Promise.resolve();
    },
    sendMessage: (tabId, message, callback) => {
      tabsSendMessageCalls.push({ tabId, message });
      if (callback) callback(undefined);
      return Promise.resolve();
    },
    group: () => Promise.resolve(456)
  },
  tabGroups: {
    update: () => Promise.resolve(),
    get: () => Promise.resolve()
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
        const keysArr = Array.isArray(keys) ? keys : [keys];
        for (const key of keysArr) {
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

// Helper functions to trigger background listeners
function triggerTabUpdate(tabId, changeInfo, tab) {
  for (const listener of tabUpdatedListeners) {
    listener(tabId, changeInfo, tab);
  }
}

function triggerTabActivated(activeInfo) {
  for (const listener of tabActivatedListeners) {
    listener(activeInfo);
  }
}

function triggerMessage(message, sender = {}) {
  return new Promise((resolve) => {
    let responded = false;
    const sendResponse = (response) => {
      responded = true;
      resolve(response);
    };
    for (const listener of messageListeners) {
      const isAsync = listener(message, sender, sendResponse);
      if (!isAsync && !responded) {
        resolve();
      }
    }
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Import background.js
const { getInMemoryState, reloadConfig } = await import('../background.js');

test('Set Cooldown on Override sets a cooldown in memory and local storage', async () => {
  // Reset state
  storageData = {
    activeSession: {
      id: 'session-123',
      intent: 'writing code',
      isActive: true,
      startTime: Date.now(),
      events: []
    }
  };
  await reloadConfig();

  const state = getInMemoryState();
  state.overrideCooldowns.clear();
  delete storageData.overrideCooldowns;

  const now = Date.now();
  await triggerMessage({
    type: 'OVERRIDE_INTERVENTION',
    sessionData: {
      id: 'session-123',
      intent: 'writing code',
      isActive: true,
      events: [
        {
          timestamp: now,
          actionType: 'OVERRIDE',
          url: 'https://www.facebook.com/somepage'
        }
      ]
    }
  });

  // Check in-memory state
  const overrideCooldowns = state.overrideCooldowns;
  assert.ok(overrideCooldowns.has('facebook.com'), 'cooldown map should have facebook.com');
  const expiry = overrideCooldowns.get('facebook.com');
  assert.ok(expiry > now, 'cooldown expiry should be in the future');
  // Allow a 1000ms timing buffer to avoid race conditions with Date.now()
  assert.ok(expiry <= now + 5 * 60 * 1000 + 1000, 'cooldown expiry should be within 5 minutes');

  // Check local storage persistence
  assert.ok(Array.isArray(storageData.overrideCooldowns), 'overrideCooldowns should be saved to local storage');
  const savedPair = storageData.overrideCooldowns.find(([domain]) => domain === 'facebook.com');
  assert.ok(savedPair, 'facebook.com should be in the saved overrideCooldowns array');
  assert.equal(savedPair[1], expiry, 'saved cooldown expiry should match memory');
});

test('Cooldown Bypass avoids triggering interventions during active cooldown', async () => {
  // Set up active session with facebook.com as distraction site
  storageData = {
    activeSession: {
      id: 'session-123',
      intent: 'writing code',
      isActive: true,
      startTime: Date.now(),
      events: []
    },
    customDistractionSites: ['facebook.com'],
    trackingEnabled: true
  };
  await reloadConfig();

  // 1. Without cooldown: triggering page load on facebook.com should trigger intervention
  tabsUpdateCalls = [];
  triggerTabUpdate(1, { status: 'complete' }, { url: 'https://www.facebook.com/profile' });
  await sleep(20);
  assert.equal(tabsUpdateCalls.length, 1, 'Without cooldown, intervention should be triggered');
  assert.equal(tabsUpdateCalls[0].tabId, 1);
  assert.match(tabsUpdateCalls[0].updateProperties.url, /intervention\.html/);

  // 2. With valid active cooldown: triggering page load should NOT trigger intervention
  const state = getInMemoryState();
  const futureExpiry = Date.now() + 5 * 60 * 1000;
  state.overrideCooldowns.set('facebook.com', futureExpiry);
  storageData.overrideCooldowns = [['facebook.com', futureExpiry]];

  tabsUpdateCalls = [];
  triggerTabUpdate(1, { status: 'complete' }, { url: 'https://www.facebook.com/profile' });
  await sleep(20);
  assert.equal(tabsUpdateCalls.length, 0, 'With cooldown, intervention should not be triggered on page update');

  // 3. With valid active cooldown: triggering tab activation should NOT trigger intervention
  tabsUpdateCalls = [];
  tabsGetMock = (tabId) => ({ id: tabId, url: 'https://www.facebook.com/profile' });
  triggerTabActivated({ tabId: 1, windowId: 1 });
  await sleep(20);
  assert.equal(tabsUpdateCalls.length, 0, 'With cooldown, intervention should not be triggered on tab activation');
});

test('Subdomain Matching matches subdomains bidirectionally', async () => {
  // Set up active session with facebook.com as distraction site
  storageData = {
    activeSession: {
      id: 'session-123',
      intent: 'writing code',
      isActive: true,
      startTime: Date.now(),
      events: []
    },
    customDistractionSites: ['facebook.com', 'reddit.com'],
    trackingEnabled: true
  };
  await reloadConfig();

  const state = getInMemoryState();
  const futureExpiry = Date.now() + 5 * 60 * 1000;

  // Scenario A: Cooldown for facebook.com covers subdomain m.facebook.com
  state.overrideCooldowns.clear();
  state.overrideCooldowns.set('facebook.com', futureExpiry);
  storageData.overrideCooldowns = [['facebook.com', futureExpiry]];

  tabsUpdateCalls = [];
  triggerTabUpdate(1, { status: 'complete' }, { url: 'https://m.facebook.com/' });
  await sleep(20);
  assert.equal(tabsUpdateCalls.length, 0, 'Cooldown for facebook.com should bypass intervention on m.facebook.com');

  // Scenario B: Cooldown for m.facebook.com covers parent domain facebook.com
  state.overrideCooldowns.clear();
  state.overrideCooldowns.set('m.facebook.com', futureExpiry);
  storageData.overrideCooldowns = [['m.facebook.com', futureExpiry]];

  tabsUpdateCalls = [];
  triggerTabUpdate(1, { status: 'complete' }, { url: 'https://facebook.com/' });
  await sleep(20);
  assert.equal(tabsUpdateCalls.length, 0, 'Cooldown for m.facebook.com should bypass intervention on facebook.com');

  // Scenario C: Cooldown does not affect unrelated domains (e.g. reddit.com)
  tabsUpdateCalls = [];
  triggerTabUpdate(1, { status: 'complete' }, { url: 'https://www.reddit.com/' });
  await sleep(20);
  assert.equal(tabsUpdateCalls.length, 1, 'Cooldown for m.facebook.com should not bypass intervention on reddit.com');
});

test('Session Reset Cleanup clears active cooldowns on SESSION_STARTED and SESSION_CLEARED', async () => {
  storageData = {
    activeSession: {
      id: 'session-123',
      intent: 'writing code',
      isActive: true,
      startTime: Date.now(),
      events: []
    }
  };
  await reloadConfig();

  const state = getInMemoryState();
  const futureExpiry = Date.now() + 5 * 60 * 1000;

  // 1. Check SESSION_STARTED resets cooldowns
  state.overrideCooldowns.set('facebook.com', futureExpiry);
  storageData.overrideCooldowns = [['facebook.com', futureExpiry]];

  await triggerMessage({
    type: 'SESSION_STARTED',
    session: { id: 'new-session-456', intent: 'writing tests', startTime: Date.now() }
  });

  assert.equal(state.overrideCooldowns.size, 0, 'overrideCooldowns map in memory should be cleared on session start');
  assert.equal(storageData.overrideCooldowns, undefined, 'overrideCooldowns in storage should be removed on session start');

  // 2. Check SESSION_CLEARED resets cooldowns
  state.overrideCooldowns.set('facebook.com', futureExpiry);
  storageData.overrideCooldowns = [['facebook.com', futureExpiry]];

  await triggerMessage({
    type: 'SESSION_CLEARED'
  });

  assert.equal(state.overrideCooldowns.size, 0, 'overrideCooldowns map in memory should be cleared on session clear');
  assert.equal(storageData.overrideCooldowns, undefined, 'overrideCooldowns in storage should be removed on session clear');
});
