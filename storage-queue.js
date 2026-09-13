// Only the service worker owns this queue. Pages send typed commands through
// storage-client.js; a queue in a page is never a storage authority.

export const PRIVACY_MARKER = 'privacyMutationState';

let writeQueue = Promise.resolve();
let storageGeneration = 0;
let deletionActive = false;
let commitGeneration = null;
let initialization = null;

export function storageCall(area, method, value) {
  return new Promise((resolve, reject) => {
    const callback = result => {
      const error = globalThis.chrome.runtime?.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result || {});
    };
    if (method === 'clear') chrome.storage[area][method](callback);
    else chrome.storage[area][method](value, callback);
  });
}

export function assertStorageEpoch(epoch) {
  if (!Number.isSafeInteger(epoch) || epoch !== storageGeneration || deletionActive) {
    throw new Error('Data changed or deletion is pending. Please retry the action.');
  }
}

export function assertStorageCommit() {
  assertStorageEpoch(commitGeneration);
}

export function runStorageMutation(operation, epoch = storageGeneration) {
  return enqueueStorageMutation(async () => {
    assertStorageEpoch(epoch);
    commitGeneration = epoch;
    try {
      const result = await operation();
      assertStorageEpoch(epoch);
      return result;
    } finally {
      commitGeneration = null;
    }
  });
}

export function initializeStorageAuthority(onFence = () => {}) {
  if (initialization) return initialization;
  const wasDeleting = deletionActive;
  deletionActive = true; // No collection while the durable marker is unknown.
  initialization = enqueueStorageMutation(async () => {
    const data = await storageCall('local', 'get', [PRIVACY_MARKER]);
    const marker = data[PRIVACY_MARKER];
    if (marker !== undefined && (!Number.isSafeInteger(marker?.epoch) || marker.epoch < 0 || typeof marker.deleting !== 'boolean')) {
      deletionActive = true;
      throw new Error('Invalid privacy safety marker. Deletion retry is required.');
    }
    storageGeneration = Math.max(storageGeneration, marker?.epoch || 0);
    deletionActive = wasDeleting || marker?.deleting === true;
    if (deletionActive) {
      onFence();
      await finishStorageDeletion();
    } else if (!marker) {
      await storageCall('local', 'set', { [PRIVACY_MARKER]: { epoch: storageGeneration, deleting: false } });
    }
  });
  return initialization;
}

async function finishStorageDeletion() {
  // Never clear the local area: removing the marker even briefly would let a
  // restarted worker accept an old epoch. Enumerate all other keys instead.
  const data = await storageCall('local', 'get', null);
  const keys = Object.keys(data).filter(key => key !== PRIVACY_MARKER);
  const results = await Promise.allSettled([
    keys.length ? storageCall('local', 'remove', keys) : Promise.resolve(),
    chrome.storage.session ? storageCall('session', 'clear') : Promise.resolve(),
  ]);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  await storageCall('local', 'set', { [PRIVACY_MARKER]: { epoch: storageGeneration, deleting: false } });
  deletionActive = false;
}

export function deleteStorageData(onFence = () => {}) {
  beginStorageDeletion();
  onFence();
  return enqueueStorageMutation(async () => {
    // Re-read on retry, including initialization failures, so epochs never go back.
    const data = await storageCall('local', 'get', [PRIVACY_MARKER]);
    storageGeneration = Math.max(storageGeneration, (data[PRIVACY_MARKER]?.epoch || 0) + 1);
    await storageCall('local', 'set', { [PRIVACY_MARKER]: { epoch: storageGeneration, deleting: true } });
    await finishStorageDeletion();
  });
}

export function enqueueStorageMutation(operation) {
  const next = writeQueue.then(operation, operation);
  writeQueue = next.catch(() => {});
  return next;
}

export function getStorageGeneration() {
  return storageGeneration;
}

export function beginStorageDeletion() {
  storageGeneration += 1;
  deletionActive = true;
  return storageGeneration;
}

export function endStorageDeletion() {
  deletionActive = false;
}

export function isStorageDeletionActive() {
  return deletionActive;
}
