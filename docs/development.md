# Development Guide

---

## Prerequisites

- Chrome (any recent version supporting MV3)
- Node.js 18+ (for running tests — not needed for the extension itself)
- No build step, no bundler, no `npm install`

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
| `newtab.js`, `options.js`, `popup.js` | Close and reopen the page/popup |
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

# All suites
node --test tests/*.mjs

# Verbose (shows individual test names)
node --test --reporter=spec tests/*.mjs
```

All tests use Node's built-in `node:test` + `assert/strict`. No test runner to install.

### Test files

| File | What it covers |
|------|---------------|
| `heuristic-policy.test.mjs` | Intent classification, site lookup, policy builders, drift scoring, migration (48 tests) |
| `background.test.mjs` | Service worker helper functions (2 tests) |
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
├── distraction-sites.js           # Legacy 8-domain default list
├── error-log.js                   # Diagnostic log (chrome.storage.local)
├── newtab.html / newtab.js        # New tab override — onboarding + session form
├── newtab.css                     # Shared styles (used by newtab + options)
├── options.html / options.js      # Settings page
├── popup.html / popup.js          # Toolbar popup
├── intervention.html / .js        # Tab-replacement intervention page
├── diagnostics.html / .js         # Error log viewer
├── history.html / .js             # Session history viewer
├── icon.svg / icon*.png           # Extension icons
├── CHANGELOG.md
├── tests/                         # node:test test suites
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

- **No `eval`, no `innerHTML` with user input** anywhere in the codebase
- **No remote code** — all domain data and rules ship in the extension package. `providers.js` makes `fetch()` calls only when the user has configured a provider and a session is active (LLM inference, not code loading)
- **No telemetry** — `heuristicPolicy` and all session data stay in `chrome.storage.local`
- **API key in session storage only** — `chrome.storage.session` is cleared on browser close; the key is never written to `chrome.storage.local` or `chrome.storage.sync`
- **Domain validation** on user input in Settings: `HOSTNAME_RE = /^[a-z0-9][a-z0-9\-.]*\.[a-z]{2,}$/` — rejects IPs, wildcards, protocols, and paths
- **Fail-open** — bad policy or missing storage key never throws to the caller; falls back to `buildDefaultPolicy('deep_work', 'balanced')`

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
