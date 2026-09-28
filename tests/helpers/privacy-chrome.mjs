import { webcrypto } from 'node:crypto';

// Node 18 may not expose the browser Web Crypto global.
globalThis.crypto ??= webcrypto;

// Synthetic IO: get snapshots at invocation; mutations complete when released.
export function privacyChrome(localData = {}, sessionData = {}) {
  const local = structuredClone(localData), session = structuredClone(sessionData);
  const listeners = [], calls = [];
  let pause, failure, held, replyPause, heldReply;
  const event = { addListener() {} };
  const chrome = {
    runtime: {
      id: 'privacy-test', lastError: undefined,
      getURL: path => `chrome-extension://privacy-test/${path}`,
      onMessage: { addListener(fn) { listeners.push(fn); } },
      sendMessage(message, callback) {
        if (['DATA_DELETION_STARTED', 'DATA_DELETED', 'HIDE_INTERVENTION'].includes(message.type)) {
          calls.push(message.type);
          for (const listener of listeners.slice(1)) listener(message, { id: 'privacy-test' }, () => {});
          callback?.(); return;
        }
        listeners[0](message, { id: 'privacy-test', url: chrome.runtime.getURL('options.html') }, response => {
          if (replyPause?.(message, response)) {
            replyPause = null;
            heldReply = () => callback?.(response);
          } else callback?.(response);
        });
      },
    },
    idle: { setDetectionInterval() {}, onStateChanged: event },
    commands: { onCommand: event },
    alarms: { onAlarm: event, create() { calls.push('alarm:create'); }, clear() { calls.push('alarm:clear'); } },
    tabs: {
      onUpdated: event, onActivated: event, onRemoved: event,
      query(_q, callback) { callback?.([]); return Promise.resolve([]); },
      sendMessage(_id, _message, callback) { callback?.({ shown: true }); },
      get(_id, callback) { callback?.(null); },
    },
    storage: { onChanged: event },
  };
  for (const [area, data] of [['local', local], ['session', session]]) {
    chrome.storage[area] = {};
    for (const method of ['get', 'set', 'remove', 'clear']) {
      chrome.storage[area][method] = (value, callback) => {
        if (method === 'clear') { callback = value; value = undefined; }
        const keys = value == null ? Object.keys(data) : Array.isArray(value) ? value : [value];
        const snapshot = method === 'get' ? Object.fromEntries(keys.filter(key => key in data).map(key => [key, structuredClone(data[key])])) : undefined;
        const op = { area, method, value };
        const complete = () => {
          if (failure?.(op)) {
            failure = null;
            chrome.runtime.lastError = { message: `synthetic ${area} ${method} failure` };
            callback?.(); chrome.runtime.lastError = undefined; return;
          }
          if (method === 'set') Object.assign(data, structuredClone(value));
          if (method === 'remove') keys.forEach(key => delete data[key]);
          if (method === 'clear') Object.keys(data).forEach(key => delete data[key]);
          callback?.(snapshot);
        };
        if (pause?.(op)) { pause = null; held = complete; } else complete();
      };
    }
  }
  return {
    chrome, local, session, calls,
    holdNextReply(predicate) { replyPause = predicate; },
    get isReplyHeld() { return Boolean(heldReply); },
    releaseReply() { const deliver = heldReply; heldReply = null; deliver?.(); },
    holdNext(predicate) { pause = predicate; }, failNext(predicate) { failure = predicate; },
    get isHeld() { return Boolean(held); },
    release() { const complete = held; held = null; complete?.(); },
    send(message, sender = { id: 'privacy-test', url: chrome.runtime.getURL('options.html') }) {
      return new Promise(resolve => listeners[0](message, sender, resolve));
    },
  };
}
export async function until(predicate) {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('Controlled callback was not reached');
}
