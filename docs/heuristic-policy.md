# Heuristic Policy Engine

`heuristic-policy.js` is the core policy module. It is a pure ES module — no Chrome API calls, fully testable with Node. Everything the drift evaluator needs to make a decision ships in this file.

---

## What it contains

| Export | Type | Description |
|--------|------|-------------|
| `DRIFT_CONFIDENCE_THRESHOLD` | `0.7` | Shared threshold for heuristic and LLM drift |
| `DWELL_DISTRACTION_MS` | `60_000` | Dwell on a blocked-category site before +0.2 score |
| `DWELL_UNALIGNED_MS` | `120_000` | Dwell on any unaligned site before flooring score at 0.7 |
| `INTENT_CATEGORIES` | `IntentCategory[]` | 12 intent definitions with keywords and default strictness |
| `classifyIntentCategory(text)` | function | Keyword-only intent classifier → `{categoryId, confidence, matchedKeywords}` |
| `SITE_CATEGORIES` | `SiteCategory[]` | 21 site category definitions with domain lists |
| `DOMAIN_TO_CATEGORY` | `Map<string, string>` | Built at module load; 529 entries |
| `getSiteCategory(hostname)` | function | Looks up a hostname → `{categoryId, label}` or `null` |
| `STRICTNESS_PRESETS` | object | `{strict, balanced, relaxed}` → categoryId → `'block'|'warn'|'allow'` |
| `buildDefaultPolicy(intentCategoryId, strictness?)` | function | Returns a `HeuristicPolicy` object |
| `mergePolicyWithIntent(intentText, existingPolicy?)` | function | Classifies intent and builds policy |
| `normalizeHostname(h)` | internal | Strips `www.`, lowercases |
| `resolveDomainPolicy(hostname, policy)` | function | Returns `'block'|'warn'|'allow'|'neutral'` |
| `getEffectiveBlockList(policy)` | function | Returns `string[]` of all blocked hostnames |
| `intentTerms(text)` | function | Tokenizes, strips stop words, deduplicates |
| `CATEGORY_ALIGNMENT` | object | Maps intentCategoryId → aligned site category IDs |
| `evaluatePolicyDrift(params)` | function | Main drift evaluator — returns `{shouldIntervene, score, reason, reasonLabel, signals}` |
| `SETUP_WIZARD_STEPS` | `Step[]` | 4 onboarding step descriptors for the wizard UI |
| `getCategoryPolicyOptions(intentCategoryId)` | function | Returns all 21 site categories with recommended policy for an intent |
| `migrateLegacyDistractionSites(sites)` | function | Converts old flat domain list → `HeuristicPolicy` |

---

## Intent taxonomy

```js
// Shape of each entry in INTENT_CATEGORIES
{
  id: string,
  label: string,           // shown in UI
  description: string,     // one-line for onboarding
  keywords: string[],      // used by classifyIntentCategory
  defaultStrictness: 'relaxed' | 'balanced' | 'strict',
}
```

| ID | Label | Default strictness | Sample keywords |
|----|-------|--------------------|----------------|
| `job_search` | Job Search | balanced | job, resume, apply, interview, career, linkedin |
| `deep_work` | Deep Work | strict | deep, focus, report, proposal, deadline, quarterly |
| `coding` | Coding | balanced | code, debug, build, deploy, github, stack overflow |
| `learning` | Learning | balanced | learn, course, tutorial, study, read, understand |
| `writing` | Writing | strict | write, draft, essay, blog, article, edit, proofread |
| `research` | Research | balanced | research, explore, investigate, sources, paper |
| `admin` | Admin | relaxed | email, calendar, invoice, schedule, meeting |
| `creative` | Creative | relaxed | design, art, create, sketch, prototype, inspiration |
| `health` | Health | relaxed | exercise, workout, nutrition, meditation, sleep |
| `shopping` | Shopping | relaxed | buy, price, order, compare, review, cart |
| `communication` | Communication | relaxed | message, chat, discuss, team, slack, call |
| `entertainment_allowed` | Entertainment | relaxed | watch, stream, play, relax, movie, music |

### `classifyIntentCategory(intentText)`

Tokenizes the free-text intent, scores each `INTENT_CATEGORY` by keyword overlap, and returns:

```js
{
  categoryId: string | null,  // null if confidence < 0.3
  confidence: number,         // 0–1, matched keywords / total category keywords
  matchedKeywords: string[],
}
```

No API call. Falls back to `null` category if the text is too vague — `buildDefaultPolicy` then uses `'deep_work'` as the default.

---

## Site taxonomy

```js
// Shape of each entry in SITE_CATEGORIES
{
  id: string,
  label: string,
  description: string,
  defaultPolicy: 'block' | 'warn' | 'allow',
  domains: string[],   // bare hostnames, lowercase, no protocol
}
```

**21 categories, 529 unique domains.** A domain appears in exactly one category (first-write-wins in `DOMAIN_TO_CATEGORY`).

| Category ID | Default policy | Example domains |
|-------------|---------------|-----------------|
| `social_media` | block | twitter.com, instagram.com, facebook.com, threads.net |
| `short_video` | block | tiktok.com, youtube.com (shorts), reels |
| `streaming` | block | netflix.com, hulu.com, disneyplus.com, twitch.tv |
| `gaming` | warn | steam.com, epicgames.com, itch.io |
| `news` | warn | nytimes.com, bbc.com, cnn.com, reuters.com |
| `forums` | warn | reddit.com, hackernews.ycombinator.com, quora.com |
| `shopping` | warn | amazon.com, ebay.com, etsy.com |
| `email` | allow | gmail.com, outlook.com, mail.google.com |
| `messaging` | allow | slack.com, discord.com, teams.microsoft.com |
| `job_boards` | allow | linkedin.com/jobs, indeed.com, glassdoor.com |
| `professional_network` | allow | linkedin.com, angel.co, wellfound.com |
| `documentation` | allow | docs.google.com, notion.so, confluence.atlassian.com |
| `code_forge` | allow | github.com, gitlab.com, bitbucket.org |
| `ai_tools` | allow | chat.openai.com, claude.ai, gemini.google.com |
| `finance` | warn | cnbc.com, bloomberg.com, bankofamerica.com |
| `sports` | warn | espn.com, nba.com, nfl.com |
| `adult` | block | _(private)_ |
| `gambling` | block | draftkings.com, fanduel.com, bet365.com |
| `memes` | block | ifunny.co, 9gag.com, knowyourmeme.com |
| `productivity` | allow | todoist.com, trello.com, asana.com |
| `health` | allow | myfitnesspal.com, headspace.com |
| `travel` | allow | google.com/travel, airbnb.com |

### `getSiteCategory(hostname)`

Strips `www.`, lowercases, looks up in `DOMAIN_TO_CATEGORY`. Returns `{categoryId, label}` or `null`.

---

## Policy schema

Stored in `chrome.storage.local` under the key `heuristicPolicy`, version 1:

```js
{
  version: 1,
  intentCategoryId: string | null,
  strictness: 'relaxed' | 'balanced' | 'strict',
  categoryPolicies: {
    [siteCategoryId: string]: 'block' | 'warn' | 'allow'
  },
  customBlockDomains: string[],   // always block, overrides category
  customAllowDomains: string[],   // always allow, overrides category block
  setupCompleted: boolean,
}
```

### Precedence (highest to lowest)

1. `customAllowDomains` match → **allow** (category block ignored)
2. `customBlockDomains` match → **block** (category allow ignored)
3. `categoryPolicies[DOMAIN_TO_CATEGORY[hostname]]`
4. Domain not in any category → **neutral** (behavioral signals still score)

### `resolveDomainPolicy(hostname, policy)`

Returns `'block' | 'warn' | 'allow' | 'neutral'`. Safe with `null` policy (returns `'neutral'`).

---

## Strictness presets

`STRICTNESS_PRESETS` maps each of the three strictness levels to a full `categoryPolicies` object:

| Category | strict | balanced | relaxed |
|----------|--------|----------|---------|
| social_media | block | block | warn |
| short_video | block | block | block |
| streaming | block | block | warn |
| gaming | block | warn | warn |
| forums | block | warn | allow |
| memes | block | block | warn |
| gambling | block | block | warn |
| news | warn | warn | allow |
| shopping | warn | warn | allow |
| sports | warn | warn | allow |
| finance | warn | warn | allow |
| email | allow | allow | allow |
| messaging | allow | allow | allow |
| job_boards | allow | allow | allow |
| professional_network | allow | allow | allow |
| documentation | allow | allow | allow |
| code_forge | allow | allow | allow |
| ai_tools | allow | allow | allow |
| productivity | allow | allow | allow |
| health | allow | allow | allow |
| travel | allow | allow | allow |

---

## Category alignment

`evaluatePolicyDrift` checks category-level alignment before falling back to keyword matching. This means intent `job_search` on `linkedin.com` is **aligned** even if the word "linkedin" doesn't appear in the session intent text.

```js
const CATEGORY_ALIGNMENT = {
  job_search:             ['job_boards', 'professional_network'],
  deep_work:              ['documentation', 'productivity', 'code_forge', 'ai_tools'],
  coding:                 ['code_forge', 'documentation', 'ai_tools'],
  learning:               ['documentation', 'code_forge', 'ai_tools'],
  writing:                ['documentation', 'productivity', 'ai_tools'],
  research:               ['documentation', 'news', 'ai_tools'],
  admin:                  ['email', 'messaging', 'productivity'],
  creative:               ['productivity', 'ai_tools'],
  health:                 ['health'],
  shopping:               ['shopping'],
  communication:          ['email', 'messaging'],
  entertainment_allowed:  ['streaming', 'gaming', 'short_video', 'social_media'],
};
```

---

## `evaluatePolicyDrift` — full signature

```js
evaluatePolicyDrift({
  intent: string,        // user's declared session intent
  url: string,           // current page URL
  events: Array,         // session.events — last N tab/dwell/SPA events
  policy: HeuristicPolicy | null,  // null → fail-open to deep_work/balanced
  now: number,           // Date.now() — injectable for tests
}) → {
  shouldIntervene: boolean,
  score: number,          // 0–1
  reason: string,         // machine code: 'blocked_category' | 'aligned' | 'empty_terms' | 'invalid_url' | ...
  reasonLabel: string,    // human-readable for intervention UI
  signals: string[],      // e.g. ['blocked_category:social_media', 'tab_switches:5', 'dwell:130s']
}
```

Fast paths (return immediately):
- `url` fails `new URL()` → `{ shouldIntervene: false, reason: 'invalid_url' }`
- Policy null/invalid → fail-open to `buildDefaultPolicy('deep_work', 'balanced')`
- `domainPolicy === 'block'` + not category-aligned + not keyword-aligned → score 0.95, `reason: 'blocked_category'`
- `domainPolicy === 'allow'` + category-aligned → score 0, `reason: 'aligned'`
- `intentTerms(intent).length === 0` → score 0, `reason: 'empty_terms'`

---

## Migration

`migrateLegacyDistractionSites(customDistractionSites: string[]) → HeuristicPolicy`

Converts the old flat domain list to a v1 policy:

- Domains already in `DOMAIN_TO_CATEGORY` (e.g. `twitter.com`, `youtube.com`) are covered by category policy — **not** added to `customBlockDomains`
- Domains not in any category (user's custom additions) are preserved in `customBlockDomains`
- Base policy: `buildDefaultPolicy('deep_work', 'balanced')`

Called automatically in `background.js` `loadConfig()` if `heuristicPolicy` is missing but `customDistractionSites` exists. Result is persisted back to storage.
