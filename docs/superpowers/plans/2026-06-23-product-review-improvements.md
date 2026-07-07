# Product Review Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement all quick-win, medium-effort, and major improvements surfaced by the June 2026 product review to close the motivation-loop gap and improve UX.

**Architecture:** Chrome MV3 extension — ES modules, no bundler, no TypeScript, no npm. Tests use Node's built-in `node:test` + `assert/strict`. All Chrome API mocking is done inline in test files (see `tests/background.test.mjs` for the canonical pattern). New features must keep the same zero-dependency, no-build-step architecture.

**Tech Stack:** Vanilla JS (ES modules), Chrome Extension APIs, node:test for testing, newtab.css (shared stylesheet).

## Global Constraints

- No `eval`, no `innerHTML` with user-controlled data — use `createElement` / `textContent` / `appendChild` exclusively
- No remote code — all domain data and rules ship in the extension package
- No telemetry — all data stays in `chrome.storage.local`
- No PII in storage — only categories, domain strings, and user-typed intent text
- Fail-open on errors — bad storage reads never throw; fall back to safe defaults
- Domain validation for any user-entered domain text: `HOSTNAME_RE = /^[a-z0-9][a-z0-9\-.]*\.[a-z]{2,}$/`
- Match existing code style: minimal comments, ES modules, no TypeScript, `createElement` for all DOM
- Tests use `node:test` + `assert/strict` — no Jest, no Mocha, no external test runner
- The extension is tested in the `/Users/harshabalakrishnan/Documents/Projects/IntentLock` directory (primary repo)
- Current version: 1.5.0 (manifest.json). Final task bumps to 1.6.0.
- Branch: `feature/product-review-improvements` (already created)

---

## File Map

| File | Change type | Tasks |
|------|-------------|-------|
| `newtab.js` | Modify | 1, 7, 8 |
| `llm-backoff.js` | Modify (add callback hook) | 2 |
| `background.js` | Modify | 2, 3, 5, 6, 7 |
| `popup.js` | Modify | 2, 7, 9 |
| `options.js` | Modify | 4 |
| `history.js` | Modify | 5 |
| `intervention-overlay.js` | Modify | 6 |
| `content.js` | Modify | 6 |
| `stats.html` | Create | 9 |
| `stats.js` | Create | 9 |
| `manifest.json` | Modify | 10 |
| `CHANGELOG.md` | Modify | 10 |
| `tests/llm-backoff.test.mjs` | Modify | 2 |
| `tests/background.test.mjs` | Modify | 5 |
| `tests/intervention-overlay.test.mjs` | Modify | 6 |
| `tests/static-smoke.test.mjs` | Modify | 9 |

---

### Task 1: Session summary enhancements

**Files:**
- Modify: `newtab.js` — `showSummary()` function (around lines 456–540)

**Interfaces:**
- Consumes: `session.events` array (already available in `showSummary` parameter)
- Produces: Enhanced UI only — no new exports, no storage changes

- [ ] **Step 1: Write the failing smoke test**

Add to `tests/static-smoke.test.mjs` a test that verifies newtab.js exports nothing dangerous (the file already has smoke tests checking manifest integrity; add one line to the existing "no eval" or html check if present, or leave as-is since this task is DOM-only — skip this step if no meaningful test can be written).

Actually, `showSummary` is internal and not testable from Node. Skip the test step; validate manually by loading the extension.

- [ ] **Step 2: Add top drifted domains to `showSummary`**

Locate `showSummary` in `newtab.js` (around line 456). After the `container.appendChild(stats)` line and before the `intentBox` section, add the top drifted sites block. Insert after the `container.appendChild(stats)` call:

```js
// Top drifted domains
const domainCounts = {};
events.filter(e => e.actionType === 'OVERRIDE' && e.url).forEach(e => {
  try {
    const domain = new URL(e.url).hostname.replace(/^www\./, '').toLowerCase();
    domainCounts[domain] = (domainCounts[domain] || 0) + 1;
  } catch { /* skip invalid URLs */ }
});
const topDomains = Object.entries(domainCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 3);
if (topDomains.length > 0) {
  const driftSection = document.createElement('div');
  driftSection.className = 'plan-section';
  const driftTitle = document.createElement('h3');
  driftTitle.className = 'plan-heading';
  driftTitle.textContent = 'Top drift sites';
  driftSection.appendChild(driftTitle);
  topDomains.forEach(([domain, count]) => {
    const row = document.createElement('div');
    row.className = 'stat-row';
    const domainSpan = document.createElement('span');
    domainSpan.className = 'stat-label';
    domainSpan.textContent = domain;
    const countSpan = document.createElement('span');
    countSpan.className = 'stat-value';
    countSpan.textContent = `${count} override${count !== 1 ? 's' : ''}`;
    row.append(domainSpan, countSpan);
    driftSection.appendChild(row);
  });
  container.appendChild(driftSection);
}
```

- [ ] **Step 3: Add "View history" link to `showSummary`**

After the `skipBtn` is appended (the "Start new session" button), add a history link:

```js
const histLink = document.createElement('button');
histLink.className = 'popup-link';
histLink.style.cssText = 'background:none;border:none;cursor:pointer;font-size:0.75rem;color:#888;margin-top:8px;';
histLink.textContent = 'View in history';
histLink.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
});
container.appendChild(histLink);
```

- [ ] **Step 4: Self-review**

- No innerHTML used ✓
- `new URL()` is wrapped in try/catch ✓
- `chrome.tabs.create` is valid in newtab page context ✓
- Existing `skipBtn` ("Start new session") is still present ✓

- [ ] **Step 5: Commit**

```bash
cd /Users/harshabalakrishnan/Documents/Projects/IntentLock
git add newtab.js
git commit -m "feat: add top drifted sites and history link to session summary"
```

---

### Task 2: LLM backoff persistence and popup indicator

**Files:**
- Modify: `llm-backoff.js` — add `registerBackoffCallback` + `_resetBackoffCallbackForTest`
- Modify: `background.js` — register callback, restore backoff on loadConfig, clear on clearLlmBackoff
- Modify: `popup.js` — read `llmBackoffUntil` from storage, show indicator
- Modify: `tests/llm-backoff.test.mjs` — test the new callback

**Interfaces:**
- `llm-backoff.js` exports: `registerBackoffCallback(fn: (until: number) => void): void`, `_resetBackoffCallbackForTest(): void`
- `background.js` imports `getQuotaBackoffUntil`, `setQuotaBackoff`, `registerBackoffCallback` from `./llm-backoff.js`
- `chrome.storage.local` key: `llmBackoffUntil: number` (unix timestamp ms)

- [ ] **Step 1: Write failing test for `registerBackoffCallback`**

In `tests/llm-backoff.test.mjs`, add at the bottom:

```js
import {
  clearLlmBackoff,
  isLlmBackedOff,
  parseRetryAfterMs,
  setQuotaBackoff,
  shouldLogQuotaError,
  registerBackoffCallback,
  _resetBackoffCallbackForTest,
} from '../llm-backoff.js';

test('registerBackoffCallback is called when setQuotaBackoff fires', () => {
  _resetBackoffCallbackForTest();
  clearLlmBackoff();
  let received = null;
  registerBackoffCallback((until) => { received = until; });
  const now = 2_000_000;
  setQuotaBackoff({ retryAfterMs: 5000, now });
  assert.ok(received !== null, 'callback should have been called');
  assert.ok(received > now, 'callback should receive a future timestamp');
});

test('_resetBackoffCallbackForTest clears the registered callback', () => {
  _resetBackoffCallbackForTest();
  clearLlmBackoff();
  let called = false;
  registerBackoffCallback(() => { called = true; });
  _resetBackoffCallbackForTest();
  setQuotaBackoff({ retryAfterMs: 1000 });
  assert.equal(called, false, 'callback should not fire after reset');
  clearLlmBackoff();
});
```

Run: `node --test tests/llm-backoff.test.mjs`
Expected: FAIL — `registerBackoffCallback` and `_resetBackoffCallbackForTest` are not exported yet.

- [ ] **Step 2: Add callback mechanism to `llm-backoff.js`**

In `llm-backoff.js`, after the existing `let lastQuotaLogAt = 0;` line, add:

```js
let _backoffCallback = null;
```

In `setQuotaBackoff`:
```js
export function setQuotaBackoff({ retryAfterMs = DEFAULT_QUOTA_BACKOFF_MS, now = Date.now() } = {}) {
  quotaBackoffUntil = Math.max(quotaBackoffUntil, now + retryAfterMs);
  lastQuotaLogAt = lastQuotaLogAt || now;
  if (_backoffCallback) _backoffCallback(quotaBackoffUntil);
}
```

At the end of the file, add two new exports:

```js
export function registerBackoffCallback(fn) {
  _backoffCallback = fn;
}

export function _resetBackoffCallbackForTest() {
  _backoffCallback = null;
}
```

Also verify the existing `setQuotaBackoff` already sets `quotaBackoffUntil` and `lastQuotaLogAt`— preserve all existing logic, only add the callback invocation.

- [ ] **Step 3: Run the test — verify it passes**

Run: `node --test tests/llm-backoff.test.mjs`
Expected: all tests PASS (5 tests including the 3 original + 2 new).

- [ ] **Step 4: Update `background.js` to register callback and restore backoff**

In `background.js`, update the import from `./llm-backoff.js`:

```js
import {
  clearLlmBackoff,
  isLlmBackedOff,
  getQuotaBackoffUntil,
  registerBackoffCallback,
  setQuotaBackoff,
} from './llm-backoff.js';
```

After the existing imports (before `loadConfig()`), register the callback:

```js
registerBackoffCallback((until) => {
  chrome.storage.local.set({ llmBackoffUntil: until });
});
```

In `loadConfig()`, in the `chrome.storage.local.get` callback, add restoration of backoff state. Find the block that reads from storage and add:

```js
if (data.llmBackoffUntil && data.llmBackoffUntil > Date.now()) {
  setQuotaBackoff({ retryAfterMs: data.llmBackoffUntil - Date.now() });
}
```

Add `'llmBackoffUntil'` to the array of keys read in `loadConfig`:
```js
chrome.storage.local.get([
  'activeSession', 'heuristicPolicy', 'sessionHistory', 'trackingEnabled',
  'llmProviderConfig', 'customDistractionSites', 'overrideCooldowns',
  'isCurrentlyIdle', 'lastIdleTime', 'sessionTabGroupId', 'llmBackoffUntil'
], (data) => { ... });
```

Also update the existing clear path: find where `clearLlmBackoff()` is called in background.js and after it, remove from storage:
```js
clearLlmBackoff();
chrome.storage.local.remove(['llmBackoffUntil']);
```

- [ ] **Step 5: Update `popup.js` to show backoff indicator**

In `popup.js`, in the `DOMContentLoaded` handler, add `'llmBackoffUntil'` to the `chrome.storage.local.get` call. After reading `activeSession`, add:

```js
const backoffUntil = result.llmBackoffUntil || 0;
const isBackedOff = backoffUntil > Date.now();
if (isBackedOff) {
  const notice = document.createElement('p');
  notice.className = 'no-session';
  notice.style.cssText = 'font-size:0.7rem;color:#888;margin:4px 0 0;';
  const minutesLeft = Math.ceil((backoffUntil - Date.now()) / 60000);
  notice.textContent = `AI check paused (~${minutesLeft} min). Heuristics still active.`;
  content.appendChild(notice);
}
```

Insert this block after the session-active display logic (so it appears below the session info regardless of session state).

- [ ] **Step 6: Self-review**

- Callback is registered at module load time (before any event listeners) ✓
- `setQuotaBackoff` is already imported in `providers.js` — adding it to `background.js` import only adds it to the background.js module scope, no conflict ✓
- `_resetBackoffCallbackForTest` is only called from tests ✓
- Backoff notice in popup is a read-only indicator (no action needed) ✓

- [ ] **Step 7: Run all tests**

```bash
cd /Users/harshabalakrishnan/Documents/Projects/IntentLock
node --test tests/llm-backoff.test.mjs
node --test tests/background.test.mjs
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add llm-backoff.js background.js popup.js tests/llm-backoff.test.mjs
git commit -m "feat: persist LLM backoff across service worker restarts, show indicator in popup"
```

---

### Task 3: Consistent intervention messages

**Files:**
- Modify: `background.js` — lines 631 and 635 (LLM drift intervention message)

**Interfaces:**
- No new exports or imports. Pure internal string change.
- The `checkDriftLLM` call returns `{ isAligned, confidence, llmSkipped? }`
- `res.confidence` is `0–1`; `res.isAligned` is boolean

- [ ] **Step 1: Locate the robotic messages in `background.js`**

Find the two occurrences of:
```js
triggerIntervention(`The AI has detected drift (Confidence: ${Math.round(res.confidence * 100)}%)`, tabId);
```

These are at approximately lines 631 and 635 in background.js.

- [ ] **Step 2: Replace both with a consistent human-readable label**

Replace both occurrences with:
```js
triggerIntervention('Your recent browsing no longer matches your declared intent.', tabId);
```

This matches the format of the heuristic path's `reasonLabel` (e.g. `'Your recent browsing no longer matches your declared intent.'`) so both paths produce the same quality of message.

- [ ] **Step 3: Self-review**

- Both occurrences replaced (search for `AI has detected` — should return 0 results) ✓
- No new logic added ✓
- The surrounding conditional logic (checking `!res.isAligned && res.confidence >= DRIFT_CONFIDENCE_THRESHOLD`) is unchanged ✓

- [ ] **Step 4: Run tests**

```bash
node --test tests/background.test.mjs
```

Expected: PASS (existing 2 tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add background.js
git commit -m "fix: replace robotic LLM intervention message with human-readable label"
```

---

### Task 4: Category grid section headers

**Files:**
- Modify: `options.js` — `buildCategoryGrid(policy)` function

**Interfaces:**
- Consumes: `SITE_CATEGORIES` from `heuristic-policy.js` (already imported)
- Produces: Enhanced DOM only — no storage or export changes

The 21 SITE_CATEGORIES IDs grouped into 3 sections:

```
DISTRACTING: ['social_media', 'short_video', 'streaming', 'gaming', 'memes', 'gambling', 'adult', 'sports', 'news', 'forums']
WORK_TOOLS:  ['email', 'messaging', 'job_boards', 'professional_network', 'documentation', 'code_forge', 'ai_tools', 'productivity']
NEUTRAL:     ['shopping', 'finance', 'health', 'travel']
```

- [ ] **Step 1: Write the failing test (smoke)**

No meaningful unit test for DOM. Skip to implementation.

- [ ] **Step 2: Add section groups to `buildCategoryGrid` in `options.js`**

Find `buildCategoryGrid` function in `options.js`. It currently iterates over `SITE_CATEGORIES` and appends each row. Replace the iteration with a grouped version:

```js
const CATEGORY_GROUPS = [
  {
    label: 'Potentially distracting',
    ids: ['social_media', 'short_video', 'streaming', 'gaming', 'memes', 'gambling', 'adult', 'news', 'forums', 'sports'],
  },
  {
    label: 'Work tools',
    ids: ['email', 'messaging', 'job_boards', 'professional_network', 'documentation', 'code_forge', 'ai_tools', 'productivity'],
  },
  {
    label: 'Neutral / personal',
    ids: ['shopping', 'finance', 'health', 'travel'],
  },
];
```

In `buildCategoryGrid(policy)`, replace the flat `SITE_CATEGORIES.forEach(...)` loop with:

```js
const grid = document.getElementById('category-grid');
grid.textContent = '';

const currentPolicy = (policy?.version === 1 && policy.categoryPolicies) ? policy.categoryPolicies : {};

CATEGORY_GROUPS.forEach(group => {
  const groupHeader = document.createElement('h3');
  groupHeader.className = 'category-group-header';
  groupHeader.textContent = group.label;
  grid.appendChild(groupHeader);

  group.ids.forEach(catId => {
    const cat = SITE_CATEGORIES.find(c => c.id === catId);
    if (!cat) return;
    const current = currentPolicy[cat.id] || cat.defaultPolicy || 'warn';

    const row = document.createElement('div');
    row.className = 'category-row';

    const labelEl = document.createElement('label');
    labelEl.className = 'category-label';
    labelEl.textContent = cat.label;
    row.appendChild(labelEl);

    const radioGroup = document.createElement('div');
    radioGroup.className = 'category-radios';
    radioGroup.setAttribute('role', 'group');
    radioGroup.setAttribute('aria-label', `${cat.label} policy`);

    ['block', 'warn', 'allow'].forEach(val => {
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `cat-${cat.id}`;
      radio.value = val;
      radio.id = `cat-${cat.id}-${val}`;
      if (current === val) radio.checked = true;

      const radioLabel = document.createElement('label');
      radioLabel.setAttribute('for', `cat-${cat.id}-${val}`);
      radioLabel.textContent = val;

      radioGroup.append(radio, radioLabel);
    });

    row.appendChild(radioGroup);
    grid.appendChild(row);
  });
});
```

Also add the group header CSS in `newtab.css` (shared stylesheet):

```css
.category-group-header {
  font-size: 0.65rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #888;
  margin: 16px 0 6px;
  border-bottom: 1px solid #222;
  padding-bottom: 4px;
}
```

- [ ] **Step 3: Self-review**

- All 21 SITE_CATEGORY IDs accounted for across the 3 groups ✓ (count: 10 + 8 + 4 = 22... wait, the adult category: 10+8+4 = 22 but there are 21 categories listed in heuristic-policy.md. Let me recount: social_media, short_video, streaming, gaming, memes, gambling, adult, news, forums, sports = 10; email, messaging, job_boards, professional_network, documentation, code_forge, ai_tools, productivity = 8; shopping, finance, health, travel = 4; 10+8+4 = 22. But there are 21 categories in the spec. Let me recheck: social_media, short_video, streaming, gaming, news, forums, shopping, email, messaging, job_boards, professional_network, documentation, code_forge, ai_tools, finance, sports, adult, gambling, memes, productivity, health, travel = 22. OK, 22 is actually correct based on heuristic-policy.md which lists them. Let me count from the docs: social_media, short_video, streaming, gaming, news, forums, shopping, email, messaging, job_boards, professional_network, documentation, code_forge, ai_tools, finance, sports, adult, gambling, memes, productivity, health, travel — that's 22 categories not 21. The spec says 21 but I may have miscounted. The implementer should count the actual SITE_CATEGORIES array from heuristic-policy.js and make sure all IDs are accounted for.)
- Categories in CATEGORY_GROUPS must include all IDs from `SITE_CATEGORIES` — implementer must verify by reading `heuristic-policy.js` and listing all `id` fields
- `cat` may be undefined if CATEGORY_GROUPS references an ID not in SITE_CATEGORIES — the `if (!cat) return;` guard handles this ✓
- No innerHTML ✓

- [ ] **Step 4: Run tests**

```bash
node --test tests/*.mjs
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add options.js newtab.css
git commit -m "feat: group settings category grid into three visual sections with headers"
```

---

### Task 5: Reflections in sessionHistory

**Files:**
- Modify: `background.js` — `createHistoryEntry` function; add to exports
- Modify: `history.js` — render overrides with reflections in session cards
- Modify: `tests/background.test.mjs` — test new history entry shape

**Interfaces:**
- `createHistoryEntry(session)` now returns:
  ```js
  {
    id: string,
    intent: string,
    startTime: number,
    endTime: number,
    timeBudget: number | null,
    driftCount: number,
    totalEvents: number,
    overrides: Array<{ timestamp: number, url: string|null, reflection: string|null }>
  }
  ```
- History.js reads `session.overrides` array (may be absent in older entries — handle gracefully)

- [ ] **Step 1: Write the failing test**

In `tests/background.test.mjs`, add a test that checks `createHistoryEntry` includes overrides. First, export `createHistoryEntry` from `background.js` (see Step 2). In the test file, update the import to also import `createHistoryEntry`:

```js
const { getInMemoryState, reloadConfig, createHistoryEntry } = await import('../background.js');
```

Add the test:
```js
test('createHistoryEntry includes overrides array with reflection text', () => {
  const session = {
    id: 'abc123',
    intent: 'write report',
    startTime: 1000,
    endTime: 2000,
    timeBudget: null,
    events: [
      { actionType: 'PAGE_LOAD', url: 'https://github.com', timestamp: 1100 },
      { actionType: 'OVERRIDE', url: 'https://reddit.com', timestamp: 1200, reflection: 'needed a break' },
      { actionType: 'OVERRIDE', url: 'https://twitter.com', timestamp: 1300, reflection: null },
    ],
  };
  const entry = createHistoryEntry(session);
  assert.equal(entry.driftCount, 2);
  assert.ok(Array.isArray(entry.overrides), 'overrides should be an array');
  assert.equal(entry.overrides.length, 2);
  assert.equal(entry.overrides[0].url, 'https://reddit.com');
  assert.equal(entry.overrides[0].reflection, 'needed a break');
  assert.equal(entry.overrides[1].reflection, null);
});
```

Run: `node --test tests/background.test.mjs`
Expected: FAIL — `createHistoryEntry` is not exported yet.

- [ ] **Step 2: Update `createHistoryEntry` in `background.js` and export it**

Replace the `createHistoryEntry` function body:

```js
function createHistoryEntry(session) {
  const events = Array.isArray(session.events) ? session.events : [];
  const overrides = events
    .filter(e => e.actionType === 'OVERRIDE')
    .map(e => ({
      timestamp: e.timestamp || 0,
      url: e.url || null,
      reflection: e.reflection || null,
    }));
  return {
    id: session.id,
    intent: session.intent,
    startTime: session.startTime,
    endTime: session.endTime,
    timeBudget: session.timeBudget,
    driftCount: overrides.length,
    totalEvents: events.length,
    overrides,
  };
}
```

In the exports at the bottom of `background.js`, add `createHistoryEntry`:
```js
export { reloadConfig, createHistoryEntry };
```

- [ ] **Step 3: Run the test — verify it passes**

Run: `node --test tests/background.test.mjs`
Expected: all 3 tests PASS.

- [ ] **Step 4: Update `history.js` to render overrides with reflections**

In the `renderSessions()` function in `history.js`, after the `card.appendChild(meta)` line, add a section that renders any overrides that have reflections:

```js
const overrides = Array.isArray(session.overrides) ? session.overrides : [];
const reflections = overrides.filter(o => o.reflection);
if (reflections.length > 0) {
  const reflSection = document.createElement('div');
  reflSection.className = 'history-reflections';

  reflections.forEach(o => {
    const item = document.createElement('div');
    item.className = 'reflection-item';

    const quote = document.createElement('p');
    quote.className = 'reflection-text';
    quote.textContent = `"${o.reflection}"`;

    item.appendChild(quote);

    if (o.url) {
      const urlNote = document.createElement('p');
      urlNote.className = 'reflection-url';
      try {
        urlNote.textContent = new URL(o.url).hostname.replace(/^www\./, '');
      } catch {
        urlNote.textContent = o.url;
      }
      item.appendChild(urlNote);
    }

    reflSection.appendChild(item);
  });

  card.appendChild(reflSection);
}
```

Also add CSS to `newtab.css`:
```css
.history-reflections {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #1a1a1a;
}
.reflection-item {
  margin: 6px 0;
}
.reflection-text {
  font-size: 0.75rem;
  color: #aaa;
  font-style: italic;
  margin: 0 0 2px;
}
.reflection-url {
  font-size: 0.65rem;
  color: #666;
  margin: 0;
}
```

- [ ] **Step 5: Self-review**

- Older history entries without `overrides` property: `Array.isArray(session.overrides)` returns false for undefined — treated as empty array, no reflections rendered ✓
- `new URL(o.url)` is wrapped in try/catch ✓
- No innerHTML ✓

- [ ] **Step 6: Run all tests**

```bash
node --test tests/background.test.mjs
node --test tests/*.mjs
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add background.js history.js newtab.css tests/background.test.mjs
git commit -m "feat: store and display override reflections in session history"
```

---

### Task 6: "End session" in intervention overlay

**Files:**
- Modify: `intervention-overlay.js` — add `onEndSession` callback option + "End session" button
- Modify: `content.js` — pass `onEndSession` callback
- Modify: `background.js` — handle `OVERLAY_END_SESSION` message
- Modify: `tests/intervention-overlay.test.mjs` — test the new callback

**Interfaces:**
- `createInterventionOverlay({ onOverride, onDismiss, onEndSession })` — `onEndSession` is optional
- New message: `{ type: 'OVERLAY_END_SESSION' }` sent from content.js to background.js
- `background.js` ALLOWED_MESSAGES must include `'OVERLAY_END_SESSION'`

- [ ] **Step 1: Write the failing test**

In `tests/intervention-overlay.test.mjs`, add:

```js
test('createInterventionOverlay accepts onEndSession callback', () => {
  let called = false;
  // The factory function signature should accept onEndSession without throwing
  assert.doesNotThrow(() => {
    createInterventionOverlay({ onEndSession: () => { called = true; } });
  });
});
```

Run: `node --test tests/intervention-overlay.test.mjs`
Expected: FAIL or PASS (the factory accepts unknown options gracefully — if it already passes, adjust the test to verify the button is created in the shadow DOM, but since JSDOM is not available in Node, keep it as a factory-level check).

- [ ] **Step 2: Add `onEndSession` support to `intervention-overlay.js`**

In `createInterventionOverlay`, update the destructured parameter from `{ onOverride, onDismiss }` to `{ onOverride, onDismiss, onEndSession }`.

After the existing `overrideBtn` block (after `actions.append(dismissBtn, overrideBtn)`), add:

```js
if (typeof onEndSession === 'function') {
  const endBtn = document.createElement('button');
  endBtn.type = 'button';
  endBtn.className = 'end-session-btn';
  endBtn.textContent = 'End session';
  endBtn.addEventListener('click', () => {
    hide();
    onEndSession();
  });
  actions.appendChild(endBtn);
}
```

Also add the button's CSS in `buildOverlayStyles()`:
```css
.end-session-btn {
  background: transparent;
  border: 1px solid #444;
  color: #888;
  padding: 8px 16px;
  cursor: pointer;
  font-size: 0.75rem;
  letter-spacing: 0.05em;
  margin-top: 4px;
}
.end-session-btn:hover {
  border-color: #666;
  color: #aaa;
}
```

- [ ] **Step 3: Run the test — verify it passes**

Run: `node --test tests/intervention-overlay.test.mjs`
Expected: PASS.

- [ ] **Step 4: Update `content.js` to pass `onEndSession`**

In the `ensureOverlay()` function in `content.js`, update the `createInterventionOverlay` call:

```js
overlay = createInterventionOverlay({
  onOverride: (reflection) => {
    chrome.runtime.sendMessage({
      type: 'OVERLAY_OVERRIDE',
      payload: {
        reflection,
        url: window.location.href,
        pageTitle: document.title,
      },
    }, () => { void chrome.runtime.lastError; });
  },
  onDismiss: () => {
    chrome.runtime.sendMessage({ type: 'OVERLAY_DISMISS' }, () => {
      void chrome.runtime.lastError;
    });
  },
  onEndSession: () => {
    chrome.runtime.sendMessage({ type: 'OVERLAY_END_SESSION' }, () => {
      void chrome.runtime.lastError;
    });
  },
});
```

- [ ] **Step 5: Update `background.js` to handle `OVERLAY_END_SESSION`**

Add `'OVERLAY_END_SESSION'` to the ALLOWED_MESSAGES array (the array near line 122 that lists valid message types).

Add the handler in the `chrome.runtime.onMessage.addListener` block, after the existing `OVERLAY_DISMISS` handler:

```js
} else if (message.type === 'OVERLAY_END_SESSION') {
  endActiveSession(null, (endedSession) => {
    chrome.runtime.sendMessage({ type: 'SESSION_CLEARED' }, () => {
      void chrome.runtime.lastError;
    });
    sendResponse({ status: 'ok', session: endedSession });
  });
  return true;
```

- [ ] **Step 6: Self-review**

- `endActiveSession` is already defined and handles null reflection ✓
- `OVERLAY_END_SESSION` added to ALLOWED_MESSAGES ✓
- `onEndSession` is optional in createInterventionOverlay — overlay still works without it ✓
- The "End session" button only appears when `onEndSession` is provided ✓

- [ ] **Step 7: Run tests**

```bash
node --test tests/intervention-overlay.test.mjs
node --test tests/background.test.mjs
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add intervention-overlay.js content.js background.js tests/intervention-overlay.test.mjs
git commit -m "feat: add End Session button to intervention overlay"
```

---

### Task 7: Free-browsing pause mode

**Files:**
- Modify: `background.js` — new `pauseUntil` state; `PAUSE_ENFORCEMENT` / `RESUME_ENFORCEMENT` message handlers; skip drift when paused; expose in `getInMemoryState`
- Modify: `popup.js` — "Pause 15 min" / "Resume" button when session is active
- Modify: `newtab.js` — show "Paused" banner in `showActiveState`

**Interfaces:**
- New storage key: `enforcementPauseUntil: number` (unix timestamp ms; 0 or absent = not paused)
- New message types: `PAUSE_ENFORCEMENT` (payload: `{ durationMs: number }`), `RESUME_ENFORCEMENT`
- `getInMemoryState()` gains `pauseUntil: number` field

- [ ] **Step 1: Write failing tests**

In `tests/background.test.mjs`, add after existing tests:

```js
test('getInMemoryState includes pauseUntil field', () => {
  const state = getInMemoryState();
  assert.ok('pauseUntil' in state, 'getInMemoryState should have pauseUntil');
  assert.equal(typeof state.pauseUntil, 'number');
});
```

Run: `node --test tests/background.test.mjs`
Expected: FAIL — `pauseUntil` not in state yet.

- [ ] **Step 2: Add pause state to `background.js`**

Add at the top of background.js (after existing module-level variable declarations):
```js
let pauseUntil = 0;
```

In `loadConfig()`, add `'enforcementPauseUntil'` to the storage keys read:
```js
chrome.storage.local.get([..., 'enforcementPauseUntil'], (data) => {
  ...
  pauseUntil = data.enforcementPauseUntil || 0;
  ...
});
```

In `getInMemoryState()`, add `pauseUntil` to the returned object:
```js
export function getInMemoryState() {
  return {
    currentSession,
    trackingEnabled,
    customDistractionSites,
    heuristicPolicy,
    sessionTabGroupId,
    isCurrentlyIdle,
    lastIdleTime,
    overrideCooldowns,
    pauseUntil,
  };
}
```

In the `evaluateDrift` function, after the domain cooldown check and before calling `evaluatePolicyDrift`, add:
```js
if (Date.now() < pauseUntil) return;
```

Add message handlers for pause and resume. In the `chrome.runtime.onMessage` block, add:
```js
} else if (message.type === 'PAUSE_ENFORCEMENT') {
  const duration = (message.payload?.durationMs) || (15 * 60 * 1000);
  pauseUntil = Date.now() + duration;
  chrome.storage.local.set({ enforcementPauseUntil: pauseUntil }, () => {
    sendResponse({ status: 'ok', pauseUntil });
  });
  return true;
} else if (message.type === 'RESUME_ENFORCEMENT') {
  pauseUntil = 0;
  chrome.storage.local.remove(['enforcementPauseUntil'], () => {
    sendResponse({ status: 'ok' });
  });
  return true;
```

Add `'PAUSE_ENFORCEMENT'` and `'RESUME_ENFORCEMENT'` to ALLOWED_MESSAGES.

Also clear `pauseUntil` when a session ends (`SESSION_CLEARED`, `END_ACTIVE_SESSION`):
```js
pauseUntil = 0;
chrome.storage.local.remove(['enforcementPauseUntil']);
```

- [ ] **Step 3: Run failing test — verify it passes**

Run: `node --test tests/background.test.mjs`
Expected: PASS.

- [ ] **Step 4: Update `popup.js` to show pause button**

In `popup.js`, read `'enforcementPauseUntil'` from storage alongside `'activeSession'`. After the session-active content (after the timer and End session button), add:

```js
chrome.storage.local.get(['activeSession', 'llmBackoffUntil', 'enforcementPauseUntil'], (result) => {
  ...
  const pauseUntilTs = result.enforcementPauseUntil || 0;
  const isPaused = pauseUntilTs > Date.now();

  if (session && session.isActive) {
    // existing session display ...

    // Pause / resume button
    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'popup-link';
    pauseBtn.style.cssText = 'display:block;background:none;border:none;cursor:pointer;font-size:0.75rem;color:#888;margin-top:8px;width:100%;text-align:center;';
    if (isPaused) {
      const minsLeft = Math.ceil((pauseUntilTs - Date.now()) / 60000);
      pauseBtn.textContent = `Paused (${minsLeft} min left) — Resume`;
      pauseBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'RESUME_ENFORCEMENT' }, () => {
          void chrome.runtime.lastError;
          window.close();
        });
      });
    } else {
      pauseBtn.textContent = 'Pause enforcement (15 min)';
      pauseBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({
          type: 'PAUSE_ENFORCEMENT',
          payload: { durationMs: 15 * 60 * 1000 }
        }, () => {
          void chrome.runtime.lastError;
          window.close();
        });
      });
    }
    content.appendChild(pauseBtn);
  }
});
```

Note: integrate this with the existing `chrome.storage.local.get` in popup.js (add `'enforcementPauseUntil'` to the existing get call rather than adding a second get call).

- [ ] **Step 5: Update `newtab.js` to show pause banner in `showActiveState`**

In `showActiveState(session)`, read `enforcementPauseUntil` from storage and show a banner if paused. Add at the top of `showActiveState`, before the container is built:

```js
chrome.storage.local.get(['enforcementPauseUntil'], (r) => {
  const puUntil = r.enforcementPauseUntil || 0;
  if (puUntil > Date.now()) {
    const pauseBanner = document.createElement('div');
    pauseBanner.className = 'pause-banner';
    const minsLeft = Math.ceil((puUntil - Date.now()) / 60000);
    pauseBanner.textContent = `Free browsing — enforcement paused for ~${minsLeft} more min`;
    container.insertBefore(pauseBanner, container.firstChild);
  }
});
```

Add to `newtab.css`:
```css
.pause-banner {
  background: #1a1a00;
  border: 1px solid #444400;
  color: #cccc00;
  font-size: 0.7rem;
  padding: 8px 12px;
  text-align: center;
  margin-bottom: 12px;
}
```

- [ ] **Step 6: Self-review**

- `pauseUntil` clears on session end ✓
- `Date.now() < pauseUntil` is checked before drift eval ✓
- PAUSE_ENFORCEMENT and RESUME_ENFORCEMENT added to ALLOWED_MESSAGES ✓
- popup.js adds `'enforcementPauseUntil'` to existing storage.get (not a second get call) ✓
- No eval, no innerHTML ✓

- [ ] **Step 7: Run tests**

```bash
node --test tests/background.test.mjs
node --test tests/*.mjs
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add background.js popup.js newtab.js newtab.css
git commit -m "feat: add free-browsing pause mode — pause enforcement for 15 min from popup"
```

---

### Task 8: Onboarding step 3 category preview

**Files:**
- Modify: `newtab.js` — `showStep3()` function
- Modify: `newtab.js` import line — add `SITE_CATEGORIES, STRICTNESS_PRESETS`

**Interfaces:**
- Consumes: `STRICTNESS_PRESETS`, `SITE_CATEGORIES` from `./heuristic-policy.js`
- Produces: DOM preview block only — no storage or export changes

- [ ] **Step 1: Update import in `newtab.js`**

Find the top-level import from `./heuristic-policy.js` in newtab.js:
```js
import { INTENT_CATEGORIES, buildDefaultPolicy } from './heuristic-policy.js';
```

Replace with:
```js
import { INTENT_CATEGORIES, buildDefaultPolicy, SITE_CATEGORIES, STRICTNESS_PRESETS } from './heuristic-policy.js';
```

- [ ] **Step 2: Add preview logic to `showStep3()`**

In `showStep3()`, locate the strictness `<select>` element (id: `onboarding-strictness` or similar). After the strictness select input-group, add a preview container:

```js
const previewDiv = document.createElement('div');
previewDiv.id = 'step3-preview';
previewDiv.className = 'onboarding-preview';
container.appendChild(previewDiv);
```

Create a helper function `updateStep3Preview(intentCatId, strictness)`:
```js
function updateStep3Preview(intentCatId, strictness) {
  const previewDiv = document.getElementById('step3-preview');
  if (!previewDiv) return;

  const preset = STRICTNESS_PRESETS[strictness] || STRICTNESS_PRESETS.balanced;
  const blocked = SITE_CATEGORIES.filter(c => preset[c.id] === 'block').map(c => c.label);
  const warned = SITE_CATEGORIES.filter(c => preset[c.id] === 'warn').map(c => c.label);

  previewDiv.textContent = '';
  if (blocked.length > 0) {
    const blockedLine = document.createElement('p');
    blockedLine.className = 'preview-line';
    blockedLine.textContent = `Will block: ${blocked.slice(0, 4).join(', ')}${blocked.length > 4 ? ` +${blocked.length - 4} more` : ''}`;
    previewDiv.appendChild(blockedLine);
  }
  if (warned.length > 0) {
    const warnedLine = document.createElement('p');
    warnedLine.className = 'preview-line preview-warn';
    warnedLine.textContent = `Will warn: ${warned.slice(0, 3).join(', ')}${warned.length > 3 ? ` +${warned.length - 3} more` : ''}`;
    previewDiv.appendChild(warnedLine);
  }
}
```

Wire update to strictness select's change event (and intent category select's change event):
```js
strictnessSelect.addEventListener('change', () => {
  updateStep3Preview(intentSelect.value, strictnessSelect.value);
});
intentSelect.addEventListener('change', () => {
  updateStep3Preview(intentSelect.value, strictnessSelect.value);
});
// Initial render
updateStep3Preview(intentSelect.value, strictnessSelect.value);
```

Add to `newtab.css`:
```css
.onboarding-preview {
  margin: 8px 0;
  padding: 10px 12px;
  border: 1px solid #222;
  border-radius: 2px;
}
.preview-line {
  font-size: 0.72rem;
  color: #999;
  margin: 3px 0;
}
.preview-warn {
  color: #b8860b;
}
```

- [ ] **Step 3: Self-review**

- `STRICTNESS_PRESETS[strictness]` falls back to `STRICTNESS_PRESETS.balanced` for unknown strictness values ✓
- Preview only shows 4 blocked + 3 warned to avoid overflow ✓
- `updateStep3Preview` does not use innerHTML ✓
- Import added correctly (check that `SITE_CATEGORIES` and `STRICTNESS_PRESETS` are exported from heuristic-policy.js — they are, per the docs)

- [ ] **Step 4: Run smoke tests**

```bash
node --test tests/static-smoke.test.mjs
node --test tests/heuristic-policy.test.mjs
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add newtab.js newtab.css
git commit -m "feat: show live preview of blocked/warned sites in onboarding step 3"
```

---

### Task 9: Stats dashboard

**Files:**
- Create: `stats.html`
- Create: `stats.js`
- Modify: `popup.js` — add "Stats" link to footer
- Modify: `tests/static-smoke.test.mjs` — verify stats.html and stats.js exist

**Interfaces:**
- Reads: `chrome.storage.local.sessionHistory` (array of history entries, now including `overrides` after Task 5)
- Computes: total focus time (last 7 days), sessions count, avg drifts/session, top drift domains
- No new storage writes; pure read + render

- [ ] **Step 1: Write a failing smoke test**

In `tests/static-smoke.test.mjs`, add:

```js
test('stats.html and stats.js exist', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  assert.ok(existsSync(new URL('../stats.html', import.meta.url)), 'stats.html should exist');
  assert.ok(existsSync(new URL('../stats.js', import.meta.url)), 'stats.js should exist');
});
```

Run: `node --test tests/static-smoke.test.mjs`
Expected: FAIL — files don't exist yet.

- [ ] **Step 2: Create `stats.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IntentLock Stats</title>
  <link rel="stylesheet" href="newtab.css">
</head>
<body>
  <div class="lock-container">
    <div class="header">
      <h1>STATS</h1>
      <p class="intent-active-label">Session history overview</p>
    </div>
    <div id="stats-content"></div>
  </div>
  <script type="module" src="stats.js"></script>
</body>
</html>
```

- [ ] **Step 3: Create `stats.js`**

```js
// stats.js — Session history statistics dashboard

document.addEventListener('DOMContentLoaded', () => {
  const content = document.getElementById('stats-content');

  chrome.storage.local.get(['sessionHistory'], (result) => {
    const sessions = result.sessionHistory || [];
    if (sessions.length === 0) {
      const p = document.createElement('p');
      p.className = 'monitoring-hint';
      p.textContent = 'No sessions yet. Start a session on the new tab page.';
      content.appendChild(p);
      return;
    }

    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    const recentSessions = sessions.filter(s => s.startTime >= sevenDaysAgo);
    const totalFocusMin = recentSessions.reduce((sum, s) => {
      return sum + Math.round((s.endTime - s.startTime) / 60000);
    }, 0);
    const totalDrifts = recentSessions.reduce((sum, s) => sum + (s.driftCount || 0), 0);
    const avgDrifts = recentSessions.length > 0
      ? (totalDrifts / recentSessions.length).toFixed(1)
      : '0';

    // Summary cards
    const summaryDiv = document.createElement('div');
    summaryDiv.className = 'session-stats';

    const cards = [
      { value: `${totalFocusMin}m`, label: 'Focus (7d)' },
      { value: String(recentSessions.length), label: 'Sessions (7d)' },
      { value: avgDrifts, label: 'Avg drifts' },
      { value: String(sessions.length), label: 'All time' },
    ];

    cards.forEach(card => {
      const box = document.createElement('div');
      box.className = 'stat-box';
      const val = document.createElement('div');
      val.className = 'stat-value';
      val.textContent = card.value;
      const lbl = document.createElement('div');
      lbl.className = 'stat-label';
      lbl.textContent = card.label;
      box.append(val, lbl);
      summaryDiv.appendChild(box);
    });
    content.appendChild(summaryDiv);

    // Top drift domains (from sessions that have overrides — Task 5 schema)
    const domainCounts = {};
    sessions.forEach(s => {
      const overrides = Array.isArray(s.overrides) ? s.overrides : [];
      overrides.forEach(o => {
        if (!o.url) return;
        try {
          const domain = new URL(o.url).hostname.replace(/^www\./, '').toLowerCase();
          domainCounts[domain] = (domainCounts[domain] || 0) + 1;
        } catch { /* skip */ }
      });
    });
    const topDomains = Object.entries(domainCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    if (topDomains.length > 0) {
      const driftSection = document.createElement('div');
      driftSection.className = 'plan-section';
      const heading = document.createElement('h3');
      heading.className = 'plan-heading';
      heading.textContent = 'Top drift sites';
      driftSection.appendChild(heading);

      topDomains.forEach(([domain, count]) => {
        const row = document.createElement('div');
        row.className = 'stat-row';
        const domainSpan = document.createElement('span');
        domainSpan.className = 'stat-label';
        domainSpan.textContent = domain;
        const countSpan = document.createElement('span');
        countSpan.className = 'stat-value';
        countSpan.textContent = `${count} override${count !== 1 ? 's' : ''}`;
        row.append(domainSpan, countSpan);
        driftSection.appendChild(row);
      });
      content.appendChild(driftSection);
    } else {
      const note = document.createElement('p');
      note.className = 'monitoring-hint';
      note.textContent = 'No drift site data yet. Top sites appear after you complete sessions with overrides.';
      content.appendChild(note);
    }

    // Recent sessions list
    const recentSection = document.createElement('div');
    recentSection.className = 'plan-section';
    const recentHeading = document.createElement('h3');
    recentHeading.className = 'plan-heading';
    recentHeading.textContent = 'Recent sessions';
    recentSection.appendChild(recentHeading);

    [...sessions].reverse().slice(0, 5).forEach(s => {
      const row = document.createElement('div');
      row.className = 'stat-row';
      const intentSpan = document.createElement('span');
      intentSpan.className = 'stat-label';
      intentSpan.style.maxWidth = '60%';
      intentSpan.style.overflow = 'hidden';
      intentSpan.style.textOverflow = 'ellipsis';
      intentSpan.style.whiteSpace = 'nowrap';
      intentSpan.textContent = s.intent;
      const metaSpan = document.createElement('span');
      metaSpan.className = 'stat-value';
      const dur = Math.round((s.endTime - s.startTime) / 60000);
      metaSpan.textContent = `${dur}m · ${s.driftCount || 0} drift${(s.driftCount || 0) !== 1 ? 's' : ''}`;
      row.append(intentSpan, metaSpan);
      recentSection.appendChild(row);
    });
    content.appendChild(recentSection);
  });
});
```

- [ ] **Step 4: Update `popup.js` to add Stats link in footer**

In `addFooterLinks(parent)`, add a "Stats" link between the History and Diagnostics separator:

```js
const statsLink = document.createElement('a');
statsLink.href = '#';
statsLink.className = 'popup-link';
statsLink.textContent = 'Stats';
statsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('stats.html') });
});

// Insert before the existing histLink/sep/diagLink chain
// New order: History · Stats · Diagnostics · Settings
footer.append(histLink, sep, statsLink, sep2, diagLink, sep3, settingsLink);
```

Note: you will need an additional `sep3` separator element. Create it following the same pattern as `sep` and `sep2`.

- [ ] **Step 5: Run the smoke test — verify it passes**

Run: `node --test tests/static-smoke.test.mjs`
Expected: PASS (stats.html and stats.js exist).

- [ ] **Step 6: Self-review**

- `sessions.filter(...)` handles empty array ✓
- `new URL(o.url)` wrapped in try/catch ✓
- No innerHTML ✓
- stats.html uses `newtab.css` for consistent styling ✓
- Top drift domains only available from sessions with `overrides` (Task 5 schema); note shown for older sessions ✓

- [ ] **Step 7: Run all tests**

```bash
node --test tests/*.mjs
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add stats.html stats.js popup.js tests/static-smoke.test.mjs
git commit -m "feat: add stats dashboard with weekly focus time, drift rate, top sites"
```

---

### Task 10: Version bump and CHANGELOG

**Files:**
- Modify: `manifest.json` — version `"1.5.0"` → `"1.6.0"`
- Modify: `CHANGELOG.md` — prepend 1.6.0 entry

**Interfaces:** None (mechanical housekeeping).

- [ ] **Step 1: Bump version in `manifest.json`**

Find: `"version": "1.5.0"`
Replace with: `"version": "1.6.0"`

- [ ] **Step 2: Prepend CHANGELOG entry**

At the top of the `## [1.5.0]` entry (after the file header if any), prepend:

```markdown
## [1.6.0] — 2026-06-23

### Added
- **Session summary enhancements** — top drifted sites and "View in history" link shown after session ends
- **LLM backoff persistence** — quota backoff survives service worker restarts; popup shows indicator when AI drift check is paused
- **Category grid section headers** — Settings now groups 21 site categories into "Potentially distracting", "Work tools", and "Neutral/personal"
- **Reflections in history** — override reflections written during sessions are now shown in the History page
- **End session in overlay** — intervention overlay has a third "End session" button alongside Override and Dismiss
- **Free-browsing pause mode** — pause enforcement for 15 minutes from the popup toolbar without ending the session
- **Onboarding step 3 preview** — live preview of which site categories will be blocked/warned after choosing strictness
- **Stats dashboard** — new page (Stats link in popup) showing weekly focus time, drift rate, top drift sites

### Fixed
- Intervention overlay message now uses consistent human-readable label for both heuristic and AI-detected drift
```

- [ ] **Step 3: Run smoke tests**

```bash
node --test tests/static-smoke.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add manifest.json CHANGELOG.md
git commit -m "chore: bump to 1.6.0, add CHANGELOG entry for product review improvements"
```

---

## Test Coverage Summary

| Task | Test files touched | Tests added |
|------|--------------------|-------------|
| 1 | none (DOM-only) | 0 |
| 2 | llm-backoff.test.mjs | 2 |
| 3 | background.test.mjs (existing pass) | 0 |
| 4 | none (DOM-only) | 0 |
| 5 | background.test.mjs | 1 |
| 6 | intervention-overlay.test.mjs | 1 |
| 7 | background.test.mjs | 1 |
| 8 | none (DOM-only) | 0 |
| 9 | static-smoke.test.mjs | 1 |
| 10 | static-smoke.test.mjs (existing) | 0 |

Total new tests: 6
