// storage-queue.js — serialize extension-local storage mutations per runtime

let writeQueue = Promise.resolve();
let storageGeneration = 0;
let deletionActive = false;
let generationInitializationPromise = null;
let generationInitialized = false;
let ambientStorageGeneration = null;

export const DELETION_TOMBSTONE_KEY = 'deletionTombstone';
const deletionStartHandlers = new Set();
const deletionWorkWaiters = new Set();

export class StorageGenerationError extends Error {
  constructor(message = 'Storage generation is no longer current') {
    super(message);
    this.name = 'StorageGenerationError';
    this.code = 'STORAGE_GENERATION_STALE';
  }
}

export function enqueueStorageMutation(operation) {
  const next = writeQueue.then(operation, operation);
  writeQueue = next.catch(() => {});
  return next;
}

export function getStorageGeneration() {
  return storageGeneration;
}

export function getStorageMutationGeneration() {
  return ambientStorageGeneration ?? storageGeneration;
}

export async function runWithStorageGeneration(generation, operation) {
  const previous = ambientStorageGeneration;
  ambientStorageGeneration = generation;
  try {
    return await operation();
  } finally {
    ambientStorageGeneration = previous;
  }
}

function storageLocal() {
  return typeof chrome !== 'undefined' ? chrome.storage?.local : null;
}

function readPersistedTombstone(onRead = null) {
  const local = storageLocal();
  if (!local?.get) {
    if (onRead) {
      onRead(null);
      return undefined;
    }
    return Promise.resolve(null);
  }
  const read = (resolve) => {
    local.get([DELETION_TOMBSTONE_KEY], (result) => {
      const tombstone = result?.[DELETION_TOMBSTONE_KEY] ?? null;
      if (Number.isInteger(tombstone?.generation)) {
        storageGeneration = Math.max(storageGeneration, tombstone.generation);
      }
      if (tombstone?.active === true) {
        deletionActive = true;
      } else if (tombstone?.active === false && tombstone.generation === storageGeneration) {
        deletionActive = false;
      }
      if (resolve) resolve(tombstone);
      else onRead(tombstone);
    });
  };
  if (onRead) {
    read(null);
    return undefined;
  }
  return new Promise((resolve) => read(resolve));
}

export function initializeStorageGeneration() {
  if (generationInitialized) return Promise.resolve(storageGeneration);
  if (!generationInitializationPromise) {
    generationInitializationPromise = readPersistedTombstone().then(() => {
      generationInitialized = true;
      return storageGeneration;
    });
  }
  return generationInitializationPromise;
}

void initializeStorageGeneration();

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
  if (Number.isInteger(generation) && generation !== storageGeneration) return false;
  if (Number.isInteger(generation)) storageGeneration = generation;
  deletionActive = false;
  return true;
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

function tombstoneAllowsNormalWrite(tombstone, expectedGeneration) {
  const persistedGeneration = tombstone?.generation;
  return expectedGeneration === storageGeneration
    && !isStorageDeletionActive()
    && tombstone?.active !== true
    && (!Number.isInteger(persistedGeneration) || persistedGeneration <= expectedGeneration);
}

function tombstoneAllowsDeletionWrite(tombstone, expectedGeneration) {
  return expectedGeneration === storageGeneration
    && isStorageDeletionActive()
    && tombstone?.active === true
    && tombstone.generation === expectedGeneration;
}

async function storageWriteAllowed(expectedGeneration, mode = 'normal') {
  await initializeStorageGeneration();
  if (expectedGeneration !== storageGeneration) return false;
  if (mode === 'start-deletion') {
    return expectedGeneration === storageGeneration && isStorageDeletionActive();
  }
  if (mode === 'during-deletion' || mode === 'complete-deletion') {
    const first = await readPersistedTombstone();
    if (!tombstoneAllowsDeletionWrite(first, expectedGeneration)) return false;
    const second = await readPersistedTombstone();
    return tombstoneAllowsDeletionWrite(second, expectedGeneration);
  }
  if (isStorageDeletionActive()) return false;
  const first = await readPersistedTombstone();
  if (!tombstoneAllowsNormalWrite(first, expectedGeneration)) return false;
  // Re-read immediately before the actual storage mutation. This closes the
  // tombstone-flip TOCTOU window shared by all callers.
  const second = await readPersistedTombstone();
  return tombstoneAllowsNormalWrite(second, expectedGeneration);
}

export function isPersistedStorageWriteAllowed(expectedGeneration = getStorageGeneration()) {
  return storageWriteAllowed(expectedGeneration, 'normal');
}

export async function invokeWithStorageWriteBarrier(expectedGeneration, operation) {
  await initializeStorageGeneration();
  return new Promise((resolve, reject) => {
    const rejectStale = () => reject(new StorageGenerationError());
    if (expectedGeneration !== storageGeneration || isStorageDeletionActive()) {
      rejectStale();
      return;
    }
    readPersistedTombstone((first) => {
      if (!tombstoneAllowsNormalWrite(first, expectedGeneration)) {
        rejectStale();
        return;
      }
      readPersistedTombstone((second) => {
        if (!tombstoneAllowsNormalWrite(second, expectedGeneration)) {
          rejectStale();
          return;
        }
        // The invocation is made synchronously in the final tombstone read
        // callback, so a deletion epoch cannot slip between this check and
        // the provider's fetch call.
        try {
          resolve(operation());
        } catch (error) {
          reject(error);
        }
      });
    });
  });
}

function storageAreaOrDefault(area) {
  if (area) return area;
  return storageLocal();
}

function storageRuntimeError() {
  return typeof chrome !== 'undefined' ? chrome.runtime?.lastError : null;
}

function storageMutationBarrier(target, methodName, args, expectedGeneration, options = {}) {
  const { mode = 'normal', silent = false } = options;
  return initializeStorageGeneration().then(() => new Promise((resolve, reject) => {
    const rejectStale = () => {
      if (silent) resolve(false);
      else reject(new StorageGenerationError());
    };
    const generation = Number.isInteger(expectedGeneration)
      ? expectedGeneration
      : getStorageMutationGeneration();
    const invoke = (allowed) => {
      if (!allowed) {
        rejectStale();
        return;
      }
      // Resolve the method and make the in-memory epoch check immediately
      // before invoking it. No await or promise callback can interleave here.
      const method = target[methodName];
      const stillCurrent = mode === 'normal'
        ? generation === storageGeneration && !isStorageDeletionActive()
        : generation === storageGeneration && isStorageDeletionActive();
      if (!method || !stillCurrent) {
        rejectStale();
        return;
      }
      try {
        method.call(target, ...args, () => {
          const error = storageRuntimeError();
          if (error) {
            reject(new Error(error.message));
            return;
          }
          resolve(true);
        });
      } catch (error) {
        reject(error);
      }
    };

    if (generation !== storageGeneration) {
      rejectStale();
      return;
    }
    if (mode === 'start-deletion') {
      invoke(isStorageDeletionActive());
      return;
    }
    if (mode === 'during-deletion' || mode === 'complete-deletion') {
      if (!isStorageDeletionActive()) {
        rejectStale();
        return;
      }
      readPersistedTombstone((first) => {
        if (!tombstoneAllowsDeletionWrite(first, generation)) {
          rejectStale();
          return;
        }
        readPersistedTombstone((second) => {
          invoke(tombstoneAllowsDeletionWrite(second, generation));
        });
      });
      return;
    }
    if (isStorageDeletionActive()) {
      rejectStale();
      return;
    }
    readPersistedTombstone((first) => {
      if (!tombstoneAllowsNormalWrite(first, generation)) {
        rejectStale();
        return;
      }
      readPersistedTombstone((second) => {
        invoke(tombstoneAllowsNormalWrite(second, generation));
      });
    });
  }));
}

export function writeStorageSet(values, area = null, expectedGeneration = null, options = {}) {
  const target = storageAreaOrDefault(area);
  if (!target?.set) return Promise.resolve(false);
  return storageMutationBarrier(target, 'set', [values], expectedGeneration, options);
}

export function writeStorageRemove(keys, area = null, expectedGeneration = null, options = {}) {
  const target = storageAreaOrDefault(area);
  if (!target?.remove) return Promise.resolve(false);
  return storageMutationBarrier(target, 'remove', [keys], expectedGeneration, options);
}

export function writeStorageClear(area = null, expectedGeneration = null, options = {}) {
  const target = storageAreaOrDefault(area);
  if (!target?.clear) return Promise.resolve(false);
  return storageMutationBarrier(target, 'clear', [], expectedGeneration, options);
}

export function guardedStorageSet(values, area = null, expectedGeneration = null) {
  return enqueueStorageMutation(async () => {
    await initializeStorageGeneration();
    const generation = Number.isInteger(expectedGeneration)
      ? expectedGeneration
      : getStorageMutationGeneration();
    return writeStorageSet(values, area, generation, { silent: true });
  });
}

export function guardedStorageRemove(keys, area = null, expectedGeneration = null) {
  return enqueueStorageMutation(async () => {
    await initializeStorageGeneration();
    const generation = Number.isInteger(expectedGeneration)
      ? expectedGeneration
      : getStorageMutationGeneration();
    return writeStorageRemove(keys, area, generation, { silent: true });
  });
}

export function writeDeletionTombstone(generation, active) {
  return writeStorageSet(
    { [DELETION_TOMBSTONE_KEY]: { generation, active } },
    storageLocal(),
    generation,
    { mode: active ? 'start-deletion' : 'complete-deletion', silent: true },
  );
}

export function completeStorageDeletion(generation) {
  return writeDeletionTombstone(generation, false).then(async (saved) => {
    if (!saved) return false;
    const tombstone = await readPersistedTombstone();
    return tombstone?.active === false
      && tombstone.generation === generation
      && generation === storageGeneration
      && !isStorageDeletionActive();
  });
}
