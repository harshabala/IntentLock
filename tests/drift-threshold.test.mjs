import assert from 'node:assert/strict';
import test from 'node:test';
import { DRIFT_CONFIDENCE_THRESHOLD } from '../drift.js';

test('DRIFT_CONFIDENCE_THRESHOLD is 0.7', () => {
  assert.equal(DRIFT_CONFIDENCE_THRESHOLD, 0.7);
});

test('LLM drift below confidence threshold does not trigger intervention', async () => {
  let tabsUpdateCalls = [];
  const tabUpdatedListeners = [];
  let storageData = {
    activeSession: {
      id: 'session-123',
      intent: 'Write the quarterly report',
      isActive: true,
      startTime: Date.now(),
      events: [],
    },
    customDistractionSites: [],
    trackingEnabled: true,
    llmProviderConfig: {
      providerId: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      authType: 'bearer',
      apiStyle: 'openai',
    },
  };

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: '{"aligned": false, "confidence": 0.45}',
        },
      }],
    }),
  });

  globalThis.chrome = {
    idle: { setDetectionInterval: () => {}, onStateChanged: { addListener: () => {} } },
    commands: { onCommand: { addListener: () => {} } },
    runtime: {
      onMessage: { addListener: () => {} },
      getURL: (path) => `chrome-extension://mock/${path}`,
    },
    alarms: { create: () => {}, clear: () => {}, onAlarm: { addListener: () => {} } },
    tabs: {
      onUpdated: {
        addListener: (listener) => tabUpdatedListeners.push(listener),
      },
      onActivated: { addListener: () => {} },
      get: (tabId, cb) => cb({ id: tabId, url: 'https://news.example.com/article' }),
      update: (tabId, props, cb) => {
        tabsUpdateCalls.push({ tabId, updateProperties: props });
        if (cb) cb();
      },
      group: () => Promise.resolve(456),
    },
    tabGroups: { update: () => Promise.resolve(), get: () => Promise.resolve() },
    storage: {
      session: {
        get: (_keys, cb) => cb({ llmApiKey: 'sk-test-key' }),
        set: (_data, cb) => { if (cb) cb(); },
        remove: (_keys, cb) => { if (cb) cb(); },
      },
      local: {
        get: (keys, cb) => {
          const res = {};
          const keysArr = Array.isArray(keys) ? keys : [keys];
          for (const key of keysArr) {
            if (storageData[key] !== undefined) res[key] = storageData[key];
          }
          cb(res);
        },
        set: (data, cb) => {
          Object.assign(storageData, data);
          if (cb) cb();
        },
        remove: (keys, cb) => {
          const keysArr = Array.isArray(keys) ? keys : [keys];
          for (const k of keysArr) delete storageData[k];
          if (cb) cb();
        },
      },
    },
  };

  const { reloadConfig } = await import('../background.js');
  await reloadConfig();

  for (const listener of tabUpdatedListeners) {
    listener(1, { status: 'complete' }, { url: 'https://news.example.com/article' });
  }

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(tabsUpdateCalls.length, 0, 'sub-threshold LLM drift should not trigger intervention');
});