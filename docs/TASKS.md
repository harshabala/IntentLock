# IntentLock — Flow + metrics tasks

Source: `~/Desktop/product-flow-metrics-task-list.md` · Branch: `feat/flow-metrics-2026-07`

| ID | Task | Status | Notes |
|----|------|--------|-------|
| IL-1 | End-of-session report + on-intent metrics | Done | `session-metrics.js`, dwell deltas, history fields, report UI, REPORT_VIEWED |
| IL-2 | Session form: preset + strictness + expectation copy | Pending | |
| IL-3 | Teach overlay + mark related | Partial | `isUrlAligned` + relatedHostnames in policy; overlay UI pending |
| IL-4 | Weekly glance in popup + export | Pending | Helpers in `session-metrics.js` |
| IL-5 | Onboarding heuristics-only default | Pending | |
| README | Novice + technical sections | Pending | |
| Ship | PR + merge | Pending | |

## Activation metric

- **Name:** `session_report_viewed_after_10_min_session` (`ACTIVATION_EVENT` in `session-metrics.js`)
- **Rule:** session duration ≥ 10 min **and** report viewed (`reportViewed: true`)
- **Storage:** `activationState` in `chrome.storage.local` only

## Privacy

All metrics stay on device. History stores hostnames, not full URLs/query strings for overrides.
