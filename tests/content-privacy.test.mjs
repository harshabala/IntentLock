import assert from 'node:assert/strict';
import test from 'node:test';
import { createClassicContext, runClassicScript } from './helpers/load-classic-script.mjs';
import { createOverlayDocument } from './helpers/overlay-dom.mjs';

for (const delayed of ['state response', 'show read', 'tracking read']) test(`classic content ignores deleted ${delayed}`, async () => {
  const { document, MutationObserver, matchMedia } = createOverlayDocument();
  document.removeEventListener = () => {};
  let listener, storageListener, releaseResponse, releaseRead;
  const reports = [];
  let trackerStarts = 0;
  const state = { sessionId: 'old', nonce: 'old', intent: 'deleted intent', reason: 'drift' };
  const chrome = {
    runtime: {
      getURL: path => `chrome-extension://test/${path}`,
      onMessage: { addListener(fn) { listener = fn; } },
      sendMessage(message, callback) {
        if (message.type === 'GET_INTERVENTION_STATE') releaseResponse = callback;
        else { if (message.type === 'CONTENT_EVENT') reports.push(message); callback?.(); }
      },
    },
    storage: {
      onChanged: { addListener(fn) { storageListener = fn; } },
      local: { get(_keys, callback) { callback({ activeSession: { id: 'old', isActive: true }, trackingEnabled: true }); } },
    },
  };
  const context = createClassicContext({ chrome, document, MutationObserver,
    window: { matchMedia, addEventListener() {}, removeEventListener() {} },
    location: { href: 'https://example.test/' }, history: { pushState() {}, replaceState() {} },
    setInterval: () => ++trackerStarts, clearInterval() {}, requestAnimationFrame: callback => callback(),
  });
  for (const file of ['page-tracker.js', 'intervention-overlay.js', 'content.js']) {
    await runClassicScript(new URL('../' + file, import.meta.url), context);
  }
  if (delayed !== 'state response') {
    chrome.storage.local.get = (_keys, callback) => { releaseRead = () => callback({ activeSession: { id: 'old', isActive: true } }); };
    if (delayed === 'show read') listener({ type: 'SHOW_INTERVENTION', state, sessionId: 'old', intent: state.intent }, {}, () => {});
    else storageListener({ trackingEnabled: { newValue: true } }, 'local');
  }
  listener({ type: 'HIDE_INTERVENTION' }, {}, () => {});
  const reportCount = reports.length;
  const startCount = trackerStarts;
  if (delayed === 'state response') releaseResponse({ ok: true, state });
  else releaseRead();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(Boolean(document.getElementById('intentlock-intervention-host')), false);
  assert.equal(reports.length, reportCount, 'deleted read must not report collection');
  assert.equal(trackerStarts, startCount, 'deleted read must not restart collection');
});
