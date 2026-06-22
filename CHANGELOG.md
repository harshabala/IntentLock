# IntentLock Changelog

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
