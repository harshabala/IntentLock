import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

function makeChrome(initialStorage = {}, initialTabs = {}) {
  const storageData = structuredClone(initialStorage);
  const sessionStorageData = {};
  const listeners = {
    messages: [],
    tabRemoved: [],
  };
  const calls = {
    tabMessages: [],
    tabUpdates: [],
    tabCreates: [],
    tabRemoves: [],
  };
  const tabs = new Map(Object.entries(initialTabs).map(([id, tab]) => [Number(id), { id: Number(id), ...tab }]));
  let nextTabId = Math.max(0, ...tabs.keys()) + 1;

  function keysFor(keys) {
    if (keys === null || keys === undefined) return Object.keys(storageData);
    if (typeof keys === 'string') return [keys];
    if (Array.isArray(keys)) return keys;
    return Object.keys(keys);
  }

  const local = {
    get(keys, callback) {
      const result = {};
      for (const key of keysFor(keys)) {
        if (storageData[key] !== undefined) result[key] = structuredClone(storageData[key]);
      }
      callback(result);
    },
    set(values, callback) {
      Object.assign(storageData, structuredClone(values));
      callback?.();
    },
    remove(keys, callback) {
      for (const key of keysFor(keys)) delete storageData[key];
      callback?.();
    },
  };

  const chrome = {
    idle: { setDetectionInterval() {}, onStateChanged: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    runtime: {
      lastError: undefined,
      getURL: (path) => `chrome-extension://mock/${path}`,
      sendMessage() {},
      onMessage: { addListener(listener) { listeners.messages.push(listener); } },
    },
    alarms: {
      create() {},
      clear(_name, callback) { callback?.(true); },
      onAlarm: { addListener() {} },
    },
    tabs: {
      onUpdated: { addListener() {} },
      onActivated: { addListener() {} },
      onRemoved: { addListener(listener) { listeners.tabRemoved.push(listener); } },
      query(_query, callback) {
        const result = [...tabs.values()];
        callback?.(result);
        return Promise.resolve(result);
      },
      get(tabId, callback) {
        const tab = tabs.get(tabId);
        if (tab) callback?.(tab);
        else {
          chrome.runtime.lastError = { message: 'No tab with id' };
          callback?.();
          chrome.runtime.lastError = undefined;
        }
        return Promise.resolve(tab);
      },
      sendMessage(tabId, message, callback) {
        calls.tabMessages.push({ tabId, message });
        callback?.({ shown: true });
        return Promise.resolve({ shown: true });
      },
      update(tabId, updateProperties, callback) {
        calls.tabUpdates.push({ tabId, updateProperties });
        const tab = tabs.get(tabId) || { id: tabId };
        Object.assign(tab, updateProperties);
        tabs.set(tabId, tab);
        callback?.(tab);
        return Promise.resolve(tab);
      },
      create(createProperties, callback) {
        const tab = { id: nextTabId++, ...createProperties };
        tabs.set(tab.id, tab);
        calls.tabCreates.push({ tab });
        callback?.(tab);
        return Promise.resolve(tab);
      },
      remove(tabId, callback) {
        calls.tabRemoves.push(tabId);
        tabs.delete(tabId);
        for (const listener of listeners.tabRemoved) listener(tabId, { isWindowClosing: false });
        callback?.();
        return Promise.resolve();
      },
      group() { return Promise.resolve(456); },
    },
    tabGroups: { update() { return Promise.resolve(); }, get() { return Promise.resolve(); } },
    storage: {
      local,
      session: {
        get(keys, callback) {
          const result = {};
          for (const key of keysFor(keys)) {
            if (sessionStorageData[key] !== undefined) result[key] = sessionStorageData[key];
          }
          callback(result);
        },
        set(values, callback) { Object.assign(sessionStorageData, values); callback?.(); },
        remove(keys, callback) { for (const key of keysFor(keys)) delete sessionStorageData[key]; callback?.(); },
      },
      onChanged: { addListener() {} },
    },
  };

  return { chrome, storageData, listeners, calls, tabs };
}

async function loadBackground(initialStorage = {}, initialTabs = {}) {
  const harness = makeChrome(initialStorage, initialTabs);
  globalThis.chrome = harness.chrome;
  const module = await import(`../background.js?intervention-state=${Date.now()}-${Math.random()}`);
  await module.reloadConfig();

  async function send(message, sender = {}) {
    let response;
    await Promise.all(listenersFor(harness).map((listener) => new Promise((resolve) => {
      const result = listener(message, sender, (value) => {
        response = value;
        resolve();
      });
      if (result !== true) resolve();
    })));
    return response;
  }

  return { ...harness, module, send };
}

function listenersFor(harness) {
  return harness.listeners.messages;
}

async function readText(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('interventions are scoped per session/tab and carry a nonce', async () => {
  const harness = await loadBackground(
    { activeSession: { id: 'session-1', intent: 'write', isActive: true, startTime: 1, events: [] } },
    {
      1: { url: 'https://example.test/one' },
      2: { url: 'https://example.test/two' },
    },
  );

  await harness.module.triggerIntervention('first', 1);
  await harness.module.triggerIntervention('second', 2);

  const states = Object.values(harness.storageData.interventionStates || {});
  assert.equal(states.length, 2);
  assert.deepEqual(states.map((state) => state.originalTabId).sort(), [1, 2]);
  assert.ok(states.every((state) => state.sessionId === 'session-1' && state.nonce));
  assert.equal(harness.storageData.interventionState, undefined, 'legacy global state must not be used');
  assert.deepEqual(
    harness.calls.tabMessages.map(({ tabId, message }) => [tabId, message.nonce]),
    states.map((state) => [state.originalTabId, state.nonce]),
  );
});

test('restart-safe state can be rehydrated for the requesting tab only', async () => {
  const state = {
    sessionId: 'session-1',
    nonce: 'nonce-1',
    reason: 'drift',
    originalTabId: 7,
    originalUrl: 'https://example.test/work',
    mode: 'overlay',
    timestamp: 10,
  };
  const harness = await loadBackground(
    {
      activeSession: { id: 'session-1', intent: 'work', isActive: true, startTime: 1, events: [] },
      interventionStates: { 'session-1:7': state },
    },
    { 7: { url: state.originalUrl }, 8: { url: 'https://example.test/other' } },
  );

  const matching = await harness.send({ type: 'GET_INTERVENTION_STATE' }, { tab: { id: 7 } });
  const wrongTab = await harness.send({ type: 'GET_INTERVENTION_STATE' }, { tab: { id: 8 } });
  assert.deepEqual(matching, { ok: true, state });
  assert.deepEqual(wrongTab, { ok: true, state: null });
});

test('stale or wrong-tab transitions are rejected without changing the session', async () => {
  const session = { id: 'session-1', intent: 'work', isActive: true, startTime: 1, events: [] };
  const state = {
    sessionId: 'session-1',
    nonce: 'nonce-1',
    reason: 'drift',
    originalTabId: 7,
    originalUrl: 'https://example.test/work',
    mode: 'overlay',
    timestamp: 10,
  };
  const harness = await loadBackground(
    { activeSession: session, interventionStates: { 'session-1:7': state } },
    { 7: { url: state.originalUrl }, 8: { url: 'https://example.test/other' } },
  );

  const stale = await harness.send({
    type: 'INTERVENTION_TRANSITION',
    transition: 'override',
    sessionId: 'session-1',
    nonce: 'wrong-nonce',
    reflection: 'stale',
  }, { tab: { id: 7 } });
  const wrongTab = await harness.send({
    type: 'INTERVENTION_TRANSITION',
    transition: 'override',
    sessionId: 'session-1',
    nonce: 'nonce-1',
    reflection: 'wrong tab',
  }, { tab: { id: 8 } });

  assert.equal(stale.ok, false);
  assert.equal(wrongTab.ok, false);
  assert.equal(harness.storageData.activeSession.isActive, true);
  assert.deepEqual(harness.storageData.activeSession.events, []);
  assert.ok(harness.storageData.interventionStates['session-1:7']);
});

test('end-session transition and repeated end are idempotent', async () => {
  const harness = await loadBackground({
    activeSession: { id: 'session-1', intent: 'work', isActive: true, startTime: 1, events: [] },
    interventionStates: {
      'session-1:7': {
        sessionId: 'session-1', nonce: 'nonce-1', reason: 'drift', originalTabId: 7,
        originalUrl: 'https://example.test/work', mode: 'overlay', timestamp: 10,
      },
    },
    sessionHistory: [],
  }, { 7: { url: 'https://example.test/work' } });

  const first = await harness.send({
    type: 'INTERVENTION_TRANSITION',
    transition: 'end-session',
    sessionId: 'session-1',
    nonce: 'nonce-1',
  }, { tab: { id: 7 } });
  const second = await harness.send({
    type: 'END_ACTIVE_SESSION',
  }, { tab: { id: 7 } });

  assert.equal(first.ok, true);
  assert.equal(second.status, 'ok');
  assert.equal(harness.storageData.activeSession, undefined);
  assert.equal(harness.storageData.sessionHistory.length, 1, 'session must be finalized once');
  assert.equal(harness.storageData.interventionStates, undefined);
});

test('repeating the same nonce-bound end-session transition is an idempotent success', async () => {
  const message = {
    type: 'INTERVENTION_TRANSITION',
    transition: 'end-session',
    sessionId: 'session-1',
    nonce: 'nonce-1',
  };
  const harness = await loadBackground({
    activeSession: { id: 'session-1', intent: 'work', isActive: true, startTime: 1, events: [] },
    interventionStates: {
      'session-1:7': {
        sessionId: 'session-1', nonce: 'nonce-1', reason: 'drift', originalTabId: 7,
        originalUrl: 'https://example.test/work', mode: 'overlay', timestamp: 10,
      },
    },
    sessionHistory: [],
  }, { 7: { url: 'https://example.test/work' } });

  const first = await harness.send(message, { tab: { id: 7 } });
  const second = await harness.send(message, { tab: { id: 7 } });

  assert.equal(first.ok, true);
  assert.deepEqual(second, {
    ok: true,
    transition: 'end-session',
    idempotent: true,
    closeTab: false,
  });
});

test('close-tab keeps the intervention state when Chrome cannot close the tab', async () => {
  const harness = await loadBackground({
    activeSession: { id: 'session-1', intent: 'work', isActive: true, startTime: 1, events: [] },
    interventionStates: {
      'session-1:7': {
        sessionId: 'session-1', nonce: 'nonce-1', reason: 'drift', originalTabId: 7,
        originalUrl: 'https://example.test/work', mode: 'overlay', timestamp: 10,
      },
    },
  }, { 7: { url: 'https://example.test/work' } });
  harness.chrome.tabs.remove = (_tabId, callback) => {
    harness.chrome.runtime.lastError = { message: 'tab could not be closed' };
    callback?.();
    harness.chrome.runtime.lastError = undefined;
  };

  const response = await harness.send({
    type: 'INTERVENTION_TRANSITION',
    transition: 'close-tab',
    sessionId: 'session-1',
    nonce: 'nonce-1',
  }, { tab: { id: 7 } });

  assert.equal(response.ok, false);
  assert.match(response.error, /could not be closed/);
  assert.ok(harness.storageData.interventionStates['session-1:7']);
  assert.equal(harness.storageData.activeSession.isActive, true);
});

test('removing a tab cleans only its intervention state', async () => {
  const harness = await loadBackground({
    activeSession: { id: 'session-1', intent: 'work', isActive: true, startTime: 1, events: [] },
    interventionStates: {
      'session-1:7': { sessionId: 'session-1', nonce: 'a', originalTabId: 7, originalUrl: 'https://a.test', mode: 'overlay', timestamp: 1 },
      'session-1:8': { sessionId: 'session-1', nonce: 'b', originalTabId: 8, originalUrl: 'https://b.test', mode: 'overlay', timestamp: 1 },
    },
  }, { 7: { url: 'https://a.test' }, 8: { url: 'https://b.test' } });

  for (const listener of harness.listeners.tabRemoved) listener(7, { isWindowClosing: false });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.storageData.interventionStates['session-1:7'], undefined);
  assert.ok(harness.storageData.interventionStates['session-1:8']);
});

test('triggerIntervention state includes intent matching the session', async () => {
  const harness = await loadBackground(
    { activeSession: { id: 'session-1', intent: 'write the report', isActive: true, startTime: 1, events: [] } },
    { 1: { url: 'https://example.test/one' } },
  );

  const state = await harness.module.triggerIntervention('first', 1);
  assert.equal(state.intent, 'write the report');
  const stored = Object.values(harness.storageData.interventionStates || {});
  assert.equal(stored[0].intent, 'write the report');
});

test('second triggerIntervention for a pending tab retries display', async () => {
  const harness = await loadBackground(
    {
      activeSession: {
        id: 'session-1',
        intent: 'write',
        isActive: true,
        startTime: 1,
        events: [],
        metrics: { interventionCount: 2, overrideCount: 0 },
      },
      interventionStates: {
        'session-1:7': {
          sessionId: 'session-1',
          nonce: 'nonce-pending',
          reason: 'drift',
          originalTabId: 7,
          originalUrl: 'https://example.test/work',
          mode: 'pending',
          timestamp: 10,
        },
      },
    },
    { 7: { url: 'https://example.test/work' } },
  );

  const state = await harness.module.triggerIntervention('retry this lock', 7);
  assert.equal(state.mode, 'overlay');
  assert.equal(state.nonce, 'nonce-pending');
  assert.equal(harness.storageData.activeSession.metrics.interventionCount, 2);
  assert.equal(harness.calls.tabMessages.length, 1);
  assert.equal(harness.calls.tabMessages[0].message.type, 'SHOW_INTERVENTION');
  assert.equal(harness.calls.tabMessages[0].tabId, 7);
});

test('override reflection longer than 2000 is stored truncated', async () => {
  const harness = await loadBackground({
    activeSession: { id: 'session-1', intent: 'work', isActive: true, startTime: 1, events: [] },
    interventionStates: {
      'session-1:7': {
        sessionId: 'session-1', nonce: 'nonce-1', reason: 'drift', originalTabId: 7,
        originalUrl: 'https://example.test/work', mode: 'overlay', timestamp: 10,
      },
    },
  }, { 7: { url: 'https://example.test/work' } });

  const reflection = 'x'.repeat(2500);
  const response = await harness.send({
    type: 'INTERVENTION_TRANSITION',
    transition: 'override',
    sessionId: 'session-1',
    nonce: 'nonce-1',
    reflection,
  }, { tab: { id: 7 } });

  assert.equal(response.ok, true);
  const stored = harness.storageData.activeSession.events.at(-1).reflection;
  assert.equal(stored.length, 2000);
  assert.equal(stored, 'x'.repeat(2000));
});

test('fallback and overlay expose the same authoritative controls', async () => {
  const [overlay, content, intervention, html] = await Promise.all([
    readText('intervention-overlay.js'),
    readText('content.js'),
    readText('intervention.js'),
    readText('intervention.html'),
  ]);

  for (const source of [overlay, content, intervention]) {
    assert.match(source, /INTERVENTION_TRANSITION/);
    assert.match(source, /mark-related|markRelated/);
    assert.match(source, /end-session|endSession/);
  }
  assert.doesNotMatch(overlay, /Dismiss/);
  assert.doesNotMatch(content, /OVERLAY_DISMISS/);
  assert.match(html, /intentlock-mark-related/);
  assert.match(html, /end-session|end-session-btn/);
});
