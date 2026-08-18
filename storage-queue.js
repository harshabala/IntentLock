// storage-queue.js — serialize extension-local storage mutations per runtime

let writeQueue = Promise.resolve();
let storageGeneration = 0;
let deletionActive = false;
export const DELETION_TOMBSTONE_KEY = 'deletionTombstone';
const deletionStartHandlers = new Set();
const deletionWorkWaiters = new Set();

export function enqueueStorageMutation(operation) {
  const next = writeQueue.then(operation, operation);
  writeQueue = next.catch(() => {});
  return next;
}

export function getStorageGeneration() {
  return storageGeneration;
}

export function beginStorageDeletion(generation = null) {
  if (Number.isInteger(generation)) {
    storageGeneration = Math.max(storageGeneration, generation);
  } else {
    storageGeneration += 1;
  }
  deletionActive = true;
  deletionStartHandlers.forEach((handler) => {
    try {
      handler(storageGeneration);
    } catch {
      // A deletion barrier must continue even if one abort hook fails.
    }
  });
  return storageGeneration;
}

export function endStorageDeletion(generation = null) {
  if (Number.isInteger(generation)) {
    storageGeneration = Math.max(storageGeneration, generation);
  }
  deletionActive = false;
}

export function isStorageDeletionActive() {
  return deletionActive;
}

export function registerStorageDeletionStartHandler(handler) {
  if (typeof handler !== 'function') return () => {};
  deletionStartHandlers.add(handler);
  return () => deletionStartHandlers.delete(handler);
}

export function registerStorageDeletionWaiter(waiter) {
  if (typeof waiter !== 'function') return () => {};
  deletionWorkWaiters.add(waiter);
  return () => deletionWorkWaiters.delete(waiter);
}

export function waitForStorageDeletionWork() {
  return Promise.all(Array.from(deletionWorkWaiters, (waiter) => {
    try {
      return Promise.resolve(waiter());
    } catch (error) {
      return Promise.reject(error);
    }
  }));
}

export function isPersistedStorageWriteAllowed(expectedGeneration = getStorageGeneration()) {
  if (expectedGeneration !== getStorageGeneration() || isStorageDeletionActive()) {
    return Promise.resolve(false);
  }
  if (typeof chrome === 'undefined' || !chrome.storage?.local?.get) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    chrome.storage.local.get([DELETION_TOMBSTONE_KEY], (result) => {
      const tombstone = result?.[DELETION_TOMBSTONE_KEY];
      const persistedGeneration = tombstone?.generation;
      const allowed = expectedGeneration === getStorageGeneration()
        && !isStorageDeletionActive()
        && tombstone?.active !== true
        && (!Number.isInteger(persistedGeneration) || persistedGeneration <= expectedGeneration);
      resolve(allowed);
    });
  });
}

function storageAreaOrDefault(area) {
  if (area) return area;
  return typeof chrome !== 'undefined' ? chrome.storage?.local : null;
}

export function guardedStorageSet(values, area = null, expectedGeneration = getStorageGeneration()) {
  const target = storageAreaOrDefault(area);
  if (!target?.set) return Promise.resolve(false);
  return enqueueStorageMutation(async () => {
    if (!await isPersistedStorageWriteAllowed(expectedGeneration)) return false;
    return new Promise((resolve, reject) => {
      target.set(values, () => {
        const error = typeof chrome !== 'undefined' ? chrome.runtime?.lastError : null;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(true);
      });
    });
  });
}

export function guardedStorageRemove(keys, area = null, expectedGeneration = getStorageGeneration()) {
  const target = storageAreaOrDefault(area);
  if (!target?.remove) return Promise.resolve(false);
  return enqueueStorageMutation(async () => {
    if (!await isPersistedStorageWriteAllowed(expectedGeneration)) return false;
    return new Promise((resolve, reject) => {
      target.remove(keys, () => {
        const error = typeof chrome !== 'undefined' ? chrome.runtime?.lastError : null;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(true);
      });
    });
  });
}
