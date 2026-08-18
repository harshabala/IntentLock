import assert from 'node:assert/strict';
import test from 'node:test';
import { createClassicContext, runClassicScript } from './helpers/load-classic-script.mjs';

const pageTrackerUrl = new URL('../page-tracker.js', import.meta.url);
const interventionOverlayUrl = new URL('../intervention-overlay.js', import.meta.url);

for (const [name, scriptUrl, property] of [
  ['page tracker', pageTrackerUrl, 'pageTracker'],
  ['intervention overlay', interventionOverlayUrl, 'interventionOverlay'],
]) {
  test(`${name} refuses an existing non-object IntentLock without replacing it`, async () => {
    const context = createClassicContext({ IntentLock: undefined });

    await assert.rejects(
      runClassicScript(scriptUrl, context),
      /IntentLock global must be an object/,
    );
    assert.equal(context.IntentLock, undefined);
  });

  test(`${name} preserves an occupied namespace property`, async () => {
    const occupied = { occupied: true };
    const namespace = { [property]: occupied };
    const context = createClassicContext({ IntentLock: namespace });

    await assert.rejects(
      runClassicScript(scriptUrl, context),
      new RegExp(`IntentLock\\.${property} is already defined`),
    );
    assert.equal(context.IntentLock, namespace);
    assert.equal(context.IntentLock[property], occupied);
  });
}
