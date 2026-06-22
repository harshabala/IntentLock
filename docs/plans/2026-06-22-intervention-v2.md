# Intervention V2 — Tighten Drift Flow

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Complete the partial intervention pipeline: LLM confidence gating, drift caching, per-page dwell time, SPA navigation tracking, and in-page overlay intervention (tab hijack as fallback).

**Architecture:** Content script module (`content.js`) imports `page-tracker.js` (dwell + SPA) and `intervention-overlay.js` (shadow-DOM UI). Background receives `CONTENT_EVENT` messages, logs enriched events, and calls `evaluateDrift`. `triggerIntervention` tries overlay via `tabs.sendMessage` first; falls back to `intervention.html` tab replacement. `drift-cache.js` provides in-memory TTL cache for LLM drift checks. `drift.js` exports shared `DRIFT_CONFIDENCE_THRESHOLD = 0.7`.

**Tech Stack:** Chrome MV3, ES modules, Node test runner

---

## Global Constraints

- `DRIFT_CONFIDENCE_THRESHOLD` is **0.7** — used by heuristics AND LLM drift
- LLM drift cache TTL is **60 seconds**, max **100 entries**
- Dwell report interval: **30 seconds**; significant dwell threshold: **120 seconds** (2 min) for heuristic boost
- Overlay uses **shadow DOM** — no page CSS bleed; matches IntentLock dark minimal aesthetic
- Tab replacement remains **fallback** when content script cannot inject (e.g. chrome:// pages)
- All new logic must have **Node unit tests** where testable (extract pure functions)
- Run `node --test tests/*.mjs` after each task — all must pass
- Bump version to **1.4.0** on final task; sync `/Users/harshabalakrishnan/Documents/Intentlock`

---

### Task 1: Drift threshold constant + LLM confidence gate

**Files:**
- Modify: `drift.js`
- Modify: `background.js`
- Modify: `tests/drift.test.mjs`
- Create: `tests/llm-threshold.test.mjs` (or extend existing)

**Steps:**
1. Export `DRIFT_CONFIDENCE_THRESHOLD = 0.7` from `drift.js`; use in `evaluateHeuristicDrift` instead of magic `0.7`
2. In `background.js` LLM path: only trigger when `!res.isAligned && res.confidence >= DRIFT_CONFIDENCE_THRESHOLD`
3. Add test for sub-threshold LLM result not intervening
4. Commit: `feat: enforce 0.7 confidence threshold for LLM drift`

---

### Task 2: LLM drift response cache

**Files:**
- Create: `drift-cache.js`
- Modify: `llm.js`
- Create: `tests/drift-cache.test.mjs`

**Steps:**
1. Implement `buildDriftCacheKey(intent, url, history)`, `getCachedDrift`, `setCachedDrift`, `clearDriftCache`
2. TTL 60s, max 100 entries, LRU-style eviction
3. Integrate in `checkDriftLLM` — return cached results without API call
4. Clear cache on `SESSION_STARTED` / `SESSION_CLEARED` in background
5. Tests: hit, miss, expiry, eviction
6. Commit: `feat: add TTL cache for LLM drift checks`

---

### Task 3: Page tracker — dwell time + SPA navigation

**Files:**
- Create: `page-tracker.js`
- Modify: `content.js`
- Modify: `manifest.json` (content script `type: "module"`)
- Modify: `background.js` (handle `CONTENT_EVENT`)
- Create: `tests/page-tracker.test.mjs`

**Steps:**
1. `page-tracker.js`: pure helpers + `createPageTracker(onReport)` 
   - Track active dwell time (pause on `document.hidden`)
   - Report every 30s, on hide, beforeunload
   - Patch `history.pushState`/`replaceState`, listen `popstate`
2. `content.js`: init tracker when session active; send `CONTENT_EVENT` messages
3. Background: `logContentEvent` → extend `logEvent` with `pageTitle`, `dwellMs`; trigger `evaluateDrift` on SPA nav
4. Tests for dwell accumulation and SPA URL detection helpers
5. Commit: `feat: per-page dwell time and SPA navigation tracking`

---

### Task 4: Dwell-aware heuristic scoring

**Files:**
- Modify: `drift.js`
- Modify: `tests/drift.test.mjs`

**Steps:**
1. Boost heuristic score when `PAGE_DWELL` events show ≥120s on unaligned URL (+0.25)
2. Boost +0.15 when on distraction domain with ≥60s dwell
3. May trigger intervention at score ≥ 0.7
4. Tests for dwell-boosted intervention
5. Commit: `feat: factor page dwell time into heuristic drift scoring`

---

### Task 5: In-page intervention overlay

**Files:**
- Create: `intervention-overlay.js`
- Modify: `content.js`
- Modify: `background.js`
- Modify: `newtab.css` (extract shared intervention styles OR duplicate minimal styles in overlay)
- Create: `tests/intervention-overlay.test.mjs` (test style/HTML builder pure functions)
- Modify: `tests/cooldown.test.mjs` (mock `tabs.sendMessage` for overlay-first flow)

**Steps:**
1. `intervention-overlay.js`: shadow DOM overlay with intent, reason, reflection textarea, Override & Dismiss buttons
2. `SHOW_INTERVENTION` message shows overlay; responds `{ shown: true }`
3. `OVERLAY_OVERRIDE` → background logs OVERRIDE, sets cooldown, hides overlay
4. `OVERLAY_DISMISS` → hide overlay, clear intervention state
5. `triggerIntervention`: overlay first, tab replacement fallback
6. Commit: `feat: in-page intervention overlay with tab-replace fallback`

---

### Task 6: UX polish, version bump, sync

**Files:**
- Modify: `newtab.js` (active session monitoring hint)
- Modify: `manifest.json` (version 1.4.0)
- Modify: `CHANGELOG.md`
- Sync: `/Users/harshabalakrishnan/Documents/Intentlock`

**Steps:**
1. Add one-line hint on active session: monitoring via tab switches, page loads, dwell time
2. Bump to 1.4.0, update CHANGELOG
3. Full test run, rsync loadable folder
4. Commit: `chore: v1.4.0 intervention v2 release`