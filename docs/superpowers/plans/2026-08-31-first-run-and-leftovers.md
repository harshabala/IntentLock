# First-run onboarding and leftover polish

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development. Failing test first. Commit after each task. Do not push. Do not bump version (stay 1.6.0).

**Goal:** Raise first-run clarity (de-jargonize, lock rehearsal, what to do after Lock in) and close leftover polish (overlay fonts on web pages, live Auto theme, reachable Continue `aria-invalid`, fewer grep-only tests).

**Branch:** `feat/first-run-and-polish`  
**Worktree:** `.worktrees/feat-first-run-and-polish`

---

## Global Constraints

- Stay version `1.6.0`. Visualized Value tokens, no glass/gradients/`transition: all`/uppercase/infinite animation.
- Overlay remains non-bypassable (no Escape dismiss). Continue anyway still requires non-empty trimmed why before a successful override.
- Do not use the word `patterns` in HTML/JS/CSS.
- Copy: sentence case. Buttons: `Close this tab`, `Continue anyway`, `End session`, `Lock in`.
- `npm test` must stay green. Never `node --test tests/` as a directory.
- Preserve IDs tests require: `intent-input` maxlength, `tracking-toggle-hit`, `onboarding-category`, `onboarding-strictness`.
- Work from this worktree. Do not push.
- User-facing copy must not say `heuristic(s)` or `strictness` (internal keys may stay).
- Lock (`body.intervention` / overlay) stays inverted regardless of theme.

---

### Task 1: First-run copy and after Lock in

**Files:** `onboarding.js`, `newtab.js`, `heuristic-policy.js`, `session-metrics.js`, `options.html` / `options.js` (user-visible strings only), `tests/static-smoke.test.mjs`

**Copy (verbatim):**

Onboarding step 2:
- Heading: `How hard should the lock be?`
- Body: `Works on this device with no account. You can add optional AI later in Settings.`
- Category label: `What kind of work is this usually?`
- Strictness label: `How often should it lock?`
- Strictness options stay the same values (`relaxed` / `balanced` / `strict`) with text:
  - `Relaxed — only lock short video`
  - `Balanced — lock social, short video, streaming`
  - `Strict — lock social, video, gaming, forums`
- Primary button: `Save and continue` (was `Save policy`)

Active session (`showActiveState`):
- After the intent quote, add `<p class="next-step">` with: `Use the address bar to go to your work. Drift locks the page.`

Lock reason in `heuristic-policy.js`: drop the ` (heuristic)` suffix. Example: `This looks like Short Video during Deep Work.`

`ON_INTENT_METHOD_COPY`: replace the heuristics sentence with: `It is an estimate from active-tab time and does not need an API key.`

**TDD:**

- [ ] Failing tests: onboarding.js source contains the new heading and does not contain `Heuristics work` or `Default intent type` or `Strictness` as a label string. User-facing lock reasons do not contain `(heuristic)`. `showActiveState` includes `Use the address bar to go to your work.`
- [ ] Implement, `npm test`, commit: `fix: de-jargonize first-run copy and post-lock-in next step`

---

### Task 2: Lock rehearsal

**Files:** `onboarding.js`, `newtab.css`, `tests/static-smoke.test.mjs`

After a successful policy save, **before** `showNewSessionForm`, show a rehearsal screen in the same container.

**Copy (verbatim):**
- Heading: `This is the lock.`
- Body: `When you drift, the page looks like this. Write why to continue, or leave.`
- Show a preview card (`div.lock-rehearsal` with `body`-level inverted styles via a wrapper class `rehearsal-lock` on the container or card) using existing lock strings: heading `You are drifting from your intent.`, disabled-looking Continue copy `Continue anyway`, primary `Close this tab` as a **Got it** button whose text is `Got it` (do not actually close a tab).
- `Got it` calls `showNewSessionForm(container)`.

Do not send `TEST_INTERVENTION` here (that requires an active http(s) session). This is a local preview.

On the **active session** screen, add a ghost/text button `Try the lock` that sends `{ type: 'TEST_INTERVENTION' }` and shows the error string from the background if it fails. Place it under the next-step line.

**TDD:**

- [ ] Test: onboarding contains `This is the lock.` and `Got it`.
- [ ] Test: newtab.js `showActiveState` contains `Try the lock` and `TEST_INTERVENTION`.
- [ ] Implement, `npm test`, commit: `feat: lock rehearsal on first-run and try-the-lock on session`

---

### Task 3: Overlay fonts on web pages

**Files:** `manifest.json`, `intervention-overlay.js`, `tests/manifest-runtime.test.mjs` or `tests/static-smoke.test.mjs`

Content-script overlay cannot load packaged fonts without `web_accessible_resources`.

1. Add to `manifest.json`:

```json
"web_accessible_resources": [{
  "resources": [
    "fonts/IBMPlexMono-Regular.woff2",
    "fonts/SourceSerif4-Regular.woff2",
    "fonts/SourceSerif4-Italic.woff2"
  ],
  "matches": ["http://*/*", "https://*/*"]
}]
```

2. In `buildOverlayStyles()`, insert `@font-face` rules using `chrome.runtime.getURL(...)` for those three files (call getURL when building styles, not as a static string of a fake path).
3. Keep existing family names on `:host` and `h1`.

**TDD:**

- [ ] Failing test: manifest `web_accessible_resources` lists the three woff2 files with http/https matches.
- [ ] Failing test: overlay style factory output (or source after getURL) includes `@font-face` and `chrome-extension://` or `getURL`.
- [ ] Implement, `npm test`, commit: `fix: load Visualized Value fonts in the in-page lock`

---

### Task 4: Live Auto theme and reachable Continue invalid

**Files:** `newtab.js`, `options.js`, `popup.js`, `analytics.js`, `history.js`, `diagnostics.js`, `intervention-overlay.js`, `intervention.js`, `tests/intervention-overlay.test.mjs`, `tests/static-smoke.test.mjs`

**Auto theme:** When `theme === 'auto'`, subscribe to `matchMedia('(prefers-color-scheme: dark)')` `change` and re-apply `theme-dark`. Unsubscribe/replace the listener when theme is set to light/dark. Extract a small shared helper if that avoids five copy-pastes; otherwise add the same listener pattern next to each existing auto block. Lock stays inverted.

**Continue:** Do **not** set `overrideBtn.disabled = true` for empty why. Keep it clickable. On empty Continue click, set `aria-invalid="true"`, show `Write why, or close this tab.`, focus the textarea, do not call `onOverride`. Disable Continue only while `transitionInFlight`. Same for fallback `intervention.js` (use click/submit that can fire when empty). Visual: use `aria-disabled="true"` when empty if you want a muted look, but the click must still run.

**TDD:**

- [ ] Failing test: overlay Continue click with empty why sets `aria-invalid="true"` using the real overlay DOM harness (`createInterventionOverlay` + `ensureHost`/`show` if needed — extend the existing overlay test, do not only grep).
- [ ] Test: options/newtab auto theme code listens for `change` on prefers-color-scheme (source or unit).
- [ ] Implement, `npm test`, commit: `fix: live auto theme and reachable continue invalid state`

---

### Task 5: Behavior tests for first-run surfaces

**Files:** `tests/onboarding.test.mjs` (new) and/or extend `tests/static-smoke.test.mjs`, `tests/intervention-overlay.test.mjs`

Replace grep-only coverage **for the new behavior** with at least:

1. Load `onboarding.js` in the classic/module test harness, call `showOnboardingWizard`, click through Continue → Save and continue (mock `chrome.storage`), assert rehearsal heading, click Got it, assert the intent form appears (`intent-input` or `showNewSessionForm` called).
2. Overlay empty Continue: already in Task 4 — if still grep-only, convert it here.

Do not rewrite the entire smoke file. Do not add Playwright.

**TDD:**

- [ ] Write the failing onboarding flow test first.
- [ ] Implement harness glue only as needed.
- [ ] `npm test`, commit: `test: exercise onboarding lock rehearsal in the DOM`
