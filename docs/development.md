# Development Guide

---

## Prerequisites

- Chrome (any recent version supporting MV3)
- Node.js 18+ (for running tests — not needed for the extension itself)
- Loading the extension and running Node tests require no dependency install or bundler. Packaging uses Node and the system `zip` utility. The separate browser suite needs npm dependencies and Playwright's Chromium.

---

## Loading the extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (toggle, top right)
3. Click **Load unpacked**
4. Select the repo folder (`/path/to/IntentLock`)
5. Open a new tab — the onboarding wizard appears

### After code changes

| What changed | How to reload |
|-------------|--------------|
| `background.js` or any imported module | Extensions page → refresh icon on the IntentLock card |
| `content.js`, `page-tracker.js`, `intervention-overlay.js` | Extensions page refresh **+** reload the affected tab |
| `manifest.json` | Extensions page refresh (same as above) |
| `newtab.js`, `onboarding.js`, `options.js`, `popup.js`, `analytics.js` | Close and reopen the page/popup |
| `heuristic-policy.js` | Extensions page refresh (background imports it) |

The reload button is the circular arrow (↻) under the extension card in `chrome://extensions`.

---

## Loadable folder sync

The extension is loaded from the repo directly. If you keep a separate "loadable" copy at a different path (e.g. `/Users/you/Documents/Intentlock`), sync it manually:

```bash
rsync -a --exclude='.git' --exclude='node_modules' \
  /path/to/IntentLock/ /path/to/Intentlock/
```

Or just point Chrome at the repo folder and avoid the sync entirely.

---

## Running tests

```bash
# Single suite
node --test tests/heuristic-policy.test.mjs

# All dependency-free Node suites (not browser journeys)
npm test

# Verbose (shows individual test names)
node --test --test-reporter=spec tests/*.test.mjs

# Manifest, runtime reference, workflow, packaging, and version checks
npm run verify:static
npm run validate:version -- v1.6.0

# Deterministic release artifact (writes to dist/ by default)
npm run package
```

The Node suites use built-in `node:test` + `assert/strict`; `npm test` needs no
dependency install and does not discover browser tests. Run the opt-in real
browser suite separately:

```bash
npm ci
npx playwright install chromium
npm run test:browser
```

See [browser journeys](browser-journeys.md) for the pinned browser, isolation,
actual coverage, historical results and setup failures. See
[manual acceptance for 1.6.0](manual-acceptance.md) for lifecycle, real-time and
accessibility checks, and [pilot preparation](pilot/README.md) for the voluntary
seven-day protocol. Neither automated success nor preparation means a pilot ran.

The release ZIP is built from an explicit runtime allowlist with stable entry order and timestamps. It excludes tests, docs, source plans, package metadata, and development helpers. GitHub Actions validates the tag against `manifest.json` before attaching the ZIP to a GitHub Release.

### Test files

| File | What it covers |
|------|---------------|
| `heuristic-policy.test.mjs` | Intent classification, site lookup, policy builders, drift scoring, migration |
| `background.test.mjs` | Service worker helper functions |
| `drift.test.mjs` | Legacy heuristic drift scoring |
| `drift-cache.test.mjs` | TTL cache hit/miss/eviction |
| `drift-threshold.test.mjs` | Score threshold boundary conditions |
| `cooldown.test.mjs` | Per-domain override cooldown logic |
| `llm-backoff.test.mjs` | Quota backoff state machine |
| `llm.test.mjs` | LLM call mocking and response parsing |
| `providers.test.mjs` | Provider config validation, API key checks |
| `page-tracker.test.mjs` | Dwell accumulation, SPA navigation detection |
| `error-log.test.mjs` | Error classification, log rotation |
| `intervention-overlay.test.mjs` | Shadow DOM overlay construction |
| `distraction-sites.test.mjs` | Legacy default domain list |
| `static-smoke.test.mjs` | Manifest integrity, referenced assets exist, minimum permissions |

---

## Project structure

```
IntentLock/
├── manifest.json                  # MV3 manifest
├── background.js                  # Service worker — session, drift, intervention
├── content.js                     # Injected into every page
├── page-tracker.js                # Dwell time + SPA detection (used by content.js)
├── intervention-overlay.js        # Shadow-DOM overlay (used by content.js)
├── heuristic-policy.js            # Policy engine — pure, node-testable
├── drift.js                       # Legacy heuristic constants + evaluateHeuristicDrift
├── drift-cache.js                 # In-memory TTL cache for LLM results
├── llm.js                         # LLM drift check
├── llm-backoff.js                 # Quota/rate-limit backoff guard
├── providers.js                   # Multi-provider LLM abstraction
├── privacy-utils.js               # URL minimization, retention, and secret redaction
├── distraction-sites.js           # Legacy 8-domain default list
├── error-log.js                   # Diagnostic log (chrome.storage.local)
├── newtab.html / newtab.js        # New tab override — session form + active session
├── onboarding.js                  # First-run wizard (imported by newtab.js)
├── newtab.css                     # Shared styles (used by newtab + options + analytics)
├── options.html / options.js      # Settings page
├── popup.html / popup.js          # Toolbar popup (compact summary)
├── analytics.html / analytics.js  # Week glance dashboard
├── intervention.html / .js        # Tab-replacement intervention page
├── diagnostics.html / .js         # Error log viewer
├── history.html / .js             # Session history viewer
├── icon.svg / icon*.png           # Extension icons
├── CHANGELOG.md
├── tests/                         # Node suites; browser/ contains Playwright journeys
└── docs/                          # This documentation
    ├── architecture.md
    ├── heuristic-policy.md
    ├── storage-schema.md
    └── development.md
```

---

## Adding a new site category

1. Append an entry to `SITE_CATEGORIES` in `heuristic-policy.js`:
   ```js
   {
     id: 'my_category',
     label: 'My Category',
     description: 'One line description',
     defaultPolicy: 'warn',
     domains: ['example.com', 'another.com'],
   }
   ```
2. Add it to all three strictness presets in `STRICTNESS_PRESETS`
3. If relevant, add it to `CATEGORY_ALIGNMENT` for the intent categories that align with it
4. Add a test in `tests/heuristic-policy.test.mjs`
5. Run `node --test tests/heuristic-policy.test.mjs`

No other files need to change — the settings grid and policy schema pick it up automatically.

---

## Adding a new intent category

1. Append an entry to `INTENT_CATEGORIES` in `heuristic-policy.js`
2. Add it to `CATEGORY_ALIGNMENT` with its aligned site category IDs
3. Add keyword classification tests in `tests/heuristic-policy.test.mjs`

---

## Adding a new LLM provider

1. Add an entry to `PROVIDERS` in `providers.js`:
   ```js
   my_provider: {
     id: 'my_provider',
     label: 'My Provider',
     apiStyle: 'openai',   // 'openai' | 'gemini' | 'ollama'
     defaultModel: 'my-model',
     defaultBaseUrl: 'https://api.example.com/v1/chat/completions',
     authType: 'bearer',
     isLocal: false,
   }
   ```
2. Add it to the `<select>` in `options.html` if it needs a dedicated UI entry (custom provider flow handles most cases already)
3. Add provider validation tests in `tests/providers.test.mjs`

---

## Security notes

These notes describe current 1.6.0 source, not a completed security audit.
Earlier 1.5.1 remediation work was not all merged; do not inherit its guarantees.

- The manifest permits packaged scripts and broad HTTP/HTTPS page access.
  Optional AI performs inference through the configured provider and can send
  declared intent and browsing context off-device. The pilot adds no telemetry
  and requires AI to remain unconfigured in a fresh profile.
- `llm.js` minimizes browsing URLs to origins in drift prompts. This does not
  anonymize declared intent or other free text. Do not use real secrets in QA.
- Settings writes keys to `chrome.storage.session` when available, with a local
  fallback otherwise. `providers.js` can also read legacy local key aliases even
  when session storage exists. Session-only key storage is not an absolute guarantee.
- Built-in provider endpoints are validated; custom HTTP is restricted to loopback
  and custom cloud endpoints require HTTPS. Use a non-forwarding local fake
  provider for QA, never a live cloud account or real API key.
- Tracking opt-out is intended to stop new event/drift evaluation and calls; the
  browser suite covers overlay removal and no appended events after opt-out.
  In-flight provider work and storage/deletion races need the manual checks.
- Local active-session events/lock state can contain URLs. History sanitization
  removes event arrays and normalizes selected URL fields, but retains intent,
  reflections and hostnames. Secret-pattern redaction is not anonymization.
- Retention helpers use 30 days/100 completed sessions and 14 days/200 diagnostic
  entries. Filtering a view is not proof that expired storage was erased on every
  path or on a continuous timer. Verify both storage and views manually.
- Delete all data requests worker-owned local/session clearing. The automated
  journey verifies deletion after tracking opt-out and page reload; it does not
  prove durability through all queued writes, migrations, provider responses or
  browser restarts. Do not claim deletion is universally final without evidence.

---

## Debugging tips

**Intervention not firing?**
- Open `chrome://extensions` → IntentLock → Service Worker → Inspect → Console
- Check `evaluateDrift` logs — look for cooldown or debounce skips
- Try Settings → Test intervention to confirm the pipeline works end-to-end

**Overlay not showing?**
- The content script may not be injected (Chrome/extension pages, `file://`, some CSP-strict sites)
- Check the tab's console for `content.js` errors
- Background falls back to tab replacement (`intervention.html`) if the content script doesn't respond

**LLM not triggering?**
- Settings → LLM provider — confirm provider + key are saved
- Settings → Diagnostics — check for `api_error`, `quota_exceeded`, `invalid_api_key`
- The `drift-cache.js` caches results for 60 seconds; wait or reload the session to force a fresh check

**Policy not loading?**
- Open Service Worker console → `chrome.storage.local.get(['heuristicPolicy'], console.log)`
- If absent, `loadConfig()` will fall back to `deep_work / balanced` and log to the error log
