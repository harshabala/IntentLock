import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createClassicContext, runClassicScript } from './helpers/load-classic-script.mjs';

const root = new URL('../', import.meta.url);

test('manifest-ordered classic scripts bootstrap content tracking in one VM context', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  const calls = {
    storageGets: [],
    storageChangedListeners: [],
    runtimeMessageListeners: [],
    documentListeners: new Map(),
    windowListeners: new Map(),
    intervals: 0,
  };

  const chrome = {
    storage: {
      local: {
        get(keys, callback) {
          calls.storageGets.push(keys);
          callback({ activeSession: { isActive: true }, trackingEnabled: true });
        },
      },
      onChanged: {
        addListener(listener) {
          calls.storageChangedListeners.push(listener);
        },
      },
    },
    runtime: {
      lastError: null,
      sendMessage() {},
      onMessage: {
        addListener(listener) {
          calls.runtimeMessageListeners.push(listener);
        },
      },
    },
  };
  const document = {
    hidden: false,
    title: 'Example',
    addEventListener(type, listener) {
      calls.documentListeners.set(type, listener);
    },
    removeEventListener(type) {
      calls.documentListeners.delete(type);
    },
  };
  const window = {
    addEventListener(type, listener) {
      calls.windowListeners.set(type, listener);
    },
    removeEventListener(type) {
      calls.windowListeners.delete(type);
    },
  };
  const history = {
    pushState() {},
    replaceState() {},
  };
  const context = createClassicContext({
    chrome,
    document,
    window,
    history,
    location: { href: 'https://example.test/' },
    setInterval() {
      calls.intervals += 1;
      return calls.intervals;
    },
    clearInterval() {},
  });

  for (const script of manifest.content_scripts[0].js) {
    await runClassicScript(new URL(script, root), context);
  }

  assert.deepEqual(Object.keys(context.IntentLock), ['pageTracker', 'interventionOverlay']);
  assert.equal(calls.storageChangedListeners.length, 1);
  assert.equal(calls.runtimeMessageListeners.length, 1);
  assert.equal(calls.storageGets.length, 1);
  assert.deepEqual(Array.from(calls.storageGets[0]), ['activeSession', 'trackingEnabled']);
  assert.ok(calls.documentListeners.has('visibilitychange'));
  assert.ok(calls.windowListeners.has('beforeunload'));
  assert.ok(calls.windowListeners.has('popstate'));
  assert.equal(calls.intervals, 1);
});
