import assert from 'node:assert/strict';
import test from 'node:test';

let storageData = {
  deletionTombstone: { generation: 41, active: true },
};

globalThis.chrome = {
  runtime: { lastError: undefined },
  storage: {
    local: {
      get(keys, callback) {
        const keyList = Array.isArray(keys) ? keys : [keys];
        const result = {};
        for (const key of keyList) {
          if (storageData[key] !== undefined) result[key] = storageData[key];
        }
        callback(result);
      },
      set(values, callback) {
        Object.assign(storageData, values);
        callback?.();
      },
      remove(keys, callback) {
        for (const key of (Array.isArray(keys) ? keys : [keys])) delete storageData[key];
        callback?.();
      },
    },
  },
};

const queue = await import(`../storage-queue.js?fresh-context=${Date.now()}-${Math.random()}`);

test('fresh storage contexts initialize their generation from the persisted tombstone', async () => {
  const generation = await queue.initializeStorageGeneration();
  assert.equal(generation, 41);
  assert.equal(queue.getStorageGeneration(), 41);
  assert.equal(queue.isStorageDeletionActive(), true);
});

test('authoritative storage writer rechecks the tombstone immediately before writing', async () => {
  queue.endStorageDeletion(41);
  storageData.deletionTombstone = { generation: 41, active: false };
  let tombstoneReads = 0;
  const originalGet = chrome.storage.local.get;
  chrome.storage.local.get = (keys, callback) => {
    const keyList = Array.isArray(keys) ? keys : [keys];
    if (keyList.length === 1 && keyList[0] === 'deletionTombstone') {
      tombstoneReads += 1;
      const readNumber = tombstoneReads;
      if (readNumber === 2) {
        storageData.deletionTombstone = { generation: 42, active: true };
      }
      callback({ deletionTombstone: storageData.deletionTombstone || { generation: 41, active: false } });
      return;
    }
    originalGet(keys, callback);
  };

  try {
    const saved = await queue.guardedStorageSet({ activeSession: { id: 'must-not-write' } });
    assert.equal(saved, false);
    assert.equal(storageData.activeSession, undefined);
    assert.ok(tombstoneReads >= 2);
  } finally {
    chrome.storage.local.get = originalGet;
    queue.endStorageDeletion(42);
    storageData.deletionTombstone = { generation: 42, active: false };
  }
});

test('deletion beginning after validation prevents the pending storage mutation', async () => {
  const generation = queue.getStorageGeneration();
  storageData.deletionTombstone = { generation, active: false };
  let setCalled = false;
  let setAccesses = 0;
  const originalSet = chrome.storage.local.set;
  Object.defineProperty(chrome.storage.local, 'set', {
    configurable: true,
    get() {
      setAccesses += 1;
      if (setAccesses === 2) queue.beginStorageDeletion(generation + 1);
      return (values, callback) => {
        setCalled = true;
        originalSet(values, callback);
      };
    },
  });

  try {
    const saved = await queue.guardedStorageSet({ shouldNotPersist: true });
    assert.equal(saved, false);
    assert.equal(setCalled, false);
    assert.equal(storageData.shouldNotPersist, undefined);
  } finally {
    Object.defineProperty(chrome.storage.local, 'set', {
      configurable: true,
      writable: true,
      value: originalSet,
    });
    queue.endStorageDeletion(generation + 1);
    storageData.deletionTombstone = { generation: generation + 1, active: false };
  }
});

test('persisted tombstone flip immediately before mutation prevents the write', async () => {
  const generation = queue.getStorageGeneration();
  storageData.deletionTombstone = { generation, active: false };
  let setAccesses = 0;
  let setCalled = false;
  const originalSet = chrome.storage.local.set;
  Object.defineProperty(chrome.storage.local, 'set', {
    configurable: true,
    get() {
      setAccesses += 1;
      if (setAccesses === 2) {
        storageData.deletionTombstone = { generation: generation + 1, active: true };
      }
      return (values, callback) => {
        setCalled = true;
        originalSet(values, callback);
      };
    },
  });

  try {
    const saved = await queue.guardedStorageSet({ persistedRaceWrite: true });
    assert.equal(saved, false);
    assert.equal(setCalled, false);
    assert.equal(storageData.persistedRaceWrite, undefined);
  } finally {
    Object.defineProperty(chrome.storage.local, 'set', {
      configurable: true,
      writable: true,
      value: originalSet,
    });
    queue.endStorageDeletion(generation + 1);
    storageData.deletionTombstone = { generation: generation + 1, active: false };
  }
});

test('fresh contexts use an inactive persisted generation for guarded writes', async () => {
  storageData = { deletionTombstone: { generation: 41, active: false } };
  const freshQueue = await import(`../storage-queue.js?fresh-inactive=${Date.now()}-${Math.random()}`);

  const saved = await freshQueue.guardedStorageSet({ freshGenerationWrite: true });

  assert.equal(saved, true);
  assert.equal(freshQueue.getStorageGeneration(), 41);
  assert.equal(storageData.freshGenerationWrite, true);
});

test('initialization preserves deletion started before the tombstone read completes', async () => {
  const previousGet = chrome.storage.local.get;
  const previousData = storageData;
  let tombstoneReadStartedResolve;
  let releaseTombstoneRead;
  let released = false;
  const tombstoneReadStarted = new Promise((resolve) => {
    tombstoneReadStartedResolve = resolve;
  });
  storageData = { deletionTombstone: { generation: 42, active: false } };
  chrome.storage.local.get = (keys, callback) => {
    const keyList = Array.isArray(keys) ? keys : [keys];
    if (!released && keyList.length === 1 && keyList[0] === 'deletionTombstone') {
      tombstoneReadStartedResolve();
      releaseTombstoneRead = () => callback({ deletionTombstone: storageData.deletionTombstone });
      return;
    }
    previousGet(keys, callback);
  };

  try {
    const freshQueue = await import(`../storage-queue.js?init-race=${Date.now()}-${Math.random()}`);
    await tombstoneReadStarted;
    assert.equal(freshQueue.beginStorageDeletion(42, { local: true }), 42);
    released = true;
    releaseTombstoneRead();
    await freshQueue.initializeStorageGeneration();
    assert.equal(freshQueue.getStorageGeneration(), 42);
    assert.equal(freshQueue.isStorageDeletionActive(), true);
  } finally {
    released = true;
    releaseTombstoneRead?.();
    chrome.storage.local.get = previousGet;
    storageData = previousData;
  }
});

test('stale deletion-start generations cannot reactivate a completed barrier', async () => {
  storageData = { deletionTombstone: { generation: 2, active: false } };
  const freshQueue = await import(`../storage-queue.js?stale-start=${Date.now()}-${Math.random()}`);

  await freshQueue.initializeStorageGeneration();
  freshQueue.endStorageDeletion(2);
  assert.equal(freshQueue.isStorageDeletionActive(), false);
  assert.equal(freshQueue.beginStorageDeletion(1), 2);
  assert.equal(freshQueue.isStorageDeletionActive(), false);
});

test('stale external deletion starts are reconciled after delayed tombstone initialization', async () => {
  const previousGet = chrome.storage.local.get;
  let releaseTombstoneRead;
  let tombstoneReadStartedResolve;
  let released = false;
  const tombstoneReadStarted = new Promise((resolve) => {
    tombstoneReadStartedResolve = resolve;
  });
  storageData = { deletionTombstone: { generation: 2, active: false } };
  chrome.storage.local.get = (keys, callback) => {
    const keyList = Array.isArray(keys) ? keys : [keys];
    if (!released && keyList.length === 1 && keyList[0] === 'deletionTombstone') {
      tombstoneReadStartedResolve();
      releaseTombstoneRead = () => callback({ deletionTombstone: storageData.deletionTombstone });
      return;
    }
    previousGet(keys, callback);
  };

  try {
    const freshQueue = await import(`../storage-queue.js?stale-start-init=${Date.now()}-${Math.random()}`);
    await tombstoneReadStarted;
    assert.equal(freshQueue.beginStorageDeletion(1), 1);
    released = true;
    releaseTombstoneRead();
    await freshQueue.initializeStorageGeneration();
    assert.equal(freshQueue.getStorageGeneration(), 2);
    assert.equal(freshQueue.isStorageDeletionActive(), false);
  } finally {
    released = true;
    releaseTombstoneRead?.();
    chrome.storage.local.get = previousGet;
  }
});
