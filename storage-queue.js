// storage-queue.js — serialize extension-local storage mutations per runtime

let writeQueue = Promise.resolve();
let storageGeneration = 0;
let deletionActive = false;

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
