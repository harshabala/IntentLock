# Chrome Web Store listing — IntentLock

Paste-ready fields for the Chrome Web Store developer dashboard.

## Name

IntentLock

## Short description

Declare your intent. IntentLock watches your tabs and locks the page when you drift. Local lock works with no API key.

## Full description

IntentLock enforces the browsing intent you declare before you start a session.

1. Open a new tab and declare what you intend to do (optional time budget).
2. IntentLock watches your tabs. Local lock runs with no API key.
3. If you drift, the page locks. Reflect in writing to continue, or close the tab / end the session.

Local-only by default: session data stays on this device. No accounts, sync, telemetry, or habit dashboard.

Optional AI is a second opinion only — configure a provider later in Settings if you want one.

Until Chrome Web Store review completes, install from the GitHub Release zip: enable Developer mode → Load unpacked → select the unzipped folder. See https://github.com/harshabala/IntentLock/releases/latest

## Category

Productivity

## Language

English

## Privacy

### Single purpose

Enforce declared browsing intent: monitor tab activity against the user’s stated session goal and intervene when behavior drifts.

### Privacy policy URL

https://harshabala.github.io/IntentLock/privacy.html

### Permissions justification

- **tabs** — Detect tab switches and active URLs so drift checks can run against the declared intent.
- **storage** — Persist session state, settings, and bounded local history on this device.
- **idle** — Detect idle / context-switch signals used by intervention rules.
- **tabGroups** — Group session-related tabs to keep the workspace aligned with the active intent.
- **alarms** — Fire time-budget and deferred drift checks when the service worker is suspended.
- **Host permissions (`http://*/*`, `https://*/*`)** — Inject the page overlay and measure dwell on browsed pages so interventions can lock the current site.

## Install note (pre-CWS)

Use the GitHub Release zip and **Load unpacked** until Chrome Web Store review completes:
https://github.com/harshabala/IntentLock/releases/latest
