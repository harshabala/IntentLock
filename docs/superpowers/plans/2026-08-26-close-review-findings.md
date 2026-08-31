# Close all review findings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development. Write a failing test first, watch it fail, then implement. Commit after each task. Do not push.

**Goal:** Close every code-fixable finding from the 2026-08-26 multi-skill review of `feat/intentlock-ten` without changing the product into a network interceptor.

**Architecture:** Keep MV3 zero-build ES modules. Overlay stays closed shadow, non-bypassable. Visualized Value tokens stay. Do not bump version (1.6.0).

**Out of scope (product contradictions, not bugs):**
- Require a live session before any `http(s)` navigation (`webRequest` / DNR gate). Current product is opt-in Lock in.
- Chrome Web Store publish, monetization, mobile.
- Full Rams information-architecture rewrite of the 21-category Settings grid (a11y of those radios *is* in scope).

---

## Global Constraints

- Tokens: `--bg-white: #ffffff; --fg-black: #000000; --muted-black: #1a1a1a; --line-width: 1px; --corner-radius: 2px;`
- No gradients, glass, blur, glow, indigo, purple, `backdrop-filter`, `transition: all`, `text-transform: uppercase`, infinite animation.
- Overlay enter: opacity + scale 0.98→1, 160–180ms ease-out, **one** motion path (CSS transition on `.panel` / `.panel.is-in`). Keep the string `overlayEnter` and `scale(0.98)` in overlay CSS so existing smoke tests still match.
- `prefers-reduced-motion: reduce` → `animation: none !important; transition: none !important;`
- Copy: sentence case. Buttons: `Close this tab`, `Continue anyway`, `End session`, `Lock in`.
- Continue anyway enabled only when reflection trim is non-empty. `aria-invalid` only after a failed Continue click, not on first paint.
- Do not use the word `patterns` in HTML/JS/CSS. Hatch = `vv-hatch`.
- Preserve IDs tests require: `intent-input` maxlength, `tracking-toggle-hit`, provider fields, `setupModalDialog`, shortcuts `?` aria-label, `intentInput.maxLength`, `showConfirmEndDialog`.
- Touch targets min 44px on primary buttons, tracking toggle, popup links.
- `npm test` must stay green. Never `node --test tests/` as a directory.
- Do not bump version. Do not change drift scoring except copy strings and calling existing `mergePolicyWithIntent` on session start.
- Overlay remains non-bypassable (no Escape dismiss). Keep mark-related checkbox.
- Work from this worktree. Commit after each task. Do not push.
- Reflection stored in background must be capped (2000 chars). Intent stays maxlength 250.
- Restore fallback URL only if `sanitizeUrl(originalUrl)` is non-null (`http:`/`https:`).
- `isTrackableUrl` allowlists `http://` and `https://` only.
- GitHub Actions `uses:` must be 40-char SHAs in **all** workflows including `pages.yml`.
- No `#888` inline colors. Use `var(--muted)` / `--muted-black`.

---

### Task 1: Service worker correctness

**Files:** `background.js`, `content.js`, `page-tracker.js`, `privacy-utils.js`, `intervention.js`, `tests/background.test.mjs`, `tests/intervention-state.test.mjs`, `tests/page-tracker.test.mjs`, `tests/privacy.test.mjs`

**Fixes:**

1. **sessionHistory clobber** — `loadConfig` must not `storageSet` a stale `sessionHistory` snapshot. Re-read `sessionHistory` inside the queued mutation, then sanitize that fresh value.
2. **stuck configPromise** — if `loadConfig` aborts because generation changed or deletion is active, set `configPromise = null` before resolve so the next caller reloads.
3. **overlay intent** — persist `intent: session.intent || ''` on the intervention state object in `triggerIntervention`. Restore overlay uses `response.state.intent`.
4. **retry pending lock** — if `stateForTab` finds an existing record with `mode === 'pending'` (or overlay/fallback that never displayed), retry SHOW_INTERVENTION then fallback instead of returning immediately.
5. **idle-then-hide dwell** — `onVisibilityChange` must not count idle time as active dwell. Accumulate only when the tracker is visible **and not idle**.
6. **trackable URLs** — `isTrackableUrl` returns true only for `http://` and `https://`.
7. **idle copy** — replace `Are you still aligned?` with `You switched context after being idle.`
8. **reflection cap** — `handleInterventionTransition` truncates reflection to 2000 characters.
9. **fallback restore** — `intervention.js` sets `location.href` only when `sanitizeUrl(originalUrl)` is non-null.

**TDD:**

- [ ] Failing test: `loadConfig` queued sanitize does not overwrite a newer history written while the get is in flight.
- [ ] Failing test: aborted `loadConfig` allows a later `loadConfig` to apply storage (configPromise reset).
- [ ] Failing test: `triggerIntervention` state includes `intent` matching the session.
- [ ] Failing test: second `triggerIntervention` for a `pending` tab retries display (does not no-op forever).
- [ ] Failing test: idle then hide does not add idle milliseconds to dwell.
- [ ] Failing test: `javascript:` and `data:` URLs are not trackable; `https://` is.
- [ ] Failing test: override reflection longer than 2000 is stored truncated.
- [ ] Implement, run `node --test tests/background.test.mjs tests/intervention-state.test.mjs tests/page-tracker.test.mjs tests/privacy.test.mjs` then full `npm test`.
- [ ] Commit: `fix: stop history clobber, restore lock intent, and bound intervention URLs`

---

### Task 2: Lock UI (overlay + fallback)

**Files:** `intervention-overlay.js`, `intervention.js`, `intervention.html`, `intervention.css`, `newtab.css`, `tests/intervention-overlay.test.mjs`, `tests/static-smoke.test.mjs`

**Fixes:**

1. `syncContinueEnabled` does **not** set `aria-invalid` from emptiness. Empty Continue click sets `aria-invalid="true"` and the existing error copy. Input that becomes non-empty sets `aria-invalid="false"` or removes the attribute.
2. `.intervention-actions button { width: auto; max-width: 100%; }` so Close/Continue sit in a row. End session stays `flex-basis: 100%`.
3. Overlay panel: drive enter/exit with the 160ms opacity+scale **transition** only. Keep `@keyframes overlayEnter` in the stylesheet string (tests match `/overlayEnter/` and `scale(0.98)`). `.panel.is-in` must not also set `animation: overlayEnter`.
4. Fallback: one 160ms fade on `.lock-container`. `.stagger-1/2/3 { animation: none; }`.
5. Overlay `hide()` timeout 180ms (not 200).
6. Overlay buttons get the same 160ms color/background/border hover as page buttons; `:active` includes transform in the transition list.
7. Overlay `:host` uses the same CSS variables as pages (white/black inverted). Add `vv-hatch` on the overlay panel matching `body.intervention .lock-container`.
8. Overlay related checkbox 18px (match fallback).
9. If reason is time-budget (`Time budget exceeded.`), lock heading is `Time budget exceeded.` not always `You are drifting from your intent.`
10. Continue button `aria-describedby` pointing at a hint: `Write why to continue.` when disabled.
11. Overlay `:host { -webkit-font-smoothing: antialiased; }`
12. End session underline uses `text-underline-offset: 0.2em`.
13. Overlay textarea `maxlength="2000"`. Fallback textarea same.

**TDD:**

- [ ] Test: overlay continue empty path does **not** set aria-invalid until empty Continue click; after click it is true; after typing it is false.
- [ ] Test: fallback CSS includes `.intervention-actions button` width auto (not only flex).
- [ ] Test: overlay styles include `overlayEnter` and `scale(0.98)` but `.panel.is-in` does not set `animation: overlayEnter`.
- [ ] Test: fallback `.stagger-1` has `animation: none`.
- [ ] Implement, `npm test`, commit: `fix: lock continue invalid state, pairing, and single overlay enter`

---

### Task 3: Session start path

**Files:** `newtab.js`, `onboarding.js`, `providers.js`, `options.js`, `options.html`, `tests/static-smoke.test.mjs`, `tests/providers.test.mjs`

**Fixes:**

1. `Lock in` sends `SESSION_STARTED` immediately. Do **not** `await generateIntentPlan` before start. Plan generation may run in background after start **only if** `isLlmConfigured()`; do not block the button. If the page unloads, do not start a second session (idempotent start is already session-id based — still start on click).
2. On start, if `mergePolicyWithIntent` exists, apply it to the session’s stored policy / `heuristicPolicy` for **this session** without rewriting global defaults unless that is already the function’s contract. Call it with the typed intent. Do not change scoring internals.
3. Stop writing `llmProviderConfig: { providerId: 'none' }`. Omit the key, or persist a real off state that `validateProviderConfig` accepts without coercing to OpenAI. Settings must not set `providerSelect.value = 'none'` if that is not an option. `getProvider` must not map unknown ids to OpenAI for **built-in request sending** when config is missing — keep existing fallback only when a provider was explicitly openai.

**TDD:**

- [ ] Test: `showNewSessionForm` / start path source no longer `await`s `generateIntentPlan` before `SESSION_STARTED` (static-smoke or extracted function).
- [ ] Test: onboarding does not persist `providerId: 'none'`.
- [ ] Test: unknown provider id does not become a live OpenAI send when user never chose OpenAI (align with `isLlmConfigured` false).
- [ ] Implement, `npm test`, commit: `fix: start sessions without waiting on unused plan generation`

---

### Task 4: Popup, report, analytics

**Files:** `popup.js`, `popup.html`, `newtab.js`, `analytics.js`, `analytics.html`, `history.js`, `tests/static-smoke.test.mjs`

**Fixes:**

1. Idle popup with last history entry labels it `Last session` (not a live quote). Empty idle stays `No active session.`
2. Popup End session uses the same confirm as new tab (`showConfirmEndDialog` or shared copy).
3. Replace `#888` / `0.7rem` inline styles with classes using `--muted`.
4. Session report (`showSummary` / `?report=last`) reads `session.overrides` (fallback to `events` OVERRIDE) so reflections survive sanitization.
5. Analytics empty state includes a next action link to `newtab.html`. Analytics handles storage failure with visible error copy.
6. `.popup-link` min-height 44px, inline-flex, tokens not hex.
7. Do not put the full dashboard on the active vow. After end, newtab may show the existing summary **or** a short “Last session ended” plus link to `analytics.html` — prefer keeping `showSummary` working with overrides (activation metric) rather than deleting it.

**TDD:**

- [ ] Test: popup idle HTML includes `Last session` when rendering history without active session.
- [ ] Test: `showSummary` uses `session.overrides` when `events` is missing.
- [ ] Test: analytics.html has a new-tab CTA; CSS `.popup-link` has min-height 44px.
- [ ] Test: no `#888` in popup.js / newtab.js.
- [ ] Implement, `npm test`, commit: `fix: popup last-session labeling and report overrides`

---

### Task 5: Accessibility

**Files:** `newtab.css`, `options.js`, `options.html`, `history.html`, `popup.html`, `analytics.html`, `intervention.html`, `diagnostics.html` (if present), `tests/static-smoke.test.mjs`

**Fixes:**

1. Category radios: do **not** `display: none`. Visually hide (`opacity: 0; position: absolute; width: 1px; height: 1px; clip`) so they stay in tab order. Labels min-height 44px.
2. Tracking toggle: remove `outline: none` that beats `:focus-visible`. Keep the 44×44 hit box.
3. Add `<meta name="viewport" content="width=device-width, initial-scale=1">` to every extension HTML page missing it.
4. History search: `<label for="history-search">`.
5. Theme chips and history filters: `aria-pressed` on the selected control.
6. `.history-meta` and `.diagnostics-meta` get `font-variant-numeric: tabular-nums`.
7. `h1` / `.intent-statement` get `text-wrap: balance`.

**TDD:**

- [ ] Test: `newtab.css` category radios are not `display:\s*none`.
- [ ] Test: tracking-toggle input does not set `outline:\s*none` without a `:focus-visible` replacement on the hit box.
- [ ] Test: popup/options/analytics/intervention HTML include viewport meta.
- [ ] Implement, `npm test`, commit: `fix: keyboard-reachable policy radios and extension a11y`

---

### Task 6: Visual tokens, motion leftovers, copy

**Files:** `newtab.css`, `newtab.js`, `options.js`, `onboarding.js`, `README.md`, `background.js` (copy already in task 1), `intervention-overlay.js`, `tests/static-smoke.test.mjs`

**Fixes:**

1. Either add `@font-face` with bundled woff2 under `fonts/` (and allowlist in `package-release.mjs` + manifest `web_accessible_resources` **not** required for extension pages) **or** if bundling is blocked, stop claiming `"IBM Plex Mono"` / `"Source Serif 4"` as first-choice families in CSS comments only — **prefer bundling** Regular (and Italic for serif) OFL files. If network fetch of fonts fails, use system stacks already in the fallback list and add a smoke test that `newtab.css` still names the VV families **or** documents fallbacks only — do not leave a lie. If you cannot vendor files, keep the names with fallbacks (status quo) and skip — **required:** no new hex greys.
2. `theme === 'auto'` follows `prefers-color-scheme: dark` (add `theme-dark` when OS is dark). Light/Dark chips still force. Lock (`body.intervention` / overlay) stays inverted regardless.
3. Shortcuts modal: use `Command` / `⌘` on Mac (`navigator.platform` / `navigator.userAgentData`), not always `Ctrl`. Title `Keyboard shortcuts` (sentence case).
4. README first-run copy matches wizard: `Declare your intent.` not `Welcome`.
5. Confirm/shortcuts overlays: class-based opacity transition both ways; JS fallback ≤ 180ms. Fade the scrim only, not nested dialog+scrim double fade.
6. Options status: `160ms ease-out` not `200ms cubic-bezier(0.2, 0, 0, 1)`.
7. Theme swap: no full-page `opacity: 0.6` dim.
8. `button:active` transform is included in the button `transition` list.
9. Rename leftover `showStep3` to the actual second step function name if you touch onboarding; keep behavior.
10. Delete **unused** CSS for `#intent-preset`, `#session-strictness`, `.plan-list`, `.plan-step`, `.api-notice` only if nothing in JS/HTML references them (grep first).
11. Status/history/diagnostics left rails: `border-left-width: 1px` not 2px.

**TDD:**

- [ ] Test: `theme auto` applies dark class when matchMedia dark (unit or options source).
- [ ] Test: shortcuts heading sentence case; no `Keyboard Shortcuts` title case.
- [ ] Test: README does not say `Welcome to IntentLock` as the in-product heading.
- [ ] Test: no `outline: none` regressions; static-smoke still has VV tokens.
- [ ] Implement, `npm test`, commit: `fix: auto theme, shortcut copy, and leftover motion timing`

---

### Task 7: Pages workflow pins

**Files:** `.github/workflows/pages.yml`, `tests/manifest-runtime.test.mjs`

**Fixes:**

1. Pin `actions/checkout` to the same SHA as `test.yml` (`11bd71901bbe5b1630ceea73d27597364c9af683`).
2. Pin `peaceiris/actions-gh-pages` to a full 40-char SHA for the current v4 tag (resolve via GitHub; do not leave `@v4`).
3. Extend the immutable-action-references test to include `.github/workflows/pages.yml`.
4. Prefer `persist-credentials: false` on checkout.

**TDD:**

- [ ] Failing test: pages.yml `uses:` must match `/^[0-9a-f]{40}$/`.
- [ ] Implement pins, `npm test`, commit: `fix: pin GitHub Pages actions to immutable SHAs`

---

### Task 8: Docs and leftover copy

**Files:** `docs/TASKS.md`, `docs/store-assets-plan.md`, `docs/architecture.md`, `docs/development.md`, `history.js`

**Fixes:**

1. `docs/TASKS.md` — mark IL-2/IL-4 to match shipped behavior (vow-only declare; week glance on analytics/popup summary, not presets on declare).
2. `docs/store-assets-plan.md` blurb must match `store/LISTING.md` (not LLM-first).
3. Architecture/development inventory includes `analytics.js`, `onboarding.js` if those docs list modules.
4. `history.js` comment: do not claim history is persisted on sanitize if it only displays a pruned copy.

**TDD:**

- [ ] If there is a static test for listing copy, update it. Otherwise grep-based smoke is enough.
- [ ] `npm test`, commit: `docs: align tasks and store copy with shipped 1.6.0 UI`
