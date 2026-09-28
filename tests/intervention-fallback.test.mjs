import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createOverlayDocument } from './helpers/overlay-dom.mjs';

// Load the real fallback page script against a synthetic DOM.
async function loadFallback(stateReply) {
  const { document } = createOverlayDocument();
  const container = document.createElement('main');
  container.className = 'lock-container';
  document.body.appendChild(container);
  for (const [id, tag] of [['intervention-title', 'h1'], ['reason-text', 'p'], ['current-intent', 'p'],
    ['reflection-input', 'textarea'], ['return-btn', 'button'], ['override-btn', 'button'],
    ['end-session-btn', 'button'], ['reflection-form', 'form'], ['intentlock-mark-related', 'input'],
    ['transition-error', 'p'], ['lock-explanation', 'p']]) {
    const el = document.createElement(tag);
    el.id = id;
    container.appendChild(el);
  }
  document.querySelector = selector => document.body.querySelector(selector);
  let ready;
  document.addEventListener = (type, handler) => { if (type === 'DOMContentLoaded') ready = handler; };
  const location = { href: 'chrome-extension://x/intervention.html', reloads: 0, reload() { this.reloads += 1; } };
  const removed = [];
  const chrome = {
    runtime: {
      lastError: undefined,
      getURL: path => `chrome-extension://x/${path}`,
      onMessage: { addListener() {} },
      sendMessage(message, callback) {
        if (message.type === 'GET_SESSION') return callback({ session: { id: 's', intent: 'synthetic intent', isActive: true } });
        if (message.type === 'GET_INTERVENTION_STATE') {
          if (stateReply === 'runtime-error') {
            chrome.runtime.lastError = { message: 'Could not establish connection.' };
            callback(undefined);
            chrome.runtime.lastError = undefined;
            return;
          }
          return callback(stateReply);
        }
        callback({});
      },
    },
    tabs: { getCurrent: cb => cb({ id: 12 }), remove: (id, cb) => { removed.push(id); cb?.(); } },
  };
  const source = await readFile(new URL('../intervention.js', import.meta.url), 'utf8');
  const context = vm.createContext({ document, chrome, location, console, globalThis: null });
  context.globalThis = context;
  vm.runInContext(source, context);
  await ready();
  const buttons = () => container.querySelectorAll('button').map(b => b.textContent);
  const click = label => container.querySelectorAll('button').find(b => b.textContent === label).click();
  return { container, location, removed, buttons, click, title: () => container.querySelector('#intervention-title')?.textContent };
}

test('a failed lock lookup offers a retry instead of a dead lock', async () => {
  for (const reply of ['runtime-error', { ok: false, error: 'Data changed' }]) {
    const page = await loadFallback(reply);
    assert.equal(page.title(), 'Could not load this lock');
    assert.deepEqual(page.buttons(), ['Try again', 'Close this tab']);
    page.click('Try again');
    assert.equal(page.location.reloads, 1);
  }
});

test('an expired lock offers independent close and new-session actions', async () => {
  const page = await loadFallback({ ok: true, state: null });
  assert.equal(page.title(), 'This lock is no longer active');
  assert.deepEqual(page.buttons(), ['Close this tab', 'Start a new session']);
  page.click('Start a new session');
  assert.equal(page.location.href, 'chrome-extension://x/newtab.html');
  page.click('Close this tab');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(page.removed, [12]);
});

test('a live lock keeps its reflection controls', async () => {
  const page = await loadFallback({ ok: true, state: { sessionId: 's', nonce: 'n', reason: 'Time budget exceeded.' } });
  assert.equal(page.title(), 'Time budget exceeded.');
  assert.match(page.container.querySelector('#lock-explanation').textContent, /budget has run out/);
  assert.ok(page.buttons().includes('Continue anyway') || page.container.querySelector('#override-btn'));
});
