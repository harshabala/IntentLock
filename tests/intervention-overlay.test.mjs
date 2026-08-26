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

test('overlay styles include overlayEnter 160ms and no infinite animation', () => {
  const css = buildOverlayStyles();
  assert.match(css, /overlayEnter/);
  assert.match(css, /160ms/);
  assert.match(css, /scale\(0\.98\)/);
  assert.equal(/\binfinite\b/.test(css), false);
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

test('creating overlay does not throw', () => {
  assert.doesNotThrow(() => createInterventionOverlay({
    onOverride() {},
    onCloseTab() {},
    onEndSession() {},
  }));
});

test('classic overlay refuses a pre-existing global API property', async () => {
  await assert.rejects(
    loadClassicScript(new URL('../intervention-overlay.js', import.meta.url), {
      IntentLock: { interventionOverlay: { occupied: true } },
    }),
    /IntentLock\.interventionOverlay is already defined/,
  );
});
