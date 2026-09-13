# Trust-first Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Do not mark a task complete before specification and quality reviews pass.

**Goal:** Resolve the approved privacy, detection, explanation, recovery and reliability gaps while preserving offline-first decisive enforcement.

**Architecture:** Worker-owned mutations with a persisted privacy epoch; session-only credentials; bounded minimized history; one pure policy evaluator; existing vanilla UI. Node regressions cover deterministic races and policy, real Chromium covers cross-context journeys.

**Tech Stack:** Chrome MV3, ES modules/classic content scripts, node:test, pinned Playwright 1.60.0, GitHub Actions.

## Resume here

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
  timestamp: now - (2 - i) * 30000, dwellMs, deltaDwellMs: 30000,
}));
// Feed real evaluator with coding/balanced policy and unrelated intent.
// Assert no 120-second dwell interruption; add fourth delta and assert one.
// Confirm the producer's actual delta field name before wiring this fixture.
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

2026-09-13: plan/design saved before runtime changes. Tasks 1–6 not started. Existing browser-journeys worktree clean at 5df4f3d; PR6 open draft. Subsequent agents must update this section with commits, review outcomes and next task before handoff.
