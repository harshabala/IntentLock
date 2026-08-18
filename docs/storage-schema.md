# Storage Schema

IntentLock uses Chrome's local and session storage areas. Stored data stays in the browser unless you explicitly enable a remote LLM provider; in that case, minimized intent and browsing context may be sent to that provider while tracking is enabled.

---

## `chrome.storage.local` — persisted across browser restarts

### `activeSession`

The currently running session. Absent when no session is active.

```js
{
  id: string,                  // UUID
  intent: string,              // user's declared intent text
  startTime: number,           // Date.now() at session start
  endTime: number | null,      // set when session ends
  isActive: boolean,
  timeBudget: number | null,   // minutes; null = unlimited
  events: Array<{
    actionType: 'TAB_SWITCH' | 'PAGE_LOAD' | 'PAGE_DWELL'
              | 'SPA_NAVIGATION' | 'OVERRIDE',
    url: string,
    timestamp: number,
    dwellMs?: number,      // PAGE_DWELL only — active milliseconds on page
    reflection?: string,   // OVERRIDE only — user's written reflection
  }>,
  metrics?: {
    activeMs: number,
    alignedActiveMs: number,
    interventionCount: number,
    overrideCount: number,
    domains: { [hostname: string]: { activeMs: number, alignedMs: number } },
  },
}
```

During an active session, `activeSession.metrics` accumulates real-time tracking data for the current session.

---


### `heuristicPolicy`

The user's site policy, version 1. Set during onboarding step 3 or Settings save.

```js
{
  version: 1,
  intentCategoryId: string | null,   // one of the 12 INTENT_CATEGORIES ids
  strictness: 'relaxed' | 'balanced' | 'strict',
  categoryPolicies: {
    // one key per SITE_CATEGORY id, 21 total
    social_media: 'block' | 'warn' | 'allow',
    short_video:  'block' | 'warn' | 'allow',
    streaming:    'block' | 'warn' | 'allow',
    // ... all 21 categories
  },
  customBlockDomains: string[],   // hostnames that always block
  customAllowDomains: string[],   // hostnames that always allow
  setupCompleted: boolean,
}
```

**Precedence:** `customAllowDomains` > `customBlockDomains` > `categoryPolicies` > neutral.

**Migration:** if this key is absent and `customDistractionSites` is present, `background.js` runs `migrateLegacyDistractionSites()` automatically on startup and writes the result here.

---

### `sessionHistory`

Array of completed session summaries. Appended to on `END_ACTIVE_SESSION`. On reads and exports, entries are sanitized and pruned at rest to the newest 100 entries from the last 30 days.

```js
Array<{
  id: string,
  intent: string,
  startTime: number,
  endTime: number,
  timeBudget: number | null,
  driftCount: number,    // number of OVERRIDE events
  totalEvents: number,
  activeMs?: number,
  alignedActiveMs?: number,
  onIntentRatio?: number | null,    // 0.0 to 1.0, or null if tracking off / no activity
  interventionCount?: number,
  overrideCount?: number,
  topDomains?: Array<{ hostname: string, activeMs: number, aligned: boolean, alignedMs: number }>,
  reportViewed?: boolean,
  overrides?: Array<{ timestamp: number, url?: string, hostname?: string, reflection?: string }>,
}>
```

Exportable as JSON via Settings → Export session history. Full event arrays and legacy override URLs are not retained in the sanitized history summary; overrides retain only hostnames and reflections.
Note: `overrides[].hostname` replaces `overrides[].url` per privacy rules (only hostname is stored).

---

### `activationState`

Written when the user views the session report for a session lasting ≥ 10 minutes (`REPORT_VIEWED` message). Represents the single activation event (`ACTIVATION_EVENT`).

```js
{
  activatedAt: number | null,   // Date.now() when first activated
  sessionId: string | null,     // ID of the qualifying session
}
```

---

### `llmProviderConfig`

Selected AI provider and its settings. Absent until the user configures one.

```js
{
  providerId: 'openai' | 'gemini' | 'grok' | 'ollama' | 'lmstudio' | 'custom',
  model?: string,
  baseUrl?: string,
  authType?: 'bearer' | 'header' | 'query' | 'none',
  label?: string,    // custom provider display name
  apiStyle?: 'openai' | 'gemini' | 'ollama',  // custom provider only
}
```

---

### `trackingEnabled`

`boolean` — whether `PAGE_DWELL` and `SPA_NAVIGATION` events are recorded. Default `true`. Toggled in Settings → Privacy.

---

### `theme`

`'auto' | 'dark' | 'light'` — color scheme preference. Default `'auto'`.

---

### `errorLog`

Array of diagnostic entries, capped at 200 and retained for 14 days. Reads and exports redact secret-shaped fields and prune expired entries at rest. Written by `error-log.js`. Viewable at Settings → Diagnostics.

```js
Array<{
  id: string,
  timestamp: number,
  type: 'api' | 'config' | 'ui' | 'storage' | 'validation' | 'runtime',
  code: string,      // e.g. 'invalid_api_key', 'quota_exceeded', 'network_error'
  message: string,   // human-readable
  providerId?: string,
  details?: string,  // provider error message if available
}>
```

---

### `interventionState`

Ephemeral — present only while an intervention is active. Cleared on override, close-tab, end-session, tracking disable, or deletion.

```js
{
  reason: string,          // human-readable reason shown to user
  timestamp: number,
  originalTabId: number,
  originalUrl: string,
  mode: 'overlay' | 'tab', // overlay = shadow DOM, tab = intervention.html
}
```

---

### `overrideCooldowns`

Serialised form of the in-memory `Map<domain, expiryTimestamp>`. Written whenever the map changes.

```js
Array<[string, number]>   // [domain, Date.now() + 5*60*1000]
```

Domains on cooldown skip drift evaluation entirely for 5 minutes after the user overrides an intervention.

---

### `customDistractionSites` (legacy)

Pre-v1.5.0 flat domain list. Still read on startup for migration; not written by v1.5.0+ code. Migrated automatically to `heuristicPolicy` on first load.

```js
string[]   // bare hostnames, e.g. ['twitter.com', 'reddit.com']
```

---

### `isCurrentlyIdle` / `lastIdleTime`

Written by the `chrome.idle.onStateChanged` listener. Used to pause dwell accumulation when the user is idle (3-minute threshold).

```js
isCurrentlyIdle: boolean
lastIdleTime: number   // timestamp when idle state began, 0 if not idle
```

---

## `chrome.storage.session` — cleared on browser close when available

| Key | Type | Description |
|-----|------|-------------|
| `openaiApiKey` | string | API key — never written to `local` storage |
| `llmApiKey` | string | Alias used by some provider paths |

The API key is kept here when this storage area is available — it is never synced, never backed up, and never survives a browser restart. If session storage is unavailable, the provider path may use the local `llmApiKey` fallback. The user must re-enter the key after closing Chrome when session storage is used.

On startup, `background.js` checks `chrome.storage.local` for a legacy `openaiApiKey` (written by versions before 1.2.1) and migrates it to session storage, removing the local copy.
