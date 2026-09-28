// Capture before reading a form, fetching, or opening an asynchronous callback.
// Never obtain a replacement epoch when submitting an already-created payload.
import { PRIVACY_MARKER } from './storage-queue.js';

let pageEpoch = null;
let initialization = null;
let revision = 0;
let listening = false;

// Call before loading page data or binding actions. An action never reads an
// epoch asynchronously: it receives the page snapshot's already-known epoch.
export function initializeStorageClient() {
  if (initialization) return initialization;
  if (!listening) {
    listening = true;
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (sender?.tab || (sender?.id && sender.id !== chrome.runtime.id)) return;
      if (message?.type === 'DATA_DELETION_STARTED') {
        revision++;
        pageEpoch = null;
      } else if (message?.type === 'DATA_DELETED') {
        revision++;
        pageEpoch = Number.isSafeInteger(message.epoch) ? message.epoch : null;
        initialization = pageEpoch === null ? null : Promise.resolve(pageEpoch);
      }
    });
  }
  const startedRevision = revision;
  initialization = new Promise((resolve, reject) => {
    chrome.storage.local.get([PRIVACY_MARKER], data => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      const marker = data?.[PRIVACY_MARKER];
      if (startedRevision !== revision || marker?.deleting) {
        return reject(new Error('Data deletion changed this page. Reload before continuing.'));
      }
      pageEpoch = marker?.epoch ?? 0;
      resolve(pageEpoch);
    });
  });
  return initialization;
}

export function captureStorageEpoch() {
  // Promise-compatible for callers, but capture the value NOW without IO.
  return Number.isSafeInteger(pageEpoch)
    ? Promise.resolve(pageEpoch)
    : Promise.reject(new Error('The page is not ready or data deletion is pending. Reload before continuing.'));
}

// Capture while attaching a synchronous UI continuation, not when it runs.
// A reply may be accepted just before deletion invalidates the queued render.
export function guardStorageContinuation(callback) {
  const epoch = pageEpoch;
  const startedRevision = revision;
  return (...args) => {
    if (!Number.isSafeInteger(epoch) || epoch !== pageEpoch || startedRevision !== revision) return;
    return callback(...args);
  };
}

export async function sendStorageAction(message, epochPromise = captureStorageEpoch()) {
  const epoch = await epochPromise;
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ ...message, epoch }, response => {
      if (epoch !== pageEpoch) {
        reject(new Error('Data changed during this action. Please try again.'));
        return;
      }
      if (chrome.runtime.lastError || response?.status === 'error' || !response) {
        reject(new Error(chrome.runtime.lastError?.message || response?.message || 'Unable to persist the change.'));
      } else resolve(response);
    });
  });
}

export function mutateStorage(command, payload = {}, epoch = captureStorageEpoch()) {
  return sendStorageAction({ type: 'STORAGE_MUTATION', command, payload }, epoch).then(response => response.value);
}
