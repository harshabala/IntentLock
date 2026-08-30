# IntentLock — Flow + metrics tasks

Source: `~/Desktop/product-flow-metrics-task-list.md` · Branch: `feat/flow-metrics-2026-07`

| ID | Task | Status | Notes |
|----|------|--------|-------|
| IL-1 | End-of-session report + on-intent metrics | Done | `session-metrics.js`, dwell deltas, history fields, report UI, REPORT_VIEWED |
| IL-2 | Session form: vow-only declare (no presets on declare) | Done | Shipped vow-only: intent + optional minutes; presets/strictness stay in onboarding/Settings |
| IL-3 | Teach overlay + mark related | Partial | `isUrlAligned` + relatedHostnames in policy; overlay UI pending |
| IL-4 | Weekly glance on analytics + popup summary | Done | Week glance in `analytics.js`; popup is compact summary + View stats (not full glance/export) |
| IL-5 | Onboarding heuristics-only default | Done | Welcome + default policy only; LLM in Settings |
| README | Novice + technical sections | Done | Two-minute GitHub Release install path |
| Ship | PR + merge | Done | 1.6.0 ship docs (LICENSE, privacy site, store pack); CWS approval not claimed |

## Activation metric

- **Name:** `session_report_viewed_after_10_min_session` (`ACTIVATION_EVENT` in `session-metrics.js`)
- **Rule:** session duration ≥ 10 min **and** report viewed (`reportViewed: true`)
- **Storage:** `activationState` in `chrome.storage.local` only

## Privacy

All metrics stay on device. History stores hostnames, not full URLs/query strings for overrides.
