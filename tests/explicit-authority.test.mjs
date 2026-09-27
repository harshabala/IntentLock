import assert from 'node:assert/strict';
import test from 'node:test';

// Optional AI must never overrule an explicit allow or a related correction.
let fetchCalls = 0;
const shown = [];
const tabUpdated = [];
const tabs = new Map();
const storageData = {
  activeSession: { id: 'explicit', intent: 'write the quarterly budget memo', isActive: true, startTime: Date.now(), events: [] },
  trackingEnabled: true,
  heuristicPolicy: {
    version: 1, intentCategoryId: 'deep_work', strictness: 'balanced', setupCompleted: true,
    categoryPolicies: {}, customBlockDomains: [], customAllowDomains: ['allowed.example'],
  },
  relatedDomainMarks: { 'related.example': { count: 1, lastMarkedAt: Date.now() } },
  llmProviderConfig: { providerId: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1/chat/completions' },
};
const sessionData = { llmApiKey: 'sk-synthetic-authority' };

globalThis.fetch = async () => {
  fetchCalls += 1;
  return { ok: true, json: async () => ({ choices: [{ message: { content: '{"aligned": false, "confidence": 0.99}' } }] }) };
};

const area = (data) => ({
  get: (keys, cb) => {
    const list = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
    cb(Object.fromEntries(list.filter(k => k in data).map(k => [k, structuredClone(data[k])])));
  },
  set: (values, cb) => { Object.assign(data, structuredClone(values)); cb?.(); },
  remove: (keys, cb) => { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete data[k]); cb?.(); },
  clear: (cb) => { Object.keys(data).forEach(k => delete data[k]); cb?.(); },
});
const event = { addListener() {} };
globalThis.chrome = {
  idle: { setDetectionInterval() {}, onStateChanged: event },
  commands: { onCommand: event },
  runtime: { id: 'authority-test', lastError: undefined, onMessage: event, sendMessage() {}, getURL: p => `chrome-extension://authority-test/${p}` },
  alarms: { create() {}, clear() {}, onAlarm: event },
  tabs: {
    onUpdated: { addListener: fn => tabUpdated.push(fn) }, onActivated: event, onRemoved: event,
    get: (id, cb) => { const tab = tabs.get(id) || null; cb?.(tab); return Promise.resolve(tab); },
    query: (_q, cb) => { cb?.([]); return Promise.resolve([]); },
    sendMessage: (id, message, cb) => { if (message.type === 'SHOW_INTERVENTION') shown.push(id); cb?.({ shown: true }); },
    update: (_id, _props, cb) => cb?.(), group: () => Promise.resolve(1),
  },
  tabGroups: { update: () => Promise.resolve(), get: () => Promise.resolve() },
  storage: { local: area(storageData), session: area(sessionData), onChanged: event },
};

const { reloadConfig } = await import('../background.js');
await reloadConfig();
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

async function visit(id, url) {
  tabs.set(id, { id, url });
  for (const listener of tabUpdated) listener(id, { status: 'complete' }, { id, url });
  await settle();
}

test('explicit allow skips the AI second opinion and never locks', async () => {
  await visit(1, 'https://allowed.example/page');
  assert.equal(fetchCalls, 0);
  assert.deepEqual(shown, []);
});

test('related correction skips the AI second opinion and never locks', async () => {
  await visit(2, 'https://sub.related.example/page');
  assert.equal(fetchCalls, 0);
  assert.deepEqual(shown, []);
});

test('an unlisted site still gets the AI second opinion', async () => {
  await visit(3, 'https://unlisted.example/page');
  assert.equal(fetchCalls, 1);
  assert.deepEqual(shown, [3]);
});
