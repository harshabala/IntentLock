import assert from 'node:assert/strict';
import test from 'node:test';
import { loadClassicScript } from './helpers/load-classic-script.mjs';

const overlayRuntime = await loadClassicScript(new URL('../intervention-overlay.js', import.meta.url));
const { buildOverlayStyles, createInterventionOverlay } = overlayRuntime.IntentLock.interventionOverlay;

test('buildOverlayStyles includes core intervention layout rules', () => {
  const css = buildOverlayStyles();
  assert.match(css, /\.panel|\.override-btn/);
  assert.match(css, /z-index:\s*2147483647/);
});

test('classic overlay script exposes its factory through the narrow global API', () => {
  assert.equal(typeof createInterventionOverlay, 'function');
});

test('createInterventionOverlay accepts onEndSession callback', () => {
  let called = false;
  // The factory function signature should accept onEndSession without throwing
  assert.doesNotThrow(() => {
    createInterventionOverlay({ onEndSession: () => { called = true; } });
  });
});

test('classic overlay refuses a pre-existing global API property', async () => {
  await assert.rejects(
    loadClassicScript(new URL('../intervention-overlay.js', import.meta.url), {
      IntentLock: { interventionOverlay: { occupied: true } },
    }),
    /IntentLock\.interventionOverlay is already defined/,
  );
});

test('fallback dismissal removes the lock tab only once for duplicate hide messages', async () => {
  let runtimeListener = null;
  let removeCount = 0;
  const makeElement = () => ({
    append: () => {},
    appendChild: () => {},
    setAttribute: () => {},
    textContent: '',
    className: '',
  });
  const context = await loadClassicScript(new URL('../intervention.js', import.meta.url), {
    chrome: {
      runtime: {
        lastError: null,
        onMessage: { addListener: (listener) => { runtimeListener = listener; } },
        sendMessage: (_message, callback) => callback?.({}),
      },
      tabs: {
        getCurrent: (callback) => callback({ id: 42 }),
        remove: (_tabId, callback) => {
          removeCount += 1;
          callback();
        },
      },
    },
    document: {
      addEventListener: () => {},
      querySelector: () => makeElement(),
      createElement: () => makeElement(),
    },
  });

  assert.ok(context);
  const responses = [];
  runtimeListener({ type: 'HIDE_INTERVENTION' }, {}, (response) => responses.push(response));
  runtimeListener({ type: 'HIDE_INTERVENTION' }, {}, (response) => responses.push(response));

  assert.equal(removeCount, 1);
  assert.equal(responses.length, 2);
  assert.equal(responses[0].hidden, true);
  assert.equal(responses[1].hidden, true);
});
