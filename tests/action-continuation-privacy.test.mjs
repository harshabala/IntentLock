import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { privacyChrome, until } from './helpers/privacy-chrome.mjs';
import { createOverlayDocument } from './helpers/overlay-dom.mjs';
import * as client from '../storage-client.js';
import * as policy from '../heuristic-policy.js';
import * as logs from '../error-log.js';
import * as privacy from '../privacy-utils.js';
import * as metrics from '../session-metrics.js';

const h = privacyChrome();
globalThis.chrome = h.chrome;
await import('../background.js');
await h.send({ type: 'CONFIG_UPDATED' });
await client.initializeStorageClient();
const button = (root, text) => root.querySelectorAll('button').find(el => el.textContent === text);

async function loadPage(file = 'newtab.js') {
  const { document, matchMedia } = createOverlayDocument();
  const create = document.createElement;
  document.createElement = tag => {
    const el = create(tag);
    el.removeChild = child => { el.children = el.children.filter(node => node !== child); child.parentNode = null; };
    el.remove = () => el.parentNode?.removeChild(el);
    return el;
  };
  document.body.removeChild = child => { document.body.children = document.body.children.filter(node => node !== child); child.parentNode = null; };
  document.querySelector = selector => document.body.querySelector(selector);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  const keydown = new Set();
  document.removeEventListener = (type, handler) => { if (type === 'keydown') keydown.delete(handler); };
  document.pressKey = (key, shiftKey = false) => {
    const event = { key, shiftKey, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const handler of [...keydown]) handler(event);
    return event;
  };
  const container = document.createElement('main');
  container.className = 'lock-container';
  container.id = 'content';
  document.body.appendChild(container);
  let ready;
  document.addEventListener = (type, handler) => {
    if (type === 'DOMContentLoaded') ready = handler;
    if (type === 'keydown') keydown.add(handler);
  };
  const context = vm.createContext({
    ...client, ...policy, ...logs, ...privacy, ...metrics, document, chrome: h.chrome,
    window: { matchMedia, close() {} }, location: { search: '' }, URLSearchParams, crypto, console,
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1,
    requestAnimationFrame: callback => callback(),
  });
  const onboarding = await readFile(new URL('../onboarding.js', import.meta.url), 'utf8');
  vm.runInContext(onboarding.replace(/^import[\s\S]*?;\n/gm, '').replace('export function', 'function'), context);
  const source = await readFile(new URL('../' + file, import.meta.url), 'utf8');
  vm.runInContext(source.replace(/^import[\s\S]*?;\n/gm, ''), context);
  await ready();
  return { document, container };
}

for (const type of ['SESSION_STARTED', 'END_ACTIVE_SESSION']) {
  for (const delivery of ['after deletion', 'before deletion but before rendering']) {
    test(`newtab ${type} success ${delivery} never renders deleted intent`, async () => {
      await h.send({ type: 'DELETE_ALL_DATA' });
      h.local.hasSeenOnboarding = true;
      if (type === 'END_ACTIVE_SESSION') await client.sendStorageAction({
        type: 'SESSION_STARTED',
        session: { id: 'old-session', intent: 'synthetic deleted intent', isActive: true, startTime: Date.now(), events: [] },
      });
      const { document, container } = await loadPage();
      h.holdNextReply((message, response) => message.type === type && response?.status === 'ok');
      if (type === 'SESSION_STARTED') {
        document.getElementById('intent-input').value = 'synthetic deleted intent';
        document.getElementById('intent-form').dispatchEvent({ type: 'submit', preventDefault() {} });
      } else {
        button(container, 'End session').click();
        button(document.querySelector('.confirm-overlay'), 'End session').click();
      }
      await until(() => h.isReplyHeld);
      assert.ok(h.local.activeSession || h.local.sessionHistory?.length, 'action persisted before holding only its reply');
      if (delivery.startsWith('before')) {
        h.releaseReply();
        h.holdNext(op => op.area === 'local' && op.method === 'remove');
        const deleting = h.send({ type: 'DELETE_ALL_DATA' });
        await until(() => h.isHeld);
        const redisplayedDuringDeletion = container.textContent.includes('synthetic deleted intent');
        h.release();
        await deleting;
        assert.equal(redisplayedDuringDeletion, false, 'accepted reply must not render after the deletion fence');
      } else await h.send({ type: 'DELETE_ALL_DATA' });
      if (delivery.startsWith('after')) h.releaseReply();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(Object.keys(h.local), ['privacyMutationState']);
      assert.equal(container.textContent.includes('synthetic deleted intent'), false);
      assert.ok(document.getElementById('intent-form'), 'deletion leaves the fresh form visible');
    });
  }
}

for (const page of ['popup', 'onboarding']) test(`${page} ignores success accepted before deletion but rendered afterward`, async () => {
  await h.send({ type: 'DELETE_ALL_DATA' });
  h.local.hasSeenOnboarding = page !== 'onboarding';
  if (page === 'popup') await client.sendStorageAction({
    type: 'SESSION_STARTED', session: { id: 'popup-session', intent: 'synthetic intent', isActive: true, startTime: Date.now(), events: [] },
  });
  let reportTabs = 0;
  h.chrome.tabs.create = () => { reportTabs++; };
  const { document, container } = await loadPage(page === 'popup' ? 'popup.js' : 'newtab.js');
  h.holdNextReply((message, response) => response?.status === 'ok' &&
    message.type === (page === 'popup' ? 'END_ACTIVE_SESSION' : 'STORAGE_MUTATION'));
  if (page === 'popup') {
    button(container, 'End session').click();
    button(document.querySelector('.confirm-overlay'), 'End session').click();
  } else {
    button(container, 'Continue').click();
    button(container, 'Save and continue').click();
  }
  await until(() => h.isReplyHeld);
  h.releaseReply();
  h.holdNext(op => op.area === 'local' && op.method === 'remove');
  const deleting = h.send({ type: 'DELETE_ALL_DATA' });
  await until(() => h.isHeld);
  const rehearsal = Boolean(button(container, 'Got it'));
  h.release();
  await deleting;
  assert.equal(reportTabs, 0, 'obsolete end reply must not navigate to a report');
  assert.equal(rehearsal, false, 'obsolete onboarding reply must not replace the fresh form');
  assert.deepEqual(Object.keys(h.local), ['privacyMutationState']);
});

test('newtab rejects malformed time budgets without starting a session', async () => {
  await h.send({ type: 'DELETE_ALL_DATA' });
  h.local.hasSeenOnboarding = true;
  for (const value of ['12abc', 'abc', '1.5', '0', '481', '-5', '1e2']) {
    const { document } = await loadPage();
    document.getElementById('intent-input').value = 'synthetic budget intent';
    document.getElementById('time-budget').value = value;
    document.getElementById('intent-form').dispatchEvent({ type: 'submit', preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.local.activeSession, undefined, `${value} must not start a session`);
    assert.equal(document.getElementById('time-budget').getAttribute('aria-invalid'), 'true', value);
  }
  for (const [value, expected] of [['', null], [' 45 ', 45]]) {
    const { document } = await loadPage();
    document.getElementById('intent-input').value = 'synthetic budget intent';
    document.getElementById('time-budget').value = value;
    document.getElementById('intent-form').dispatchEvent({ type: 'submit', preventDefault() {} });
    await until(() => h.local.activeSession);
    assert.equal(h.local.activeSession.timeBudget, expected, JSON.stringify(value));
    await h.send({ type: 'DELETE_ALL_DATA' });
    h.local.hasSeenOnboarding = true;
  }
});

test('popup end dialog traps Tab, cancels on Escape and restores focus', async () => {
  await h.send({ type: 'DELETE_ALL_DATA' });
  await client.sendStorageAction({ type: 'SESSION_STARTED', session: {
    id: 'popup-keys', intent: 'synthetic intent', isActive: true, startTime: Date.now(), events: [] } });
  const { document, container } = await loadPage('popup.js');
  const end = button(container, 'End session');
  end.focus();
  end.click();
  const dialog = document.querySelector('.confirm-overlay');
  const cancel = button(dialog, 'Cancel');
  const confirm = button(dialog, 'End session');
  assert.equal(document.activeElement, cancel);
  assert.equal(document.pressKey('Tab').defaultPrevented, true);
  assert.equal(document.activeElement, confirm);
  document.pressKey('Tab');
  assert.equal(document.activeElement, cancel, 'Tab wraps to the first control');
  document.pressKey('Tab', true);
  assert.equal(document.activeElement, confirm, 'Shift+Tab wraps to the last control');
  document.pressKey('Escape');
  assert.equal(document.querySelector('.confirm-overlay'), null);
  assert.equal(document.activeElement, end, 'focus returns to End session');
  assert.equal(h.local.activeSession?.id, 'popup-keys', 'Escape cancels without ending');
  assert.equal(document.pressKey('Tab').defaultPrevented, false, 'the trap is released after closing');
  await h.send({ type: 'DELETE_ALL_DATA' });
});
