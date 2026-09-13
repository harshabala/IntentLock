// Capture before reading a form, fetching, or opening an asynchronous callback.
// Never obtain a replacement epoch when submitting an already-created payload.
import { PRIVACY_MARKER } from './storage-queue.js';

export function captureStorageEpoch() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([PRIVACY_MARKER], data => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      const marker = data?.[PRIVACY_MARKER];
      if (marker?.deleting) return reject(new Error('Data deletion is pending. Retry deletion in Settings.'));
      resolve(marker?.epoch ?? 0);
    });
  });
}

export async function sendStorageAction(message, epochPromise = captureStorageEpoch()) {
  const epoch = await epochPromise;
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ ...message, epoch }, response => {
      if (chrome.runtime.lastError || response?.status === 'error' || !response) {
        reject(new Error(chrome.runtime.lastError?.message || response?.message || 'Unable to persist the change.'));
      } else resolve(response);
    });
  });
}

export function mutateStorage(command, payload = {}, epoch = captureStorageEpoch()) {
  return sendStorageAction({ type: 'STORAGE_MUTATION', command, payload }, epoch).then(response => response.value);
}
