# IntentLock Post-Merge Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate the confirmed runtime, heuristic, UX, privacy, and infosec issues found in the v1.5.1 post-merge review without weakening IntentLock’s enforcement or privacy guarantees.

**Architecture:** Keep the service worker as the authority for session lifecycle, policy snapshots, deletion, and intervention state. Extension pages communicate through validated messages instead of direct active-session writes. Heuristic decisions use explicit HTTP(S)-only URLs, delta-based dwell accounting, normalized host/path matching, and a per-session policy snapshot.

**Tech Stack:** Chrome MV3 extension, vanilla JavaScript modules/classic content scripts, Node’s built-in test runner, deterministic release packaging.

---

### Task 1: Make session lifecycle authoritative and race-safe

**Files:**
- Modify: `background.js`, `content.js`, `newtab.js`, `popup.js`, `intervention-overlay.js`, `intervention.js`
- Test: `tests/background.test.mjs`, `tests/static-smoke.test.mjs`, `tests/intervention-overlay.test.mjs`

- [ ] **Step 1: Write failing lifecycle tests** for rejecting starts when tracking is disabled or another active session exists; queued intent edits requiring the expected session ID; failed end-session responses; and rehydrated intervention state including the active intent.
- [ ] **Step 2: Run the focused tests and verify the new assertions fail for the current implementation.**
- [ ] **Step 3: Route session start, intent edit, and end-session operations through the background mutation queue. Return `{status: "error"}` for rejected or failed operations and only update UI after confirmed success.
- [ ] **Step 4: Guard content tracking against disabled tracking and reject non-HTTP(S) URLs with an explicit allowlist.
- [ ] **Step 5: Persist or return the session intent with intervention state and make fallback dismissal idempotent.
- [ ] **Step 6: Run focused tests, then the full suite, and commit `fix: make session lifecycle authoritative`.

### Task 2: Correct dwell evaluation and policy matching

**Files:**
- Modify: `heuristic-policy.js`, `background.js`, `page-tracker.js`
- Test: `tests/heuristic-policy.test.mjs`, `tests/background.test.mjs`, `tests/page-tracker.test.mjs`, `tests/drift.test.mjs`

- [ ] **Step 1: Add failing tests** for static-page dwell triggering, delta-only dwell accumulation, load counts excluding dwell snapshots, per-tab debounce, subdomain matching, path-specific matching, and HTTP(S)-only evaluation.
- [ ] **Step 2: Run focused tests and confirm they fail for the current behavior.
- [ ] **Step 3: Evaluate drift on relevant `PAGE_DWELL` events, accumulate `dwellDeltaMs` exactly once, and count only page-load/navigation events as loads.
- [ ] **Step 4: Normalize catalog entries into hostname plus optional path rules, resolve the longest matching parent domain, and support overlapping categories without first-write loss.
- [ ] **Step 5: Add `deep_work` and `writing` alignment mappings, use token boundaries for intent matching, require an unaligned destination for idle/context-switch triggers, and key debounce state by session/tab/url.
- [ ] **Step 6: Make custom allow/block precedence explicit, scope related-domain marks to the current session or expire them, and flush the final dwell delta before finalizing metrics.
- [ ] **Step 7: Run focused and full tests, then commit `fix: correct dwell and policy evaluation`.

### Task 3: Make deletion and provider secrets a hard privacy boundary

**Files:**
- Modify: `storage-queue.js`, `background.js`, `providers.js`, `options.js`, `newtab.js`, `content.js`, `error-log.js`, `privacy-utils.js`
- Test: `tests/providers.test.mjs`, `tests/background.test.mjs`, `tests/error-log.test.mjs`, `tests/static-smoke.test.mjs`

- [ ] **Step 1: Add failing tests** proving delete-all aborts active provider controllers, blocks a fetch that races with deletion, prevents cross-context writes from resurrecting storage, and redacts provider response bodies before diagnostics persist.
- [ ] **Step 2: Run focused tests and verify the deletion/privacy assertions fail.
- [ ] **Step 3: Add a persisted deletion generation/tombstone checked before every extension-page write, and route active-session/provider-setting writes through the background authority where possible.
- [ ] **Step 4: Abort and await in-flight provider requests when deletion starts; keep deletion state consistent on success and failure.
- [ ] **Step 5: Remove or clearly surface persistent API-key fallback, remove legacy aliases on provider changes, redact provider body content to structured status only, and warn about query-auth keys.
- [ ] **Step 6: Persist origin-only active-session URLs without query/fragment/title data, bound abandoned-session retention, and document that exports/downloads are outside extension-managed deletion.
- [ ] **Step 7: Run focused and full tests, then commit `fix: enforce deletion privacy boundary`.

### Task 4: Align defaults and make the start flow honest

**Files:**
- Modify: `newtab.js`, `heuristic-policy.js`, `options.html`, `options.js`, `llm.js`
- Test: `tests/heuristic-policy.test.mjs`, `tests/static-smoke.test.mjs`, `tests/llm.test.mjs`

- [ ] **Step 1: Add failing tests** for intent classification at submit time, consistent fallback policy, per-session policy snapshots, real time-budget defaults, and async plan generation.
- [ ] **Step 2: Run focused tests and confirm the current `job_search`/`deep_work` mismatch and blocking plan flow fail the intended assertions.
- [ ] **Step 3: Classify free-text intent, display the detected category for confirmation, use one neutral fallback when confidence is low, and snapshot the chosen policy into the session.
- [ ] **Step 4: Make the 30-minute value an actual default with an explicit no-limit choice; reject non-integer values instead of using permissive `parseInt` behavior.
- [ ] **Step 5: Start the session immediately and generate an optional AI plan asynchronously with a visible non-blocking status.
- [ ] **Step 6: Run focused and full tests, then commit `fix: align session defaults and startup flow`.

### Task 5: Repair UI accessibility, validation, and visual integrity

**Files:**
- Modify: `newtab.css`, `newtab.html`, `newtab.js`, `options.html`, `options.js`, `history.html`, `history.js`, `intervention-overlay.js`, `intervention.css`
- Test: `tests/static-smoke.test.mjs`, `tests/intervention-overlay.test.mjs`

- [ ] **Step 1: Add static assertions** for valid stylesheet structure, accessible policy controls, labelled search/edit fields, visible validation, focus announcements, and reduced-motion-safe controls.
- [ ] **Step 2: Run focused static checks and confirm they fail for the current CSS and accessibility gaps.
- [ ] **Step 3: Replace bare CSS prose with comments, close malformed blocks, replace `transition: all`, and restore predictable focus-visible outlines and AA contrast.
- [ ] **Step 4: Use fieldsets/radiogroups or visually-hidden-but-focusable radios, announce loading/session transitions, move focus to new headings, and provide inline reflection/edit/time validation.
- [ ] **Step 5: Add clear empty-filter history messaging, accessible pressed states, 40–44px touch targets, and an explicit data-inventory/privacy explanation in Settings.
- [ ] **Step 6: Run focused and full tests, then commit `fix: improve extension accessibility and feedback`.

### Task 6: Harden release and browser-level acceptance coverage

**Files:**
- Modify: `manifest.json`, `.github/workflows/release.yml`, `docs/manual-acceptance.md`, `README.md`, `tests/manifest-runtime.test.mjs`, `tests/static-smoke.test.mjs`
- Test: package installation and release checks

- [ ] **Step 1: Add failing checks** for the declared Chrome floor, HTTP(S)-only runtime invariant, packaged archive integrity, and tag provenance expectations.
- [ ] **Step 2: Run the checks and verify they fail before the release hardening changes.
- [ ] **Step 3: Declare the supported Chrome floor or add compatibility fallbacks, validate release tags against reviewed `main`, and publish artifact checksums/provenance metadata.
- [ ] **Step 4: Expand manual acceptance for worker restart, browser restart, active deletion/provider requests, two-tab sessions, accessibility, unsupported URLs, and exact ZIP installation.
- [ ] **Step 5: Run `npm test`, `npm run verify:static`, `npm run validate:version`, `npm run package`, and archive integrity checks; commit `test: expand browser and release acceptance`.

### Final review gate

- [ ] Dispatch a final read-only reviewer against the complete branch diff and resolve all Critical/Important findings.
- [ ] Run the complete verification suite again and use the finishing-a-development-branch workflow to present merge/PR/keep/discard options.
