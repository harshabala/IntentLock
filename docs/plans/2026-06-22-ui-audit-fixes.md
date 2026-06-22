# IntentLock UI Audit Fixes — Implementation Plan

**Goal:** Address the top 5 userinterface-wiki findings from the IntentLock UI audit.

**Architecture:** CSS token and utility updates in `newtab.css`; accessibility and modal behavior in `newtab.js`; progressive disclosure and validation in `options.html` / `options.js`; smoke tests in `tests/static-smoke.test.mjs`. Sync loadable copy to `/Users/harshabalakrishnan/Documents/Intentlock` after all tasks.

## Global Constraints

- Match existing IntentLock design system: monospace font, `--radius: 2px`, uppercase micro-labels, minimal B/W aesthetic.
- All modals must use `role="dialog"`, `aria-modal="true"`, focus trap, Escape to close, and focus restore on close.
- Checkbox tracking toggle must have minimum 44×44px hit area (Fitts's Law).
- Cloud LLM providers (openai, gemini, grok) show only Provider + API key by default; Model and endpoint hidden behind "Advanced" disclosure.
- Error states use a distinct `--error` color (not identical to `--text-primary`); invalid fields get `aria-invalid="true"` and linked error text via `aria-describedby`.
- All live numeric displays use `font-variant-numeric: tabular-nums` (timer, stats, popup time, summary rows).
- Respect `prefers-reduced-motion` — no new animations that ignore it.
- Run `node --test tests/*.mjs` before each task commit; all tests must pass.
- Do not refactor unrelated code.

---

## Task 1: Expand checkbox hit target

**Files:** `newtab.css`, `options.html` (if markup change needed)

Wrap or style the tracking toggle so the interactive hit area is at least 44×44px using label padding or pseudo-element expansion. Preserve visual 16px checkbox appearance if desired.

**Acceptance:**
- Tracking checkbox in options meets 44px minimum touch target
- No layout breakage in Privacy section

---

## Task 2: Modal focus trap and ARIA

**Files:** `newtab.js`, optionally `newtab.css`

Add reusable helper for modal dialogs used by `showConfirmEndDialog` and `showShortcutsModal`:
- `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at dialog heading
- Focus first focusable element on open
- Tab cycles within modal only
- Escape closes (existing behavior preserved)
- Restore focus to trigger element on close
- `shortcuts-btn` gets `aria-label="Keyboard shortcuts"`; use `textContent` not `innerHTML`

**Acceptance:**
- Both confirm and shortcuts modals are accessible
- Reduced-motion path still works

---

## Task 3: Progressive disclosure for LLM settings

**Files:** `options.html`, `options.js`, `newtab.css`

For cloud providers (openai, gemini, grok), hide Model and API endpoint fields behind a collapsible "Advanced" section (collapsed by default). Local providers (ollama, lmstudio) still show model/endpoint as needed. Custom provider shows all fields.

**Acceptance:**
- Gemini setup shows Provider + API key only by default
- Advanced expands to show model (and endpoint for local/custom)
- Existing save logic unchanged

---

## Task 4: Distinct error styling and aria-invalid

**Files:** `newtab.css`, `newtab.js`, `options.js`

- Set `--error` to a visually distinct value in light and dark themes
- Add `.field-error` style for inline error messages
- On validation failure in options (API key) and newtab (intent, onboarding key): set `aria-invalid`, show error text, link via `aria-describedby`
- Clear error state on input

**Acceptance:**
- Invalid API key shows visible error message, not just border
- Error color distinguishable from normal text

---

## Task 5: Tabular nums on all numeric UI

**Files:** `newtab.css`

Add `font-variant-numeric: tabular-nums` to:
- `.stat-box .stat-value`
- `.stat-value` (summary rows)
- `.time-remaining` (popup)
- Any other live numeric stat displays in CSS

**Acceptance:**
- Numbers in stats/timer/popup align consistently when values change

---

## Task 6: Sync loadable extension folder

**Files:** Copy runtime assets to `/Users/harshabalakrishnan/Documents/Intentlock`

Copy all extension runtime files (same set as prior sync). Verify manifest version unchanged unless intentionally bumped.

**Acceptance:**
- Loadable folder matches project runtime files