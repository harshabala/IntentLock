# Browser journeys and pilot implementation plan

> Execute with subagent-driven-development: fresh implementer, spec review, then quality review for each task.

**Goal:** Make browser behavior reproducible and prepare a voluntary one-week usefulness pilot.

**Architecture:** Keep runtime dependencies and production behavior unchanged unless a journey reproduces a defect. Browser-only development tooling runs an unpacked MV3 extension in a disposable profile against local fixtures. Pilot documentation collects no browsing history or secrets and makes no claims about results before a study runs.

**Tech stack:** Existing Node tests, Chromium with browser automation as a development dependency, Markdown study materials.

## Task 1: Browser journey suite

- [x] Add a separate `npm run test:browser` command, pinned development dependency/lockfile if needed, disposable profile, localhost fixtures, bounded waits, cleanup, and actionable missing-browser instructions. Keep default Node test glob working and packaging free of test dependencies.
- [x] Exercise actual extension pages and worker: first-run wizard/rehearsal/start without a key; blank budget semantics; related work remains usable; unrelated blocked destination triggers a real lock; blank reflection rejection; successful reflection and session-scoped related exception; reload persistence; independent tabs; opt-out and deletion.
- [x] Use synthetic intent and origins only. Do not contact cloud providers or real user profiles. Mark browser restart/window, accessibility assistive-tech, and provider races as manual where not automated. Do not silently skip unavailable browsers or simulate extension behavior and call it browser coverage.
- [x] Run baseline and browser checks, record truthful evidence and uncovered cases in `docs/browser-journeys.md`. Fix narrowly scoped reproducible defects with regression coverage; report larger product decisions.
- [x] Commit and obtain independent spec then quality review.

## Task 2: Pilot and current acceptance guide

- [x] Create `docs/pilot/README.md` and reusable consent/feedback/results templates for a voluntary seven-day pilot of 5–8 adults doing normal knowledge work. No outreach, telemetry, names, raw intents, URLs, recordings, or fabricated results.
- [x] Define day-one unassisted setup, ordinary sessions, helpful/wrong/missed interventions, completion and disable reasons; define denominators and distinguish judged intervention precision from recall (misses require separately reported opportunities). Counts are optional, locally recorded, and voluntarily shared.
- [x] Set provisional go/no-go targets, small-sample caveats, explicit unknown/not-run results, withdrawal/deletion guidance, and a proposed study retention period requiring owner approval before enrollment.
- [x] Update `docs/manual-acceptance.md` for v1.6.0 with run metadata, restart/windows, keyboard/zoom/reduced motion, network/storage/provider/deletion boundaries and links to automated coverage. Do not mark manual checks passed without execution.
- [x] Link the suite and pilot from development documentation. Review for scope, privacy and usability; commit and obtain spec then quality review.

## Completion

- [x] Run unit/static/version/package and browser checks appropriate to final changes. Record exact results and blockers.
- [x] Final independent review. Preserve branch for review; prior user authorization permits GitHub publication when ready, but no study recruitment or release/store publication is authorized here.

## Execution status — 2026-09-06

Task 1: implemented in `02a182f`, with explicit-block precedence correction in `b45d14b`. Independent spec review and quality review approved. Task 2: implemented in `ad376bf`, with retention-approval wording corrected in `fcc9d2f`; independent spec and quality reviews approved. Final branch review approved `195f57f..fcc9d2f` with no remaining findings in scope.

Verification evidence: 241 baseline Node tests; 246 after fixes; two real Chromium journeys passed after the final runtime correction; 73 static checks passed. Version 1.6.0 validation, packaging, ZIP integrity and whitespace checks passed. See `docs/browser-journeys.md` for commands, dates, browser version, regressions and explicit coverage limits. No broad tests were repeated solely for the subsequent documentation edits.

These completed tasks deliver the browser suite and pilot preparation. The participant study and remaining manual acceptance checks are NOT RUN. Enrollment, study-note retention, contact/channel and dates remain pending explicit owner confirmation; no recruitment, participant data collection, release or store publication occurred.
