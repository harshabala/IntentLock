import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOverlayStyles, createInterventionOverlay } from '../intervention-overlay.js';

test('buildOverlayStyles includes core intervention layout rules', () => {
  const css = buildOverlayStyles();
  assert.match(css, /\.panel|\.override-btn/);
  assert.match(css, /z-index:\s*2147483647/);
});

test('createInterventionOverlay is exported factory function', () => {
  assert.equal(typeof createInterventionOverlay, 'function');
});