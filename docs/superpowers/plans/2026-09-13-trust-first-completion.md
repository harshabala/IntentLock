# Trust-first Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Do not mark a task complete before specification and quality reviews pass.

**Goal:** Resolve the approved privacy, detection, explanation, recovery and reliability gaps while preserving offline-first decisive enforcement.

**Architecture:** Worker-owned mutations with a persisted privacy epoch; session-only credentials; bounded minimized history; one pure policy evaluator; existing vanilla UI. Node regressions cover deterministic races and policy, real Chromium covers cross-context journeys.

**Tech Stack:** Chrome MV3, ES modules/classic content scripts, node:test, pinned Playwright 1.60.0, GitHub Actions.

## Resume here

- Current checkpoint: Task 1 specification approved at `13cb946`; independent quality review is running. Tasks 2–6 have not started. Do not mark Task 1 accepted until the quality gate passes. No current-turn runtime commits pushed yet. Execution-log entries below are historical checkpoints in order, not simultaneous current statuses.
- Working directory: `/Users/harshabalakrishnan/Documents/Projects/IntentLock/.worktrees/browser-journeys`.
- Branch: `feat/browser-journeys`; initial HEAD `5df4f3d5ac4b1fd9c0b34c32dc20ed299008e5c5`.
- Existing draft PR: https://github.com/harshabala/IntentLock/pull/6. Main is `195f57f20f2d9f7206e99fad74c987df65a3b96d`. Recheck before resuming.
- Read `../specs/2026-09-13-trust-first-design.md` relative to this plan directory. User approved the design direction and execution; do not restart brainstorming.
- Existing PR6 improvements and browser/pilot kit are prerequisites, not tasks to redo. Older August hardening worktrees are not authoritative.
- One implementation agent at a time. Give it the full current task text and this context. Fresh independent spec review, then fresh quality review. Fix findings with the implementer and re-review. Controller owns this progress record.
- Commit coherent verified changes. Preserve unrelated user changes. Never bypass sandbox denials, force-push, merge or publish a store release.
- Baseline: 246 Node tests, 73 static tests, two browser journeys; recheck before asserting current results.

## Task 1 — Durable privacy mutation boundary

Files: `storage-queue.js`, `background.js`, `newtab.js`, `options.js`, `error-log.js`, `history.js`, `analytics.js`, `diagnostics.js`; new `tests/storage-queue.test.mjs` and extensions to `tests/privacy.test.mjs`, `tests/background.test.mjs`.

- [ ] Write controlled-callback regressions for two runtime queues, delayed Settings save across completed deletion, stale start/end callbacks, worker reimport with deletion marker, and partial local/session clear failure. Assert storage contents, not just UI messages.
- [ ] Run `node --test tests/privacy.test.mjs tests/background.test.mjs tests/storage-queue.test.mjs`; record which new assertions fail before changing runtime.
- [ ] Implement persisted epoch initialization and a worker-owned serialized mutation protocol. Extension-page writes must use the protocol rather than independent local queues. Bind each asynchronous user action to the epoch it began in; recheck immediately at authoritative commit. Do not allow a new page to mint a fresh epoch for an old payload. Validate allowed mutation fields/senders; never offer arbitrary storage access to content scripts.
- [ ] Deletion advances/fences before clearing, rejects queued old work, hides locks and clears caches/alarms; completion retains only a non-personal epoch marker. A failed clear leaves the durable barrier active and an actionable retry. Worker revival resumes unfinished deletion before accepting collection.
- [ ] Readers that prune/sanitize may not write stale snapshots. Avoid nested queue deadlocks and logging during deletion. UI success requires a successful response; failure restores controls without losing input.
- [ ] Run focused tests, `npm test`, `npm run verify:static`, `git diff --check`; independently review spec then quality; commit `fix(privacy): Fence mutations across deletion and worker restarts`.

Protocol acceptance example (test through actual production handler using Chrome doubles):

```js
// Deferred callbacks must be controllable by the harness, not wall-clock sleeps.
const oldAction = { epoch: 7, values: { activeSession: { id: 'old' } } };
// After deletion advances persisted epoch to 8, dispatch oldAction.
// Assert response is a stale-operation error; activeSession remains absent.
// Reimport the worker against the same storage and assert the same rejection.
```

## Task 2 — Credential lifetime and provider cancellation

Files: `providers.js`, `llm.js`, `background.js`, `options.js`, `options.html`; tests `providers.test.mjs`, `llm.test.mjs`, `background.test.mjs`, new `credential-storage.test.mjs` if isolation needs it. A focused `credential-storage.js` module is allowed if it centralizes all key lifecycle operations; add it to packaging.

Integration notes from Task 1: `storage-authority.js` now owns `saveProvider`, `clearKey`, `tracking` and `migrateKeys`; extend those typed commands rather than introducing another writer. `captureErrorEpoch` fences deletion but does not by itself detect opt-out followed by immediate re-enable. Request validity therefore needs an authoritative privacy-change identity, not only a final `trackingEnabled` read or best-effort change-listener abort. `providers.js` currently releases its controller when headers arrive; cover body consumption too. Bind caches and downstream decisions to their originating session, and preserve the page-client action/reply epoch checks.

- [ ] Reproduce session `openaiApiKey`-only migration loss, failed canonical write, concurrent replacement, missing session area, and delayed response-body completion during deletion/opt-out/re-enable.
- [ ] Run `node --test tests/providers.test.mjs tests/llm.test.mjs tests/background.test.mjs` plus the new test file; observe specific failures.
- [ ] Canonical key is `chrome.storage.session.llmApiKey`; never read local aliases as request credentials or write new keys there. One serialized migration owner may read legacy sources, compare latest state and remove aliases only after verified persistence. Concurrent replacement wins. Missing session storage gives a visible error while heuristics remain operational.
- [ ] Add explicit Remove key, clear all aliases through Task 1 authority, clear key text on success and never display/log the stored secret. Ensure provider switching cannot send a saved key to a different destination without deliberate replacement.
- [ ] Hold cancellation until response body parsing finishes; invalidate request/coalescing/cache/UI results by privacy epoch and session identity. Abort best effort on opt-out/deletion, reject late results even after immediate re-enable. Do not promise to retract bytes already transmitted.
- [ ] Focused/full/static tests and reviews; commit `fix(privacy): Keep credentials ephemeral and reject stale AI results`.

## Task 3 — Retention and data minimization

Files: `privacy-utils.js`, `background.js`, `session-metrics.js`, `history.js`, `analytics.js`, `options.js`; `tests/privacy.test.mjs`, `tests/history-retention.test.mjs`, `tests/background.test.mjs`.

- [ ] Add tests using synthetic free text and secret-shaped URLs: unknown legacy fields removed; active events store origins; full restore URL only survives while locked; expired active session removed after 24 hours; summaries omit reflections/events; alarm pruning changes actual storage.
- [ ] Run focused tests and observe failures before implementation.
- [ ] Implement explicit summary field allowlist, origin-only event persistence, 24-hour abandoned-session expiry and startup/alarm pruning under Task 1 authority. Keep 30-day/100-summary and 14-day/200-error bounds. Do not erase the URL required to restore a currently locked page before resolution. Reconcile all retention consumers and empty/report states.
- [ ] Verify no raw paths/queries/reflections remain in the new summary/export; intentional bounded intent text remains accurately disclosed. Test unknown timestamps and malformed legacy fields without crashes.
- [ ] Focused/full/static tests and reviews; commit `fix(privacy): Minimize retained browsing and expire abandoned sessions`.

## Task 4 — Policy accounting, scope and calibration

Files: `heuristic-policy.js`, `drift.js`, `background.js`, `distraction-sites.js`, `session-metrics.js`; `tests/heuristic-policy.test.mjs`, `tests/drift.test.mjs`, `tests/distraction-sites.test.mjs`, new `tests/fixtures/policy-corpus.json` and `tests/policy-corpus.test.mjs`.

- [ ] Write table-driven regressions for: 30/60/90-second cumulative reports with 30-second deltas count 90 seconds, not 180; mobile YouTube follows the base rule; `youtube.com.evil.test` does not; explicit allow stays permitted after 120-second dwell; related correction survives AI; writing Docs and coding Stack Overflow are usable; YouTube API intent does not exempt Shorts; legacy custom GitHub block persists; explicitly empty custom list remains empty.
- [ ] Run focused tests and record the red cases. Use fixed timestamps, not sleeps.
- [ ] Count dwell deltas once, actual navigation events separately from dwell reports, ignore invalid/future evidence, and scope debounce per session/tab. Match host boundaries with most-specific explicit rule precedence; exact allow wins equal-scope conflicts as already documented. Related corrections cover host/descendants, never sibling/parent domains. Explicit allow controls enforcement, not relevance metrics or time budget.
- [ ] Preserve immediate explicit blocks. Do not infer relatedness from a hostname keyword alone or blanket-allow all forums/video. Add narrow productive-tool/technical-resource alignment and remove blanket research-forum alignment. Ambiguous tutorials remain correctable rather than claimed semantically understood from opaque URLs.
- [ ] Return structured reason/evidence with existing compatible evaluator fields. Background must honor authoritative allow/corrections before optional AI. Consolidate threshold authority without deleting legacy test coverage blindly.
- [ ] Version synthetic corpus with expected decisions, reason codes and strictness slices. Assert every labeled case; report false interruptions and missed drift separately. Synthetic labels are regression policy, not user evidence.
- [ ] Focused/full/static tests and reviews; commit `fix(policy): Correct evidence and enforce explicit rule scope`.

Starter accounting regression:

```js
const now = 180000;
const events = [30000, 60000, 90000].map((dwellMs, i) => ({
  actionType: 'PAGE_DWELL', url: 'https://unknown.example/',
  timestamp: now - (2 - i) * 30000, dwellMs, dwellDeltaMs: 30000,
}));
// Feed real evaluator with coding/balanced policy and unrelated intent.
// Assert no 120-second dwell interruption; add fourth delta and assert one.
// page-tracker.js emits dwellDeltaMs; preserve that producer contract.
```

## Task 5 — Explainable sessions and dependable UI

Files: `newtab.js`, `newtab.html`, `newtab.css`, `popup.js`, `popup.html`, `intervention.js`, `intervention.html`, `intervention-overlay.js`, `options.js`, `options.html`; Node DOM tests and browser journeys.

- [ ] Add failing tests for malformed budgets, rejected/missing end response, repeated pending clicks, expired fallback state, storage save failure, invalid domain lines, popup Tab/Shift+Tab/Escape and focus restoration.
- [ ] Validate budget with `/^[0-9]+$/` plus integer range 1–480; blank is null. Never silently truncate. Show inline error, focus field and send no start request on failure.
- [ ] Pending end/save/override actions disable duplicate submission; only verified success navigates or clears state. Failure preserves values and exposes retry. Invalid domain lines produce field-linked errors with no partial save.
- [ ] Distinguish fallback lookup failure from expired state. Retry lookup on failure; expired state has independent close/new-session actions. Failed tab close remains recoverable. Confirmation dialogs trap focus and Escape cancels; compulsory interventions retain their non-dismissable contract with explicit end/close alternatives.
- [ ] Before start show effective category/strictness, time budget, AI/offline status, and concise custom-rule counts; use the same merged policy as enforcement. Show actual reason/evidence at locks, explaining override duration, session correction and independent budget expiry. Do not expose raw diagnostic payloads or claim AI certainty.
- [ ] Keyboard DOM/browser regressions, responsive 320/768/1280 widths, 200% zoom and reduced-motion review. Record screen-reader checks separately if not available.
- [ ] Focused/full/static tests and reviews; commit `fix(ux): Explain decisions and recover safely from failed actions`.

## Task 6 — Browser reliability, CI and release evidence

Files: `tests/browser/fixtures.mjs`, `tests/browser/journeys.spec.mjs`, new `tests/browser/lifecycle.spec.mjs`, `playwright.config.mjs`, `.github/workflows/test.yml`, `docs/browser-journeys.md`, `docs/manual-acceptance.md`, `docs/architecture.md`, `docs/storage-schema.md`, `docs/privacy-policy.md`, `docs/site/privacy.html`, `docs/development.md`, `README.md`, `store/LISTING.md`, `docs/pilot/README.md`.

Documentation audit anchors (verify against final implementation, not anticipated behavior): README provider/key tables and both privacy-policy variants describe a local-key fallback. Storage schema describes alias keys, read-time-only pruning and retained reflections. Architecture omits the new storage authority/client modules and epoch-bound messages. Pilot README data disclosure currently says history retains reflection text. Replace these together after Tasks 2–5; avoid changing unimplemented behavior claims prematurely.

- [ ] Extend fixture with safe worker reacquisition and same-profile restart. Keep synthetic non-forwarding proxy, temp profile cleanup, actual production extension and browser sandbox. No test-only runtime backdoors or fake success skips.
- [ ] Add real same-URL/two-tab and separate-window locks, worker restart, browser restart/key expiry, deletion while locked, and a real time-budget expiry. Provider delayed-body/race tests may use a local synthetic server; clearly distinguish Node controlled races from browser evidence.
- [ ] Add separate Chromium CI job with pinned actions, read-only permissions, npm ci and browser installation. Preserve dependency-free Node matrix. Use failure artifacts with short retention containing synthetic data only; do not access secrets on PR runs.
- [ ] Run `npm test`, `npm run verify:static`, `npm run test:browser`, `npm run validate:version -- v1.6.0`, `npm run package`, archive integrity/listing and `git diff --check`. Record actual environment, counts, failures and remaining manual gates.
- [ ] Reconcile source-backed architecture/storage/privacy/install/update documentation; avoid claims that shadow DOM is tamperproof, all data anonymous, or keys securely erased from memory. Keep version 1.6.0 until an explicit release decision.
- [ ] Final independent spec then quality/security integration review. Push reviewed commits and update draft PR #6 under existing GitHub authorization. Inspect actual CI, remediate actionable failures, and record whether browser CI passed.
- [ ] Commit `test(release): Verify lifecycle journeys and document trust boundaries`.

## External acceptance gates — do not fabricate completion

- [ ] Real assistive-technology manual acceptance on a supported host.
- [ ] Pilot owner/contact/channel/retention approval and participant consent.
- [ ] Seven-day voluntary pilot, judged usefulness/coverage and continuation results per existing kit.
- [ ] Owner decision on merge, store submission and public release.

## Execution log

2026-09-13: plan/design committed as b83fda9 before runtime changes. Baseline rerun: 246 passed, zero failed/skipped. Task 1 implementation eeb926a adds worker authority plus storage-client.js/storage-authority.js and includes live onboarding/popup paths. Controller independently observed 266/266 Node and 73/73 static passing. Independent specification review and real-browser integration underway; task not yet accepted. Tasks 2–6 not started; PR6 open draft. Subsequent agents must update this section with commits, review outcomes and next task before handoff.

Task 1 review checkpoint: controller Chromium 148.0.7778.96 macOS arm64 journeys 2/2 passed in 8.7 seconds. Spec reviewer independently reproduced four gaps: delayed actual epoch-read can bless old payload; late provider diagnostic uses new epoch; stale intervention-state response can reopen deleted lock; initial marker-write failure permits idle collection. Implementer fixing with new regressions; quality review has not begun. Do not treat eeb926a as accepted or push it as completed hardening.

Task 1 follow-up f7de8a3: implementer reports 277/277 full and 73/73 static passing after reproducing/fixing four gaps and direct equivalents. Controller independently ran 25/25 storage regressions during the follow-up and final real Chromium journeys 2/2 passed in 14.6 seconds. Spec re-review underway; quality gate still pending. Key lifetime and actual network cancellation remain Task 2.

Task 1 second specification checkpoint: all four earlier reproduction probes pass; reviewer independently verified 277/277 full and 73/73 static. A delayed successful start/end reply can still render deleted data after deletion completes. Implementer is adding response-delivery regressions and fencing reply consumption before the next re-review. Task 1 remains unaccepted.

Task 1 reply follow-up 13cb946: nine new response/render regressions, origin-epoch reply validation and guarded UI continuations. Controller independently verified full 286/286 and actual Chromium 2/2 in 9.7 seconds; implementer static 73/73. Specification re-review pending; quality review has not started. Main checkout remains clean.

Task 1 specification accepted at 13cb946: reviewer independently reproduced both delayed response delivery and deletion between accepted reply and rendering, verified fresh post-deletion actions remain usable, and passed 286/286 full plus 73/73 static. Fresh quality reviewer now inspecting b83fda9..13cb946; implementer retained for any fixes.

Production hardening pass on `harden/production` (2026-09-27, stacked on 17d2388, not pushed): Task 2 key storage (session-only, verified migration, destination-bound keys, no local fallback), parts of Task 3 (24-hour abandoned-session expiry, startup/alarm pruning, page titles no longer stored), parts of Task 4 (dwell deltas counted once, invalid/future evidence ignored, explicit allow/related corrections authoritative over dwell and AI, label-boundary custom rules with most-specific precedence, mobile hosts, legacy GitHub block, narrow technical Q&A alignment), parts of Task 5 (budget validation, field-linked domain errors) and Task 6 CI (browser job, version/package checks). Node 342/342 (+ 74 static), Chromium journeys 2/2 locally on 148.0.7778.96. Not done: origin-only event persistence, summary field allowlist and reflection omission, research-forum alignment removal, versioned policy corpus, Task 5 explanation/keyboard work, lifecycle browser journeys. Dwell rules are only evaluated on navigation/tab events, so the 120-second rules rarely fire in place; enabling in-place evaluation changes interruption rates and needs an owner decision. Browser CI job is unverified until pushed.
