# Visualized Value Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild IntentLock’s visual world as Visualized Value (white + black + sparse hatch marks) across extension pages, invert it on the lock, and move dashboards off the vow.

**Architecture:** Keep MV3 zero-build ES modules. One page stylesheet (`newtab.css`). Overlay styles stay inside `buildOverlayStyles()`. Declare stays on new tab. Stats live in popup (summary) and `analytics.html` (full).

**Tech Stack:** Vanilla JS, CSS, Node `node:test`.

## Global Constraints

- Tokens: `--bg-white: #ffffff; --fg-black: #000000; --muted-black: #1a1a1a; --line-width: 1px; --corner-radius: 2px; --font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", monospace; --font-serif: "Source Serif 4", "Iowan Old Style", Palatino, Georgia, serif;`
- No gradients, glass, blur, glow, indigo (`#6366f1`), purple (`#a855f7`), `backdrop-filter`.
- No infinite animations: delete `pulseRing`, `subtlePulse`, `intentSpin`, `borderPulse`.
- No `transition: all`. No `text-transform: uppercase`.
- Overlay entrance: opacity + scale 0.98→1, 160–180ms ease-out, forwards, once.
- `prefers-reduced-motion: * { animation: none !important; transition: none !important; }`
- Copy: sentence case. Buttons: `Close this tab`, `Continue anyway`, `End session`, `Lock in`.
- Continue anyway enabled only when reflection trim is non-empty.
- Do not put declare UI on `options.html`.
- Do not use the word `patterns` in HTML/JS/CSS (static-smoke forbids it). Use `vv-hatch` / `vv-grid` / `vv-chevron`.
- Preserve existing IDs that tests require: `intent-input` maxlength, `tracking-toggle-hit`, provider fields, `setupModalDialog`, shortcuts `?` aria-label, `intentInput.maxLength`, `showConfirmEndDialog`.
- Touch targets min 44px on primary buttons and tracking toggle.
- `npm test` must stay green. Never `node --test tests/` as a directory.
- Do not bump version (stay 1.6.0). Do not change background drift logic except copy strings if needed.
- Overlay remains non-bypassable (no Escape dismiss). Keep mark-related checkbox.
- Work from this worktree. Commit after each task. Do not push.

**Resolved conflicts:** see `docs/superpowers/specs/2026-08-24-vv-remediation.md`.

---

### Task 1: Design tokens and page CSS

**Files:**
- Replace: `newtab.css`
- Replace: `intervention.css`
- Test: `tests/static-smoke.test.mjs`

**Interfaces:**
- Consumes: existing class names used by HTML/JS (`lock-container`, `primary-btn`, `override-btn`, `tracking-toggle-hit`, `disclosure-toggle`, `popup`, `session-timer`, `confirm-overlay`, `category-row`, …)
- Produces: Visualized Value tokens; restyled existing selectors; inverted lock page via `body.intervention`

- [ ] **Step 1: Write failing tests** in `tests/static-smoke.test.mjs`:

```js
test('visualized value tokens and no glass kit', async () => {
  const css = await text('newtab.css') + '\n' + await text('intervention.css');
  assert.match(css, /--bg-white:\s*#ffffff/);
  assert.match(css, /--fg-black:\s*#000000/);
  assert.match(css, /--corner-radius:\s*2px/);
  assert.match(css, /IBM Plex Mono/);
  assert.match(css, /Source Serif 4/);
  assert.equal(/backdrop-filter/.test(css), false);
  assert.equal(/linear-gradient/.test(css), false);
  assert.equal(/pulseRing|subtlePulse|intentSpin/.test(css), false);
  assert.equal(/text-transform:\s*uppercase/.test(css), false);
  assert.equal(/transition:\s*all/.test(css), false);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /\.tracking-toggle-hit\s*\{[^}]*min-width:\s*44px/s);
});
```

- [ ] **Step 2: Run** `node --test tests/static-smoke.test.mjs` — expect FAIL.

- [ ] **Step 3: Rewrite CSS**

Replace `newtab.css` entirely with a complete Visualized Value sheet that still styles every surface currently using it: new tab, options, popup (`body.popup`), history, diagnostics, confirm dialogs, tracking toggle, disclosure, category radios, theme chips, timer, week glance (kept for analytics reuse).

Rules:
- `body` white, black text, IBM Plex Mono 12px / 1.6
- `.lock-container` white, 1px black border, 2px radius, padding 16/24, no blur
- `h1` / `.intent-statement` Source Serif 4, 16–18px, no gradient clip
- `.primary-btn` / `.btn--primary`: black fill, white text, min-height 44px
- `.override-btn` / `.btn--ghost`: transparent, black border
- `body.intervention`: black background, white text, white hairlines (inverted). No scanlines, no pulse.
- Popup width 300px (`body.popup`).
- Keep `.tracking-toggle-hit` 44×44.
- Keep `font-variant-numeric: tabular-nums` for timers.
- Sparse `vv-hatch` utility (30° repeating-linear-gradient at ~0.06 opacity) used only on `.intent-statement` and `body.intervention .lock-container`.

Replace `intervention.css` with: no pulseRing; overlayEnter unused here (page lock uses fadeIn 160ms once); stagger delays 0; reduced-motion none.

- [ ] **Step 4:** `npm test`

- [ ] **Step 5: Commit** `style: visualized value tokens and page css`

---

### Task 2: Lock overlay and fallback CTAs

**Files:**
- Modify: `intervention-overlay.js`
- Modify: `intervention.html`
- Modify: `intervention.js`
- Test: `tests/intervention-overlay.test.mjs`, `tests/static-smoke.test.mjs`

**Interfaces:**
- Consumes: existing `createInterventionOverlay({ onOverride, onDismiss, onEndSession })`. Change `onOverride(reflection)` to `onOverride({ reflection, markRelated })` **only if** `content.js` is updated in this same task to match. Prefer keeping `onOverride(reflection)` and sending markRelated as today if already an object — read `content.js` and keep the message payload `{ reflection, url, pageTitle, markRelated }`.
- Produces: identical CTAs on overlay and fallback.

- [ ] **Step 1: Tests**

```js
test('overlay copy uses sentence-case lock language', async () => {
  const js = await text('intervention-overlay.js');
  const html = await text('intervention.html');
  for (const src of [js, html]) {
    assert.match(src, /Close this tab/);
    assert.match(src, /Continue anyway/);
    assert.match(src, /End session/);
    assert.equal(src.includes('Override & continue'), false);
    assert.equal(/text-transform:\s*uppercase/.test(src), false);
  }
  assert.match(js, /overlayEnter|scale\(0\.98\)/);
});
```

Add to overlay unit tests: creating overlay does not throw; styles include `overlayEnter` 160ms and no `infinite`.

- [ ] **Step 2:** run tests, expect FAIL.

- [ ] **Step 3: Implement**

Overlay panel:
- Title/reason: `You are drifting from your intent.` plus quoted intent in serif (`.intent-quote`).
- Label: `Why?`
- Placeholder: `Enter why this page, given your intent.`
- Primary button Close this tab (`btn--primary`) — existing dismiss/close-tab behavior (`onDismiss`).
- Ghost `Continue anyway` disabled until textarea trim length > 0; then `onOverride`.
- End session text button under the pair.
- Keep mark-related checkbox, sentence case: `This site is related to my intent`.
- Error text if continue clicked empty: `Write why, or close this tab.`
- `show()`: display block, rAF add `is-in` for 160ms opacity+scale; reduced-motion skip.
- `hide()`: remove `is-in`, then display none after transitionend or immediately if reduced motion.
- Inverted colors in `buildOverlayStyles`: bg `#000000`, fg `#ffffff`, radius 2px, no uppercase, no infinite animation.

`intervention.html` / `intervention.js`: same copy, same enablement, same error id. Close tab remains `return-btn`. Continue is submit of reflection form. End session button already exists — keep wiring.

- [ ] **Step 4:** `npm test`

- [ ] **Step 5: Commit** `fix: lock cta hierarchy and overlay enter`

---

### Task 3: Declare and active session UI

**Files:**
- Modify: `newtab.js`
- Modify: `onboarding.js`
- Modify: `newtab.html` only if needed to keep `intent-input` maxlength for tests
- Test: `tests/static-smoke.test.mjs`

**Interfaces:**
- Consumes: `showNewSessionForm`, `showActiveState`, `showOnboardingWizard`
- Produces: vow UI without preset/strictness/API upsell; active session without stats grid

- [ ] **Step 1: Tests**

```js
test('declare form is intent plus optional minutes', async () => {
  const code = await text('newtab.js');
  assert.match(code, /Lock in/);
  assert.match(code, /Enter your task/);
  assert.equal(code.includes('Generating plan...'), false);
  assert.equal(code.includes('Complete session'), false);
  assert.match(code, /End session/);
  const formFn = code.slice(code.indexOf('function showNewSessionForm'), code.indexOf('function showActiveState') > 0 ? code.indexOf('function showActiveState') : code.length);
  assert.equal(formFn.includes('intent-preset'), false);
  assert.equal(formFn.includes('session-strictness'), false);
});
```

- [ ] **Step 2:** FAIL

- [ ] **Step 3:**
- `showNewSessionForm`: heading `What are you trying to achieve?`; textarea placeholder `Enter your task (e.g., 'Write Q3 report')`; optional minutes; **Lock in**; no preset/strictness/API notice. Keep `intent-input` id and maxLength 250. Start button text stays `Lock in` while waiting (`Starting session…` allowed; never `Generating plan...`). Still call `generateIntentPlan` in background if that is required for session start — do not block the label on “plan”.
- `showActiveState`: quoted intent (serif class), remaining/elapsed time, **End session** only. Remove Pages/Switches/Drifts grid, monitoring paragraph, plan list, Edit intent, shortcuts FAB if it is on this view. Keep `setupModalDialog` + `showConfirmEndDialog` + `showShortcutsModal` functions in the file even if the FAB is removed, **or** update the smoke test that requires shortcuts button — prefer keep the shortcuts control as a text link “Shortcuts” in the footer, aria-label `Keyboard shortcuts`, textContent still `?` if the test requires it.
- Onboarding copy: `Declare your intent.` / contract body already ok / `Set your default policy` / `Save policy`. No ALL CAPS.
- Confirm end copy: `{n} minutes. {n} override(s). End this session?`

- [ ] **Step 4:** `npm test`

- [ ] **Step 5: Commit** `feat: vow-only new tab session ui`

---

### Task 4: Popup summary and analytics page

**Files:**
- Modify: `popup.html`, `popup.js`
- Create: `analytics.html`, `analytics.js`
- Modify: `scripts/package-release.mjs` RUNTIME_FILES
- Modify: `manifest.json` only if a web_accessible or extra page is required (not needed for extension pages)
- Test: `tests/static-smoke.test.mjs`, `tests/manifest-runtime.test.mjs` allowlist if present

**Interfaces:**
- Consumes: `summarizeWeek` from `session-metrics.js`, `activeSession`, `sessionHistory`
- Produces: compact popup; full week + history dashboard on analytics.html

- [ ] **Step 1: Tests** that `analytics.html` exists, popup contains `End session` and width-related class, RUNTIME_FILES includes `analytics.html` and `analytics.js`, parse list includes analytics.js.

- [ ] **Step 2:** FAIL

- [ ] **Step 3:**
Popup (~300px): if active — quoted intent, time remaining, End session, link `chrome.runtime.getURL('analytics.html')` “View stats”. If idle — last session intent + duration or “No active session.” Link to new tab via `chrome.tabs.create`. No week glance, no export, no diagnostics in popup. Footer: Settings only.
Analytics page: week summary (sessions, average on-intent, no “Best day”), history list reuse from `history.js` logic or iframe/link to `history.html`. Prefer composing: analytics.html shows week numbers + a link to existing `history.html`. Move week UI from popup.js into analytics.js using `summarizeWeek`.
Keep `popup` class on body.

- [ ] **Step 4:** `npm test` && `npm run package`

- [ ] **Step 5: Commit** `feat: popup summary and analytics page`

---

### Task 5: Remaining copy, options labels, overlay tests, changelog note

**Files:**
- Modify: `options.html` labels only (LLM provider → AI provider (optional); intro copy)
- Modify: `background.js` time-budget reason string if it still coaches
- Modify: `CHANGELOG.md` 1.6.0 or add Changed bullets under existing 1.6.0
- Tests: extend smoke for no `Welcome to IntentLock`, no `You stayed on track`

- [ ] **Step 1–5:** TDD copy assertions; fix strings; `npm test`; commit `docs: sentence-case lock copy`
