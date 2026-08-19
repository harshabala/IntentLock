import assert from 'node:assert/strict';
import test from 'node:test';

const storageData = {
  deletionTombstone: { generation: 41, active: false },
  llmApiKey: 'legacy-startup-key',
  activeSession: {
    id: 'startup-session',
    intent: 'startup generation test',
    startTime: Date.now(),
    timeBudget: null,
    isActive: true,
    events: [{
      actionType: 'PAGE_LOAD',
      url: 'https://example.com/private/path?secret=1#fragment',
      pageTitle: 'Private startup title',
      timestamp: Date.now(),
    }],
  },
};
const sessionStorageData = {};
let releaseTombstoneRead;
let tombstoneReadStartedResolve;
let tombstoneReleased = false;
const tombstoneReadStarted = new Promise((resolve) => {
  tombstoneReadStartedResolve = resolve;
});

function resultFor(keys, source) {
  const values = {};
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    if (source[key] !== undefined) values[key] = source[key];
  }
  return values;
}

const localStorage = {
  get(keys, callback) {
    const keyList = Array.isArray(keys) ? keys : [keys];
    if (!tombstoneReleased && keyList.length === 1 && keyList[0] === 'deletionTombstone') {
      tombstoneReadStartedResolve();
      releaseTombstoneRead = () => callback(resultFor(keys, storageData));
      return;
    }
    callback(resultFor(keys, storageData));
  },
  set(values, callback) {
    Object.assign(storageData, values);
    callback?.();
  },
  remove(keys, callback) {
    for (const key of (Array.isArray(keys) ? keys : [keys])) delete storageData[key];
    callback?.();
  },
  clear(callback) {
    for (const key of Object.keys(storageData)) delete storageData[key];
    callback?.();
  },
};

globalThis.chrome = {
  runtime: {
    lastError: undefined,
    getURL: (path) => `chrome-extension://test/${path}`,
    sendMessage: (_message, callback) => callback?.(),
    onMessage: { addListener: () => {} },
  },
  storage: {
    local: localStorage,
    session: {
      get: (keys, callback) => callback(resultFor(keys, sessionStorageData)),
      set: (values, callback) => {
        Object.assign(sessionStorageData, values);
        callback?.();
      },
      remove: (keys, callback) => {
        for (const key of (Array.isArray(keys) ? keys : [keys])) delete sessionStorageData[key];
        callback?.();
      },
      clear: (callback) => {
        for (const key of Object.keys(sessionStorageData)) delete sessionStorageData[key];
        callback?.();
      },
    },
    onChanged: { addListener: () => {} },
  },
  idle: {
    setDetectionInterval: () => {},
    onStateChanged: { addListener: () => {} },
  },
  commands: { onCommand: { addListener: () => {} } },
  alarms: {
    create: () => {},
    clear: () => {},
    onAlarm: { addListener: () => {} },
  },
  tabs: {
    query: (_query, callback) => {
      callback?.([]);
      return Promise.resolve([]);
    },
    get: (_tabId, callback) => callback?.({ id: 1, url: 'https://example.com' }),
    update: (_tabId, _properties, callback) => callback?.(),
    remove: (_tabId, callback) => callback?.(),
    create: (_properties, callback) => callback?.({ id: 1 }),
    sendMessage: (_tabId, _message, callback) => callback?.(),
    onUpdated: { addListener: () => {} },
    onActivated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
    group: () => Promise.resolve(1),
  },
  tabGroups: {
    get: () => Promise.resolve({}),
    update: () => Promise.resolve(),
  },
};

const backgroundPromise = import(`../background.js?startup-generation=${Date.now()}-${Math.random()}`);

test('startup callers await the persisted generation before reading or writing', async () => {
  await tombstoneReadStarted;
  const background = await backgroundPromise;

  tombstoneReleased = true;
  releaseTombstoneRead();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(storageData.llmApiKey, undefined);
  assert.equal(storageData.activeSession.events[0].pageTitle, undefined);
  assert.equal(storageData.activeSession.events[0].url, 'https://example.com');
  assert.equal(background.getInMemoryState().currentSession?.id, 'startup-session');
});
