# IntentLock — Work Done & Context Summary
**Generated**: July 10, 2026  
**Primary Repository Path**: `/Users/harshabalakrishnan/Documents/Projects/IntentLock`  
**Base Branch**: `feat/flow-metrics-2026-07`

---

## 1. Executive Summary & Parallel Worktree Structure

To accelerate execution and keep task isolation clean, we structured our development across 5 isolated Git worktrees rooted at `/Users/harshabalakrishnan/Documents/Projects/IntentLock*`:

| Worktree Path | Branch Name | Task | Status | Commit SHA | Verification |
|---|---|---|---|---|---|
| `IntentLock` | `feat/flow-metrics-2026-07` | **IL-1**: Session Report & On-Intent % | ✅ Complete | `f7bcb93` | 125/125 tests passing |
| `IntentLock-il2` | `feat/il-2-session-form` | **IL-2**: Start Session Preset & Expectation | ✅ Complete | `c90b770` | 125/125 tests passing |
| `IntentLock-il3` | `feat/il-3-teach-overlay` | **IL-3**: Intervention Overlay & Mark-Related | 🔄 In Progress | `f7bcb93` (Base) | Specification finalized |
| `IntentLock-il4` | `feat/il-4-weekly-glance` | **IL-4**: Weekly Glance & Text Export | ✅ Complete | `0a84599` | 125/125 tests passing |
| `IntentLock-il5` | `feat/il-5-onboarding-default` | **IL-5**: Onboarding Redesign & Detection Mode | ✅ Complete | `52a64b8` | 125/125 tests passing |
| `IntentLock` | `feat/flow-metrics-2026-07` | **DS-1 & DS-2**: Design Spells (Aura, Squish, Heartbeat, Snap, Stagger) | ✅ Complete | `21f7668` | 125/125 tests passing |

---

## 2. Detailed Task Implementation & Changes

### ✅ IL-1: Session Report & On-Intent % (Branch: `feat/flow-metrics-2026-07`, Commit: `f7bcb93`)
* **Goal**: Track active dwell time vs. aligned time, compute on-intent percentage (`onIntentRatio`), trigger a session post-report on session end (`ACTIVATION_EVENT`), and display historical metrics in the history list.
* **Key Implementations**:
  - `session-metrics.js`: Core dwell and domain tracking (`accumulateDwell`, `computeOnIntentRatio`, `qualifiesForActivation`, `topDomains`).
  - `background.js`: Dwell event processing, domain-level metrics accumulation, history enrichment, and activation state storage.
  - `history.js`: Added on-intent percentage display (`${Math.round(session.onIntentRatio * 100)}% on-intent`) inside `renderSessions()` right after session duration, and updated override hostname display to support both `o.hostname` and legacy `o.url`.
  - `docs/storage-schema.md`: Documented `activeSession.metrics`, `sessionHistory[]` enriched properties (`onIntentRatio`, `topDomains`, `overrides[].hostname`), and `activationState`.
  - `docs/TASKS.md`: Marked IL-1 (`Session report & on-intent metrics`) as `Done`.

### ✅ IL-2: Start Session Preset & Expectation (Branch: `feat/il-2-session-form`, Commit: `c90b770`)
* **Goal**: Enable users to select an intent category preset and strictness level when declaring their intent on the post-onboarding new tab form, while clearly setting expectations about flow tracking.
* **Key Implementations**:
  - `newtab.js`: Extended `showNewSessionForm(container, session, policies)` with:
    - Preset dropdown (`#intent-preset`) populated with all 12 categories from `INTENT_CATEGORIES`.
    - Strictness dropdown (`#session-strictness`) (`relaxed`, `balanced`, `strict`).
    - Copy line (`.field-hint`): *"We’ll show your on-intent % when you finish."*
  - Form Submit Binding (`bindForm()`): Checks selected preset and strictness before `generateIntentPlan()`. If different from stored settings, it generates and persists an updated `heuristicPolicy` via `chrome.storage.local.set({ heuristicPolicy })` and sends a `CONFIG_UPDATED` runtime message.
  - `newtab.css`: Added clean styling and focus rings for `#intent-preset`, `#session-strictness`, and `.field-hint`.

### 🔄 IL-3: Intervention Overlay Teach Mode & Mark-Related (Branch: `feat/il-3-teach-overlay`, In Progress)
* **Goal**: Move away from pure blocking toward teaching/coaching. When an intervention occurs, explain *why* (e.g., *"This looks like Social Media during Job Search (heuristic)."*) and allow users to mark the domain as related to their work (`markRelated`).
* **Specifications to Complete in `IntentLock-il3`**:
  - `heuristic-policy.js`:
    - Update `evaluatePolicyDrift()` to accept `relatedHostnames = []` as the 4th parameter and treat domains in `relatedHostnames` as aligned (`isAligned = true`).
    - Update `isUrlAligned()` to check against `relatedHostnames`.
    - Compose descriptive `reasonLabel`: ``This looks like ${siteCat.label} during ${intentCat.label} (heuristic).``
  - `intervention-overlay.js` & `intervention.html`/`js`: Add optional checkbox `#intentlock-mark-related` (*"This is related to my work"*) above override actions and pass `markRelated: Boolean(...)` when overriding.
  - `background.js`: In `handleOverlayOverride` / `handleOverride`, when `markRelated: true`, extract hostname and append to `relatedDomainMarks` (`chrome.storage.local`). Pass cached `Object.keys(this.relatedDomainMarks || {})` into `evaluatePolicyDrift` and `isUrlAligned`.

### ✅ IL-4: Weekly Glance & Text Export (Branch: `feat/il-4-weekly-glance`, Commit: `0a84599`)
* **Goal**: Provide an immediate weekly glance inside the extension popup and let users export their week's flow summary as clean text.
* **Key Implementations**:
  - `popup.html`: Updated script tag to `<script type="module" src="popup.js"></script>` to support modern ES module imports.
  - `popup.js`: Replaced legacy code with ES module logic importing `summarizeWeek`, `formatWeekExport`, and `PRIVACY_COPY` from `session-metrics.js`.
    - Renders **"This week"** section showing total sessions, average on-intent percentage (`avgOnIntentRatio`), best day (`bestDay`), and method caveats.
    - Added `#export-week-btn` (*"Export week as text"*) that copies formatted text via `navigator.clipboard.writeText()` or falls back to `URL.createObjectURL` Blob download.
    - Renders privacy badge at footer (`Stored only on this device. Never uploaded.`).
  - `newtab.css`: Added styles for `.week-glance`, `.glance-row`, `.export-week-btn`, and `.privacy-badge`.

### ✅ IL-5: Onboarding Redesign & Detection Mode (Branch: `feat/il-5-onboarding-default`, Commit: `52a64b8`)
* **Goal**: Make onboarding smoother by surfacing explicit detection mode radio options on Step 2 (`heuristic` vs `hybrid`) and reinforcing local privacy guarantees.
* **Key Implementations**:
  - `newtab.js`: Inside `showStep2()`:
    - Replaced generic toggle with a radio group (`.detection-mode-options`) allowing clear selection between **Heuristic mode** (Default, zero API key needed, rules-based) and **Hybrid mode** (Optional AI classification).
    - Added clear helper descriptions for both modes.
    - Updated Step 3 (`showStep3()`) privacy copy: *"All flow data and session metrics stay 100% locally on your device in `chrome.storage.local`. Nothing is ever uploaded or sold."*
  - `newtab.css`: Added responsive styling, hover states, and spacing for `.detection-mode-options`, `.mode-option`, `.mode-option-label`, and `.mode-option-desc`.

---

## 3. Storage & Runtime Schema Reference

### `chrome.storage.local` Keys Added/Modified
1. `activeSession`:
   ```ts
   activeSession: {
     id: string;
     intent: string;
     startTime: number;
     timeBudget: number | null;
     isActive: boolean;
     metrics?: {
       activeMs: number;
       alignedActiveMs: number;
       interventionCount: number;
       overrideCount: number;
       domains: { [hostname: string]: { activeMs: number; alignedMs: number } };
     };
   }
   ```
2. `sessionHistory[]`: Enriched with `onIntentRatio: number | null`, `topDomains[]`, and `overrides[].hostname`.
3. `activationState`:
   ```ts
   activationState: {
     activatedAt: number | null; // Date.now() on first qualifying session (≥10m) report view
     sessionId: string | null;
   }
   ```
4. `heuristicPolicy`:
   ```ts
   heuristicPolicy: {
     version: 1;
     intentCategoryId: string; // e.g. 'job_search', 'deep_work', 'coding'
     strictness: 'relaxed' | 'balanced' | 'strict';
     customBlockDomains?: string[];
     customAllowDomains?: string[];
   }
   ```
5. `relatedDomainMarks` (IL-3 Target):
   ```ts
   relatedDomainMarks: {
     [hostname: string]: { count: number; lastMarkedAt: number };
   }
   ```

---

## 4. Next Steps & Recommended Workflow

1. **Complete IL-3 Implementation**:
   Apply the exact `heuristic-policy.js`, `intervention-overlay.js`, `content.js`, `background.js`, and `intervention.html/js` edits in `/Users/harshabalakrishnan/Documents/Projects/IntentLock-il3`. Run `node --test tests/*.mjs` to confirm all unit tests pass, then commit on `feat/il-3-teach-overlay`.
2. **Merge & Resolve across Branches**:
   Merge | feat/il-2-session-form      | IL-2 | Completed | Yes       | Yes          |
| feat/il-3-teach-overlay     | IL-3 | Completed | Yes       | Yes          |
| feat/il-4-weekly-glance     | IL-4 | Completed | Yes       | Yes          |
| feat/il-5-onboarding-default| IL-5 | Completed | Yes       | Yes          | inside `/Users/harshabalakrishnan/Documents/Projects/IntentLock`.
3. **Run Final Suite**:
   Run `node --check *.js` and `node --test tests/*.mjs` on the merged `feat/flow-metrics-2026-07` branch to confirm 100% test passing before opening the final PR or tagging the release.
