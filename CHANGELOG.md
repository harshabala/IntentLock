# IntentLock Changelog

## [Unreleased] — production hardening

### Security
- API keys live only in `chrome.storage.session`; no local-storage fallback is written or read. Without session storage a key cannot be saved and AI stays off.
- A saved key is removed when the provider, custom endpoint, auth placement or API style changes without a new key, so it is never sent to a new destination.
- AI verdicts must be a plain object with a boolean verdict and a 0–1 confidence; anything else cannot lock.

### Privacy
- Page titles are no longer collected or stored.
- Sessions not ended within 24 hours end automatically; history and diagnostics are pruned in storage at startup and hourly.

### Fixed
- Dwell time counted cumulative reports repeatedly (90 s read as 180 s).
- Custom allows and session-related corrections can no longer be overruled by the dwell rule or optional AI.
- Custom block/allow rules cover subdomains, most specific rule wins; `m.`/`mobile.` hosts follow their base site.
- Legacy custom blocks of catalogued sites (e.g. GitHub) survive migration.
- Stack Overflow / Stack Exchange count as aligned for coding and learning sessions.
- Provider outages pause AI for one minute; rate limits honor `Retry-After`; opt-out aborts are not logged as failures.
- Corrupted stored events, history records or time budgets no longer crash ending a session or lock a tab at startup.
- Time budgets accept only blank or whole minutes 1–480; Settings no longer silently drops unrecognized domain lines and accepts pasted URLs.

### CI
- A Chromium job runs the browser journeys; every Node matrix run also validates the manifest version and builds the package.

## [1.6.0] — 2026-08-24

### Added
- MIT license
- GitHub Pages privacy policy
- Chrome Web Store listing pack under `store/`

### Changed
- First-run onboarding is welcome + default policy only; LLM stays in Settings
- README leads with a two-minute GitHub Release install
- Onboarding lives in `onboarding.js`
- Visualized Value UI: white/black pages, inverted lock, vow-only new tab
- Lock CTAs: Close this tab primary, Continue anyway after reflection
- Stats live in popup summary and analytics.html, not the new-tab vow

## [1.5.1] — 2026-08-18

### Fixed
- Made the MV3 content-script dependency chain load as ordered classic scripts.
- Added alarms permission and release checks for manifest/runtime assets.
- Added deterministic, allowlisted GitHub Release packaging and tag/version validation.

## [1.5.0] — 2026-06-22

### Added
- Heuristic self-setup engine (`heuristic-policy.js`): intent taxonomy (12 categories), site taxonomy (21 categories, 529 domains), policy schema with strictness presets, category-aware drift evaluator
- Onboarding step 3: intent category and strictness picker
- Settings category grid: per-category block/warn/allow controls replacing flat domain textarea
- Migration from legacy `customDistractionSites` flat list to `heuristicPolicy` schema
- Deterministic heuristics work with zero API key

## [1.4.0] - 2026-06-22

### Added
- In-page intervention overlay (shadow DOM) with tab-replacement fallback.
- Per-page dwell time tracking and SPA navigation detection via module content script.
- LLM drift response cache (60s TTL) to reduce redundant API calls.
- Dwell-aware heuristic drift scoring for extended time on unrelated pages.
- Shared `DRIFT_CONFIDENCE_THRESHOLD` (0.7) for heuristic and LLM drift checks.

### Changed
- LLM drift now requires confidence ≥ 0.7 before triggering intervention.
- Active session view shows monitoring hint for drift detection behavior.

## [1.2.1] - 2026-06-17

### Added
- Migrated OpenAI API key to secure session memory (`chrome.storage.session`) with automatic local storage migration on startup/options load.
- Added a minimalist 2-step onboarding wizard for first-run users.
- Added comprehensive unit tests for per-domain override cooldown logic.

### Fixed
- Scoped down host permissions in `manifest.json` from `<all_urls>` to explicit web protocols (`http://*/*` and `https://*/*`).
- Cleaned up state parser and options data resetting logic.
- Fixed an infinite intervention loop after override via the 5-minute per-domain cooldown.

## Version 1.2 — V1 Scope Tightening

### Fixed

- Added packaged PNG extension icons referenced by `manifest.json`.
- Removed unused extension permissions so the manifest only asks for V1 needs.
- Restored time-budget alarms when an active session is restored after service worker restart.
- Ensured time-budget interventions take over the active browsing tab when possible.
- Synced intervention override events back to the background session state.
- Avoided permanently storing detailed browsing event URLs in completed session history.
- Made "Delete all data" clear all local extension data, including API keys and configuration.
- Replaced native confirm dialogs with an inline two-step delete confirmation.
- Improved focus visibility, touch target sizing, responsive layout, and muted text contrast.

### Changed

- Kept V1 focused on behavior correction: intent declaration, optional time budget, active session tracking, drift intervention, local summary history, export, delete, and settings.
- Removed out-of-scope habit-tracking and analytics surfaces such as goals, session favorites, event-log inspection, passive budget notifications, onboarding progress, break customization, and quick-start intent shortcuts.
- Added local heuristic drift scoring for known distraction domains, repeated unrelated browsing, and rapid context switching.
- Added Node smoke tests for manifest assets, JavaScript parsing, V1 scope constraints, and drift scoring.

## Version 1.1 — Baseline

- New tab override with intent declaration form.
- Optional time budget per session.
- LLM-powered plan generation and drift detection when an OpenAI API key is configured.
- Configurable distraction site detection.
- Full-page intervention on drift detection.
- Reflection prompt requiring user input to override.
- Session summary history, JSON export, and local data deletion.
- Tracking toggle, theme preference, keyboard shortcut, tab grouping, and idle context-switch checks.
