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
    storageData.deletionTombstone = { generation: 42, active: false };
  }
});
