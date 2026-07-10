# Storage Schema

IntentLock uses two Chrome storage areas. Neither sends data outside the browser.

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

Array of completed session summaries. Appended to on `END_ACTIVE_SESSION`. Never trimmed automatically.

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
  topDomains?: Array<{ hostname: string, activeMs: number, aligned: boolean }>,
  reportViewed?: boolean,
  overrides?: Array<{ timestamp: number, url?: string, hostname?: string, reflection?: string }>,
}>
```

Exportable as JSON via Settings → Export session history.
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

Array of diagnostic entries, capped at 200. Written by `error-log.js`. Viewable at Settings → Diagnostics.

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

Ephemeral — present only while an intervention is active. Cleared on override or dismiss.

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

## `chrome.storage.session` — cleared on browser close

| Key | Type | Description |
|-----|------|-------------|
| `openaiApiKey` | string | API key — never written to `local` storage |
| `llmApiKey` | string | Alias used by some provider paths |

The API key is kept here by design — it is never synced, never backed up, and never survives a browser restart. The user must re-enter it each session if they close Chrome.

On startup, `background.js` checks `chrome.storage.local` for a legacy `openaiApiKey` (written by versions before 1.2.1) and migrates it to session storage, removing the local copy.
