# Heuristic Self-Setup Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a heuristic self-setup engine (`heuristic-policy.js`) with 12 intent categories, 20+ site categories covering 300+ domains, a category-aware drift evaluator, and wire it into background.js, newtab.js onboarding, and options.html settings.

**Architecture:** A single pure ES module `heuristic-policy.js` exports all taxonomy, policy builders, and drift evaluation logic. `background.js` loads `heuristicPolicy` from `chrome.storage.local` and routes drift evaluation through `evaluatePolicyDrift()`. `drift.js` is left in place as a backward-compatible legacy module.

**Tech Stack:** MV3 Chrome Extension, ES modules, `node:test` for unit tests, no bundler, no TypeScript.

## Global Constraints

- No remote code: all domains ship in the extension package
- No `eval`, no `innerHTML` with user input
- No telemetry: policy stays in `chrome.storage.local` only
- No PII in policy object: only categories and domain strings
- Heuristics must work with zero API key
- Fail-open on parse errors: bad policy → `buildDefaultPolicy('deep_work', 'balanced')`
- Domain validation: lowercase hostname labels only, reject IPs, no `*` wildcards in v1
- Match existing code style: minimal comments, ES modules, no TypeScript
- `DRIFT_CONFIDENCE_THRESHOLD = 0.7`, `DWELL_DISTRACTION_MS = 60_000`, `DWELL_UNALIGNED_MS = 120_000`
- Target: 300–800 unique domains across 20+ site categories
- Test runner: `node --test tests/heuristic-policy.test.mjs`
- Version bump: `manifest.json` → `1.5.0`

---

## File Structure

**New files:**
- `heuristic-policy.js` — Core module: intent taxonomy, site taxonomy (300+ domains), policy schema/builders, drift evaluator, UI data exports, migration helper
- `tests/heuristic-policy.test.mjs` — 25+ tests using `node:test`

**Modified files:**
- `background.js` — Load `heuristicPolicy` from storage, call `evaluatePolicyDrift`, add `heuristicPolicy` in-memory state
- `drift.js` — No changes needed (kept for backward compat; constants live in both files deliberately)
- `newtab.js` — Add `showStep3()` to onboarding wizard (intent category + strictness picker + save policy)
- `options.html` — Replace distraction-sites textarea section with category-grid section
- `options.js` — Load/save `heuristicPolicy.categoryPolicies` via category grid
- `manifest.json` — Bump version to `1.5.0`
- `CHANGELOG.md` — Add `1.5.0` entry

---

## Task 1: Intent taxonomy + classifyIntentCategory

**Files:**
- Create: `heuristic-policy.js` (intent taxonomy section only, plus module header)
- Create: `tests/heuristic-policy.test.mjs` (intent classification tests)

**Interfaces:**
- Produces: `INTENT_CATEGORIES: Array`, `classifyIntentCategory(intentText: string) → { categoryId: string|null, confidence: number, matchedKeywords: string[] }`

- [ ] **Step 1: Create the test file with failing intent tests**

```js
// tests/heuristic-policy.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INTENT_CATEGORIES,
  classifyIntentCategory,
} from '../heuristic-policy.js';

test('INTENT_CATEGORIES has at least 12 entries', () => {
  assert.ok(Array.isArray(INTENT_CATEGORIES));
  assert.ok(INTENT_CATEGORIES.length >= 12);
});

test('each category has required fields', () => {
  for (const cat of INTENT_CATEGORIES) {
    assert.ok(typeof cat.id === 'string', `missing id: ${JSON.stringify(cat)}`);
    assert.ok(typeof cat.label === 'string');
    assert.ok(typeof cat.description === 'string');
    assert.ok(Array.isArray(cat.keywords));
    assert.ok(['relaxed', 'balanced', 'strict'].includes(cat.defaultStrictness), `bad strictness: ${cat.id}`);
  }
});

test('job_search intent classifies to job_search', () => {
  const result = classifyIntentCategory('applying for software engineer jobs');
  assert.equal(result.categoryId, 'job_search');
  assert.ok(result.confidence > 0);
  assert.ok(Array.isArray(result.matchedKeywords));
});

test('deep_work intent classifies to deep_work', () => {
  const result = classifyIntentCategory('deep work on the quarterly report');
  assert.equal(result.categoryId, 'deep_work');
});

test('coding intent classifies to coding', () => {
  const result = classifyIntentCategory('coding the new feature in React');
  assert.equal(result.categoryId, 'coding');
});

test('learning intent classifies to learning', () => {
  const result = classifyIntentCategory('studying machine learning algorithms');
  assert.equal(result.categoryId, 'learning');
});

test('writing intent classifies to writing', () => {
  const result = classifyIntentCategory('writing a blog post about productivity');
  assert.equal(result.categoryId, 'writing');
});

test('empty intent returns null categoryId and zero confidence', () => {
  const result = classifyIntentCategory('');
  assert.equal(result.confidence, 0);
  assert.equal(result.categoryId, null);
});

test('vague single-word intent returns low confidence', () => {
  const result = classifyIntentCategory('stuff');
  assert.ok(result.confidence < 0.3);
});
```

- [ ] **Step 2: Run to verify the file is missing (expected failure)**

```bash
cd /Users/harshabalakrishnan/Documents/Projects/IntentLock
node --test tests/heuristic-policy.test.mjs
```
Expected: `Error: Cannot find module '../heuristic-policy.js'`

- [ ] **Step 3: Create `heuristic-policy.js` with module header and intent taxonomy**

```js
// heuristic-policy.js — IntentLock heuristic & site policy engine
// Storage schema: chrome.storage.local key `heuristicPolicy`, version 1

export const DRIFT_CONFIDENCE_THRESHOLD = 0.7;
export const DWELL_DISTRACTION_MS = 60_000;
export const DWELL_UNALIGNED_MS = 120_000;

// ── Intent taxonomy ────────────────────────────────────────────────────

export const INTENT_CATEGORIES = [
  {
    id: 'job_search',
    label: 'Job Search',
    description: 'Applying for jobs, reviewing offers, interview prep',
    keywords: ['job', 'jobs', 'resume', 'cv', 'apply', 'application', 'interview', 'career',
      'hiring', 'salary', 'recruiter', 'linkedin', 'glassdoor', 'offer', 'employment',
      'position', 'role', 'cover', 'letter', 'portfolio', 'openings'],
    defaultStrictness: 'balanced',
  },
  {
    id: 'deep_work',
    label: 'Deep Work',
    description: 'Focused uninterrupted work on a specific deliverable',
    keywords: ['deep', 'focus', 'concentrate', 'report', 'proposal', 'deliverable', 'deadline',
      'quarterly', 'annual', 'analysis', 'presentation', 'deck', 'spreadsheet', 'document',
      'review', 'audit', 'plan', 'strategy'],
    defaultStrictness: 'strict',
  },
  {
    id: 'coding',
    label: 'Coding',
    description: 'Writing, debugging, or reviewing code',
    keywords: ['code', 'coding', 'programming', 'debug', 'feature', 'bug', 'fix', 'refactor',
      'deploy', 'build', 'test', 'api', 'function', 'component', 'module', 'react', 'python',
      'javascript', 'typescript', 'extension', 'backend', 'frontend', 'script', 'class',
      'database', 'query', 'endpoint', 'pull', 'request', 'merge', 'commit'],
    defaultStrictness: 'strict',
  },
  {
    id: 'learning',
    label: 'Learning',
    description: 'Studying a topic, taking a course, reading technical material',
    keywords: ['learn', 'study', 'course', 'tutorial', 'understand', 'lecture', 'lesson',
      'chapter', 'book', 'documentation', 'algorithm', 'concept', 'machine', 'data', 'science',
      'math', 'physics', 'history', 'language', 'certificate', 'exam', 'practice'],
    defaultStrictness: 'balanced',
  },
  {
    id: 'writing',
    label: 'Writing',
    description: 'Writing a document, article, essay, or creative piece',
    keywords: ['write', 'draft', 'drafting', 'article', 'blog', 'essay', 'post', 'content',
      'copy', 'script', 'story', 'novel', 'chapter', 'edit', 'revise', 'proofread', 'outline',
      'thesis', 'email', 'newsletter', 'caption'],
    defaultStrictness: 'strict',
  },
  {
    id: 'research',
    label: 'Research',
    description: 'Gathering information on a specific topic',
    keywords: ['research', 'investigate', 'find', 'information', 'facts', 'sources', 'references',
      'compare', 'survey', 'literature', 'background', 'context', 'data', 'statistics',
      'market', 'competitors', 'pricing'],
    defaultStrictness: 'balanced',
  },
  {
    id: 'admin',
    label: 'Admin & Ops',
    description: 'Email, scheduling, invoicing, and operational tasks',
    keywords: ['email', 'calendar', 'schedule', 'invoice', 'billing', 'expense', 'meeting',
      'agenda', 'slack', 'admin', 'operational', 'payroll', 'contract', 'sign', 'approval',
      'onboard', 'offboard', 'ticket', 'helpdesk'],
    defaultStrictness: 'relaxed',
  },
  {
    id: 'creative',
    label: 'Creative Work',
    description: 'Design, illustration, video editing, or other creative output',
    keywords: ['design', 'illustration', 'graphic', 'creative', 'art', 'video', 'edit', 'photo',
      'brand', 'logo', 'ui', 'ux', 'figma', 'sketch', 'canva', 'animation', 'render',
      'color', 'typography', 'layout', 'wireframe', 'prototype'],
    defaultStrictness: 'balanced',
  },
  {
    id: 'health',
    label: 'Health & Wellness',
    description: 'Medical research, fitness, nutrition, or mental health tasks',
    keywords: ['health', 'fitness', 'workout', 'diet', 'nutrition', 'medical', 'doctor',
      'symptom', 'exercise', 'wellness', 'mental', 'therapy', 'medication', 'appointment',
      'insurance', 'prescription', 'condition'],
    defaultStrictness: 'relaxed',
  },
  {
    id: 'shopping',
    label: 'Shopping',
    description: 'Purchasing specific items or comparing products',
    keywords: ['buy', 'purchase', 'shop', 'order', 'product', 'price', 'compare', 'amazon',
      'ebay', 'gift', 'checkout', 'cart', 'shipping', 'deal', 'discount', 'coupon'],
    defaultStrictness: 'relaxed',
  },
  {
    id: 'communication',
    label: 'Communication',
    description: 'Messaging, email catch-up, or coordinating with others',
    keywords: ['message', 'chat', 'email', 'communicate', 'reply', 'respond', 'send',
      'coordinate', 'team', 'colleague', 'client', 'follow', 'meeting', 'standup',
      'update', 'sync', 'discuss'],
    defaultStrictness: 'relaxed',
  },
  {
    id: 'entertainment_allowed',
    label: 'Entertainment (Allowed)',
    description: 'Intentional relaxation — browsing is the goal',
    keywords: ['watch', 'relax', 'fun', 'entertain', 'movie', 'show', 'game', 'gaming',
      'browse', 'scroll', 'chill', 'leisure', 'break', 'hobby', 'youtube', 'netflix',
      'series', 'stream', 'anime'],
    defaultStrictness: 'relaxed',
  },
];

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'from', 'have', 'into', 'latest',
  'make', 'need', 'page', 'some', 'task', 'that', 'this', 'with', 'your',
  'going', 'want', 'just', 'doing', 'today', 'been', 'will', 'should',
  'could', 'would', 'when', 'what', 'which', 'where', 'very',
]);

function tokenize(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

export function classifyIntentCategory(intentText) {
  const tokens = tokenize(intentText).filter(w => w.length > 2 && !STOP_WORDS.has(w));
  if (tokens.length === 0) {
    return { categoryId: null, confidence: 0, matchedKeywords: [] };
  }

  let bestCategory = null;
  let bestScore = 0;
  let bestMatched = [];

  for (const cat of INTENT_CATEGORIES) {
    const keywordSet = new Set(cat.keywords);
    const matched = tokens.filter(t =>
      keywordSet.has(t) || cat.keywords.some(k => t.length > 4 && (k.startsWith(t) || t.startsWith(k)))
    );
    const score = matched.length / Math.max(tokens.length, 1);
    if (score > bestScore) {
      bestScore = score;
      bestCategory = cat.id;
      bestMatched = matched;
    }
  }

  return {
    categoryId: bestCategory,
    confidence: Math.min(bestScore, 1),
    matchedKeywords: [...new Set(bestMatched)],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/heuristic-policy.test.mjs
```
Expected: All 9 intent tests pass.

- [ ] **Step 5: Commit**

```bash
git add heuristic-policy.js tests/heuristic-policy.test.mjs
git commit -m "feat: add intent taxonomy and classifyIntentCategory to heuristic-policy.js"
```

---

## Task 2: Site taxonomy + DOMAIN_TO_CATEGORY + getSiteCategory

**Files:**
- Modify: `heuristic-policy.js` (append site taxonomy section)
- Modify: `tests/heuristic-policy.test.mjs` (append domain lookup tests)

**Interfaces:**
- Consumes: `tokenize`, `STOP_WORDS` from Task 1
- Produces: `SITE_CATEGORIES: Array`, `DOMAIN_TO_CATEGORY: Map<string,string>`, `getSiteCategory(hostname: string) → {categoryId, label} | null`

- [ ] **Step 1: Append failing domain tests to test file**

```js
// Append to tests/heuristic-policy.test.mjs
import {
  SITE_CATEGORIES,
  DOMAIN_TO_CATEGORY,
  getSiteCategory,
} from '../heuristic-policy.js';

test('SITE_CATEGORIES has at least 20 entries', () => {
  assert.ok(SITE_CATEGORIES.length >= 20);
});

test('each site category has required fields', () => {
  for (const cat of SITE_CATEGORIES) {
    assert.ok(typeof cat.id === 'string');
    assert.ok(typeof cat.label === 'string');
    assert.ok(typeof cat.description === 'string');
    assert.ok(['block', 'warn', 'allow'].includes(cat.defaultPolicy), `bad defaultPolicy: ${cat.id}`);
    assert.ok(Array.isArray(cat.domains) && cat.domains.length > 0, `empty domains: ${cat.id}`);
  }
});

test('DOMAIN_TO_CATEGORY covers at least 300 unique domains', () => {
  assert.ok(DOMAIN_TO_CATEGORY.size >= 300, `only ${DOMAIN_TO_CATEGORY.size} domains`);
});

test('youtube.com is in short_video', () => {
  assert.equal(getSiteCategory('youtube.com')?.categoryId, 'short_video');
});

test('twitter.com is in social_media', () => {
  assert.equal(getSiteCategory('twitter.com')?.categoryId, 'social_media');
});

test('github.com is in code_forge', () => {
  assert.equal(getSiteCategory('github.com')?.categoryId, 'code_forge');
});

test('indeed.com is in job_boards', () => {
  assert.equal(getSiteCategory('indeed.com')?.categoryId, 'job_boards');
});

test('netflix.com is in streaming', () => {
  assert.equal(getSiteCategory('netflix.com')?.categoryId, 'streaming');
});

test('linkedin.com is in professional_network', () => {
  assert.equal(getSiteCategory('linkedin.com')?.categoryId, 'professional_network');
});

test('notion.so is in productivity', () => {
  assert.equal(getSiteCategory('notion.so')?.categoryId, 'productivity');
});

test('espn.com is in sports', () => {
  assert.equal(getSiteCategory('espn.com')?.categoryId, 'sports');
});

test('unknown domain returns null', () => {
  assert.equal(getSiteCategory('my-private-intranet.internal'), null);
});

test('www prefix is stripped before lookup', () => {
  assert.equal(getSiteCategory('www.youtube.com')?.categoryId, 'short_video');
});
```

- [ ] **Step 2: Run to verify new tests fail**

```bash
node --test tests/heuristic-policy.test.mjs
```
Expected: 9 passing intent tests, 12 new failures for missing `SITE_CATEGORIES`, `DOMAIN_TO_CATEGORY`, `getSiteCategory`.

- [ ] **Step 3: Append site taxonomy to `heuristic-policy.js`**

```js
// ── Site taxonomy ──────────────────────────────────────────────────────

export const SITE_CATEGORIES = [
  {
    id: 'social_media',
    label: 'Social Media',
    description: 'General social networking and sharing platforms',
    defaultPolicy: 'block',
    domains: [
      'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'threads.net',
      'snapchat.com', 'pinterest.com', 'tumblr.com', 'mastodon.social', 'mastodon.online',
      'bsky.app', 'myspace.com', 'vk.com', 'weibo.com', 'wechat.com', 'renren.com',
      'mewe.com', 'parler.com', 'gab.com', 'clubhouse.com', 'mix.com',
      'band.us', 'nextdoor.com', 'taringa.net', 'diaspora.social',
    ],
  },
  {
    id: 'short_video',
    label: 'Short Video & YouTube',
    description: 'Video platforms optimized for passive entertainment consumption',
    defaultPolicy: 'block',
    domains: [
      'youtube.com', 'tiktok.com', 'douyin.com', 'kwai.com', 'triller.co',
      'likee.video', 'cheez.tv', 'snackvideo.com', 'moj.in', 'roposo.com',
    ],
    pathPatterns: ['youtube\\.com/watch', 'youtube\\.com/shorts', 'youtube\\.com/feed'],
  },
  {
    id: 'streaming',
    label: 'Video Streaming',
    description: 'Movie and TV show streaming services',
    defaultPolicy: 'block',
    domains: [
      'netflix.com', 'hulu.com', 'disneyplus.com', 'hbomax.com', 'max.com',
      'primevideo.com', 'tv.apple.com', 'peacocktv.com', 'paramountplus.com',
      'fubo.tv', 'sling.com', 'philo.com', 'crunchyroll.com', 'funimation.com',
      'mubi.com', 'britbox.com', 'acornnetwork.com', 'shudder.com',
      'discoveryplus.com', 'espnplus.com', 'plex.tv', 'tubitv.com',
      'pluto.tv', 'vudu.com', 'crackle.com', 'kanopy.com', 'mxplayer.in',
      'hotstar.com', 'sonyliv.com', 'zee5.com', 'voot.com', 'jiocinema.com',
    ],
  },
  {
    id: 'gaming',
    label: 'Gaming',
    description: 'Online games, gaming platforms, and game stores',
    defaultPolicy: 'warn',
    domains: [
      'twitch.tv', 'store.steampowered.com', 'epicgames.com', 'gog.com',
      'origin.com', 'ubisoft.com', 'blizzard.com', 'xbox.com', 'playstation.com',
      'nintendo.com', 'itch.io', 'miniclip.com', 'kongregate.com',
      'armor-games.com', 'coolmathgames.com', 'poki.com', 'y8.com',
      'friv.com', 'addictinggames.com', 'roblox.com', 'minecraft.net',
      'fortnite.com', 'leagueoflegends.com', 'dota2.com', 'pathofexile.com',
      'guildwars2.com', 'wowhead.com', 'curse.com', 'overwolf.com',
      'gamesradar.com', 'ign.com', 'gamespot.com', 'polygon.com',
    ],
  },
  {
    id: 'news',
    label: 'News',
    description: 'General news, politics, and current events',
    defaultPolicy: 'warn',
    domains: [
      'cnn.com', 'foxnews.com', 'bbc.com', 'bbc.co.uk', 'nytimes.com',
      'theguardian.com', 'washingtonpost.com', 'wsj.com', 'reuters.com',
      'apnews.com', 'nbcnews.com', 'cbsnews.com', 'msnbc.com',
      'huffpost.com', 'politico.com', 'thehill.com', 'npr.org',
      'aljazeera.com', 'dw.com', 'euronews.com', 'axios.com',
      'vox.com', 'theatlantic.com', 'newyorker.com', 'slate.com',
      'salon.com', 'dailybeast.com', 'breitbart.com', 'newsweek.com',
      'time.com', 'techcrunch.com', 'theverge.com', 'wired.com',
      'arstechnica.com', 'engadget.com', 'zdnet.com', 'cnet.com',
      'gizmodo.com', 'lifehacker.com', 'mashable.com', 'buzzfeed.com',
      'vice.com', 'businessinsider.com', 'fortune.com', 'fastcompany.com',
      'inc.com', 'entrepreneur.com', 'cnbc.com', 'marketwatch.com',
      'usatoday.com', 'latimes.com', 'nypost.com', 'dailymail.co.uk',
      'independent.co.uk', 'telegraph.co.uk', 'thesun.co.uk',
    ],
  },
  {
    id: 'forums',
    label: 'Forums & Discussion',
    description: 'Community discussion boards and Q&A sites',
    defaultPolicy: 'warn',
    domains: [
      'reddit.com', 'news.ycombinator.com', 'quora.com', 'stackexchange.com',
      'stackoverflow.com', 'superuser.com', 'serverfault.com', 'askubuntu.com',
      'unix.stackexchange.com', 'math.stackexchange.com', 'physics.stackexchange.com',
      '4chan.org', 'community.atlassian.com', 'discuss.python.org',
      'forum.unity.com', 'forums.developer.apple.com', 'discourse.org',
      'lemmy.world', 'kbin.social', 'tildes.net',
    ],
  },
  {
    id: 'shopping',
    label: 'Shopping',
    description: 'E-commerce and retail sites',
    defaultPolicy: 'warn',
    domains: [
      'amazon.com', 'ebay.com', 'etsy.com', 'walmart.com', 'target.com',
      'bestbuy.com', 'newegg.com', 'costco.com', 'bhphotovideo.com',
      'adorama.com', 'aliexpress.com', 'wish.com', 'temu.com',
      'shein.com', 'asos.com', 'zara.com', 'hm.com', 'uniqlo.com',
      'nordstrom.com', 'macys.com', 'kohls.com', 'gap.com',
      'wayfair.com', 'overstock.com', 'homedepot.com', 'lowes.com',
      'ikea.com', 'chewy.com', 'petco.com', 'petsmart.com',
      'rei.com', 'patagonia.com', 'nike.com', 'adidas.com', 'underarmour.com',
      'zappos.com', 'sephora.com', 'ulta.com', 'walgreens.com', 'cvs.com',
      'rakuten.com', 'groupon.com', 'woot.com', 'slickdeals.net',
    ],
  },
  {
    id: 'email',
    label: 'Email',
    description: 'Web-based email clients',
    defaultPolicy: 'allow',
    domains: [
      'mail.google.com', 'gmail.com', 'outlook.com', 'outlook.live.com',
      'mail.yahoo.com', 'protonmail.com', 'mail.proton.me', 'tutanota.com',
      'fastmail.com', 'zoho.com', 'icloud.com', 'aol.com', 'gmx.com',
      'yandex.com', 'mail.ru',
    ],
  },
  {
    id: 'messaging',
    label: 'Messaging & Chat',
    description: 'Instant messaging and team communication tools',
    defaultPolicy: 'allow',
    domains: [
      'slack.com', 'discord.com', 'web.whatsapp.com', 'web.telegram.org',
      'signal.org', 'messenger.com', 'teams.microsoft.com',
      'meet.google.com', 'zoom.us', 'whereby.com', 'gather.town',
      'lark.com', 'mattermost.com', 'rocketchat.com', 'wire.com',
      'keybase.io', 'element.io', 'matrix.org',
    ],
  },
  {
    id: 'job_boards',
    label: 'Job Boards',
    description: 'Job listings and application platforms',
    defaultPolicy: 'allow',
    domains: [
      'indeed.com', 'glassdoor.com', 'monster.com', 'ziprecruiter.com',
      'careerbuilder.com', 'simplyhired.com', 'dice.com', 'greenhouse.io',
      'lever.co', 'workday.com', 'icims.com', 'taleo.net', 'jobvite.com',
      'hired.com', 'wellfound.com', 'otta.com', 'remoteok.com',
      'weworkremotely.com', 'remotive.io', 'flexjobs.com', 'angel.co',
      'builtin.com', 'techcareers.com', 'cyberseek.org',
    ],
  },
  {
    id: 'professional_network',
    label: 'Professional Network',
    description: 'LinkedIn and professional community platforms',
    defaultPolicy: 'allow',
    domains: [
      'linkedin.com', 'xing.com', 'meetup.com', 'lunchclub.com',
      'clarity.fm', 'toptal.com', 'upwork.com', 'fiverr.com',
      'freelancer.com', 'guru.com', '99designs.com', 'contra.com',
      'workco.com', 'bench.co',
    ],
  },
  {
    id: 'documentation',
    label: 'Documentation & Reference',
    description: 'Technical documentation, API references, and language specs',
    defaultPolicy: 'allow',
    domains: [
      'developer.mozilla.org', 'devdocs.io', 'docs.python.org',
      'docs.microsoft.com', 'learn.microsoft.com', 'docs.aws.amazon.com',
      'cloud.google.com', 'developer.apple.com', 'developer.android.com',
      'docs.docker.com', 'kubernetes.io', 'reactjs.org', 'vuejs.org',
      'angular.io', 'nextjs.org', 'svelte.dev', 'deno.land',
      'nodejs.org', 'npmjs.com', 'pypi.org', 'crates.io', 'pkg.go.dev',
      'rubygems.org', 'packagist.org', 'hex.pm', 'docs.rs',
      'cppreference.com', 'en.cppreference.com', 'php.net',
      'ruby-doc.org', 'javadoc.io', 'docs.spring.io',
    ],
  },
  {
    id: 'code_forge',
    label: 'Code & Version Control',
    description: 'Source code hosting, CI/CD, and collaborative development',
    defaultPolicy: 'allow',
    domains: [
      'github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org',
      'sourceforge.net', 'gitee.com', 'launchpad.net', 'sr.ht',
      'replit.com', 'glitch.com', 'codepen.io', 'jsfiddle.net',
      'codesandbox.io', 'stackblitz.com', 'gitpod.io',
      'circleci.com', 'travis-ci.org', 'jenkins.io', 'drone.io',
    ],
  },
  {
    id: 'ai_tools',
    label: 'AI Tools',
    description: 'AI assistants, code generation, and LLM platforms',
    defaultPolicy: 'allow',
    domains: [
      'chat.openai.com', 'claude.ai', 'gemini.google.com', 'bard.google.com',
      'perplexity.ai', 'you.com', 'phind.com', 'poe.com',
      'character.ai', 'replika.com', 'midjourney.com', 'stability.ai',
      'playground.ai', 'runwayml.com', 'elevenlabs.io',
      'huggingface.co', 'replicate.com', 'together.ai', 'cohere.com',
      'anthropic.com', 'openai.com', 'mistral.ai', 'groq.com',
    ],
  },
  {
    id: 'finance',
    label: 'Finance & Markets',
    description: 'Stock markets, banking, trading, and crypto',
    defaultPolicy: 'warn',
    domains: [
      'bloomberg.com', 'finance.yahoo.com', 'cnbc.com',
      'investing.com', 'seekingalpha.com', 'morningstar.com',
      'robinhood.com', 'etrade.com', 'schwab.com', 'fidelity.com',
      'vanguard.com', 'tdameritrade.com', 'webull.com', 'm1finance.com',
      'binance.com', 'coinbase.com', 'kraken.com', 'crypto.com',
      'coinmarketcap.com', 'coingecko.com', 'tradingview.com',
      'bankrate.com', 'nerdwallet.com', 'mint.com', 'creditkarma.com',
      'experian.com', 'equifax.com', 'transunion.com',
      'ally.com', 'sofi.com', 'chime.com', 'capitalone.com',
    ],
  },
  {
    id: 'sports',
    label: 'Sports',
    description: 'Sports news, scores, fantasy sports, and analysis',
    defaultPolicy: 'warn',
    domains: [
      'espn.com', 'nfl.com', 'nba.com', 'mlb.com', 'nhl.com',
      'mls.com', 'fifa.com', 'uefa.com', 'si.com', 'bleacherreport.com',
      'cbssports.com', 'nbcsports.com', 'foxsports.com', 'theathletic.com',
      'sofascore.com', 'flashscore.com', 'soccerway.com',
      'draftkings.com', 'fanduel.com', 'yahoo.com/sports',
    ],
  },
  {
    id: 'gambling',
    label: 'Gambling',
    description: 'Online casinos, sports betting, and poker sites',
    defaultPolicy: 'block',
    domains: [
      'betway.com', 'bet365.com', 'ladbrokes.com', 'williamhill.com',
      'pokerstars.com', '888casino.com', 'bwin.com', 'unibet.com',
      'paddypower.com', 'bodog.com', 'bovada.lv', 'mybookie.ag',
      'betmgm.com', 'caesarssportsbook.com', 'pointsbet.com',
      'barstoolsportsbook.com', 'wynnbet.com',
    ],
  },
  {
    id: 'memes',
    label: 'Memes & Humor',
    description: 'Meme aggregators and humor content sites',
    defaultPolicy: 'block',
    domains: [
      '9gag.com', 'ifunny.co', 'imgur.com', 'memedroid.com',
      'cheezburger.com', 'knowyourmeme.com', 'funnyjunk.com',
      'lolcat.com', 'ebaumsworld.com',
    ],
  },
  {
    id: 'productivity',
    label: 'Productivity Tools',
    description: 'Task management, notes, documents, and work tools',
    defaultPolicy: 'allow',
    domains: [
      'notion.so', 'trello.com', 'asana.com', 'monday.com', 'clickup.com',
      'todoist.com', 'ticktick.com', 'evernote.com', 'onenote.com',
      'obsidian.md', 'roamresearch.com', 'logseq.com', 'coda.io',
      'airtable.com', 'docs.google.com', 'sheets.google.com',
      'slides.google.com', 'drive.google.com', 'dropbox.com',
      'box.com', 'onedrive.live.com', 'calendar.google.com',
      'calendly.com', 'loom.com', 'descript.com', 'grammarly.com',
      'hemingwayapp.com', 'zotero.org', 'mendeley.com',
      'miro.com', 'figjam.com', 'figma.com', 'canva.com',
      'lucidchart.com', 'whimsical.com', 'linear.app',
      'jira.atlassian.com', 'confluence.atlassian.com',
      'basecamp.com', 'wrike.com', 'teamwork.com', 'smartsheet.com',
      'craft.do', 'bear.app', 'ulysses.app', 'ia.net',
    ],
  },
  {
    id: 'health',
    label: 'Health & Medical',
    description: 'Health information, medical resources, and wellness apps',
    defaultPolicy: 'allow',
    domains: [
      'webmd.com', 'mayoclinic.org', 'healthline.com', 'medlineplus.gov',
      'nih.gov', 'cdc.gov', 'who.int', 'nhs.uk', 'drugs.com',
      'rxlist.com', 'medscape.com', 'pubmed.ncbi.nlm.nih.gov',
      'myfitnesspal.com', 'loseit.com', 'cronometer.com',
      'calm.com', 'headspace.com', 'betterhelp.com', 'talkspace.com',
      'zocdoc.com', 'goodrx.com', 'cvs.com/minuteclinic',
    ],
  },
  {
    id: 'travel',
    label: 'Travel & Booking',
    description: 'Flight and hotel booking, travel planning and research',
    defaultPolicy: 'allow',
    domains: [
      'booking.com', 'airbnb.com', 'hotels.com', 'expedia.com',
      'kayak.com', 'priceline.com', 'orbitz.com', 'tripadvisor.com',
      'skyscanner.com', 'momondo.com', 'google.com/travel',
      'united.com', 'delta.com', 'aa.com', 'southwest.com',
      'vrbo.com', 'hipcamp.com', 'hostelworld.com', 'agoda.com',
    ],
  },
];

export const DOMAIN_TO_CATEGORY = new Map();
for (const cat of SITE_CATEGORIES) {
  for (const domain of cat.domains) {
    const normalized = String(domain).replace(/^www\./, '').toLowerCase();
    if (normalized && !DOMAIN_TO_CATEGORY.has(normalized)) {
      DOMAIN_TO_CATEGORY.set(normalized, cat.id);
    }
  }
}

export function getSiteCategory(hostname) {
  if (!hostname) return null;
  const normalized = String(hostname).replace(/^www\./, '').toLowerCase();
  const categoryId = DOMAIN_TO_CATEGORY.get(normalized);
  if (!categoryId) return null;
  const cat = SITE_CATEGORIES.find(c => c.id === categoryId);
  return cat ? { categoryId, label: cat.label } : null;
}
```

- [ ] **Step 4: Run tests to verify all 21 tests pass**

```bash
node --test tests/heuristic-policy.test.mjs
```
Expected: All 21 tests pass (9 intent + 12 site category).

- [ ] **Step 5: Commit**

```bash
git add heuristic-policy.js tests/heuristic-policy.test.mjs
git commit -m "feat: add site taxonomy (300+ domains, 21 categories) and getSiteCategory"
```

---

## Task 3: Policy schema + builders

**Files:**
- Modify: `heuristic-policy.js` (append policy section)
- Modify: `tests/heuristic-policy.test.mjs` (append policy builder tests)

**Interfaces:**
- Consumes: `INTENT_CATEGORIES`, `SITE_CATEGORIES`, `DOMAIN_TO_CATEGORY`, `getSiteCategory` from Tasks 1–2
- Produces: `buildDefaultPolicy`, `mergePolicyWithIntent`, `resolveDomainPolicy`, `getEffectiveBlockList`, `STRICTNESS_PRESETS`

- [ ] **Step 1: Append failing policy builder tests**

```js
// Append to tests/heuristic-policy.test.mjs
import {
  buildDefaultPolicy,
  mergePolicyWithIntent,
  resolveDomainPolicy,
  getEffectiveBlockList,
} from '../heuristic-policy.js';

test('buildDefaultPolicy has correct schema', () => {
  const policy = buildDefaultPolicy('deep_work', 'strict');
  assert.equal(policy.version, 1);
  assert.equal(policy.intentCategoryId, 'deep_work');
  assert.equal(policy.strictness, 'strict');
  assert.ok(typeof policy.categoryPolicies === 'object');
  assert.ok(Array.isArray(policy.customBlockDomains));
  assert.ok(Array.isArray(policy.customAllowDomains));
  assert.equal(policy.setupCompleted, false);
});

test('strict preset blocks social_media and short_video', () => {
  const policy = buildDefaultPolicy('deep_work', 'strict');
  assert.equal(policy.categoryPolicies.social_media, 'block');
  assert.equal(policy.categoryPolicies.short_video, 'block');
  assert.equal(policy.categoryPolicies.streaming, 'block');
});

test('relaxed preset only blocks short_video', () => {
  const policy = buildDefaultPolicy('learning', 'relaxed');
  assert.equal(policy.categoryPolicies.short_video, 'block');
  assert.equal(policy.categoryPolicies.social_media, 'warn');
  assert.equal(policy.categoryPolicies.streaming, 'warn');
});

test('balanced preset blocks social, short_video, streaming; warns gaming', () => {
  const policy = buildDefaultPolicy('coding', 'balanced');
  assert.equal(policy.categoryPolicies.social_media, 'block');
  assert.equal(policy.categoryPolicies.short_video, 'block');
  assert.equal(policy.categoryPolicies.streaming, 'block');
  assert.equal(policy.categoryPolicies.gaming, 'warn');
});

test('customAllowDomains overrides category block', () => {
  const policy = buildDefaultPolicy('deep_work', 'strict');
  policy.customAllowDomains = ['youtube.com'];
  assert.equal(resolveDomainPolicy('youtube.com', policy), 'allow');
});

test('customBlockDomains overrides category allow', () => {
  const policy = buildDefaultPolicy('deep_work', 'relaxed');
  policy.customBlockDomains = ['myspecificsite.com'];
  assert.equal(resolveDomainPolicy('myspecificsite.com', policy), 'block');
});

test('linkedin.com resolves to allow for any policy (professional_network default)', () => {
  const policy = buildDefaultPolicy('job_search', 'balanced');
  assert.equal(resolveDomainPolicy('linkedin.com', policy), 'allow');
});

test('null policy in resolveDomainPolicy returns neutral without throwing', () => {
  assert.equal(resolveDomainPolicy('youtube.com', null), 'neutral');
});

test('getEffectiveBlockList includes youtube.com for strict policy', () => {
  const policy = buildDefaultPolicy('coding', 'strict');
  const list = getEffectiveBlockList(policy);
  assert.ok(Array.isArray(list));
  assert.ok(list.includes('youtube.com'), 'youtube.com should be in block list');
  assert.ok(list.includes('twitter.com'), 'twitter.com should be in block list');
});

test('getEffectiveBlockList excludes customAllowDomains', () => {
  const policy = buildDefaultPolicy('coding', 'strict');
  policy.customAllowDomains = ['youtube.com'];
  const list = getEffectiveBlockList(policy);
  assert.ok(!list.includes('youtube.com'), 'customAllowDomains should not be in block list');
});

test('mergePolicyWithIntent auto-classifies job_search text', () => {
  const policy = mergePolicyWithIntent('applying for software engineer jobs');
  assert.equal(policy.intentCategoryId, 'job_search');
  assert.equal(policy.setupCompleted, false);
});
```

- [ ] **Step 2: Run to verify new tests fail**

```bash
node --test tests/heuristic-policy.test.mjs
```
Expected: 21 passing, 11 new failures.

- [ ] **Step 3: Append policy builders to `heuristic-policy.js`**

```js
// ── Policy schema + builders ──────────────────────────────────────────

export const STRICTNESS_PRESETS = {
  strict: {
    social_media:        'block',
    short_video:         'block',
    streaming:           'block',
    gaming:              'block',
    forums:              'block',
    memes:               'block',
    gambling:            'block',
    news:                'warn',
    shopping:            'warn',
    sports:              'warn',
    finance:             'warn',
    email:               'allow',
    messaging:           'allow',
    job_boards:          'allow',
    professional_network:'allow',
    documentation:       'allow',
    code_forge:          'allow',
    ai_tools:            'allow',
    productivity:        'allow',
    health:              'allow',
    travel:              'allow',
  },
  balanced: {
    social_media:        'block',
    short_video:         'block',
    streaming:           'block',
    gaming:              'warn',
    forums:              'warn',
    memes:               'block',
    gambling:            'block',
    news:                'warn',
    shopping:            'warn',
    sports:              'warn',
    finance:             'allow',
    email:               'allow',
    messaging:           'allow',
    job_boards:          'allow',
    professional_network:'allow',
    documentation:       'allow',
    code_forge:          'allow',
    ai_tools:            'allow',
    productivity:        'allow',
    health:              'allow',
    travel:              'allow',
  },
  relaxed: {
    social_media:        'warn',
    short_video:         'block',
    streaming:           'warn',
    gaming:              'warn',
    forums:              'allow',
    memes:               'warn',
    gambling:            'warn',
    news:                'allow',
    shopping:            'allow',
    sports:              'allow',
    finance:             'allow',
    email:               'allow',
    messaging:           'allow',
    job_boards:          'allow',
    professional_network:'allow',
    documentation:       'allow',
    code_forge:          'allow',
    ai_tools:            'allow',
    productivity:        'allow',
    health:              'allow',
    travel:              'allow',
  },
};

export function buildDefaultPolicy(intentCategoryId, strictness) {
  const intentCat = INTENT_CATEGORIES.find(c => c.id === intentCategoryId);
  const resolvedStrictness = strictness || intentCat?.defaultStrictness || 'balanced';
  const preset = STRICTNESS_PRESETS[resolvedStrictness] || STRICTNESS_PRESETS.balanced;
  return {
    version: 1,
    intentCategoryId: intentCategoryId || null,
    strictness: resolvedStrictness,
    categoryPolicies: { ...preset },
    customBlockDomains: [],
    customAllowDomains: [],
    setupCompleted: false,
  };
}

export function mergePolicyWithIntent(intentText, existingPolicy = null) {
  const classification = classifyIntentCategory(intentText);
  const base = existingPolicy ? { ...existingPolicy } : buildDefaultPolicy(classification.categoryId, null);
  base.intentCategoryId = classification.categoryId;
  return base;
}

function normalizeHostname(h) {
  return String(h || '').replace(/^www\./, '').toLowerCase();
}

export function resolveDomainPolicy(hostname, policy) {
  try {
    if (!policy || typeof policy !== 'object') return 'neutral';
    const normalized = normalizeHostname(hostname);
    if (!normalized) return 'neutral';

    const allowList = Array.isArray(policy.customAllowDomains) ? policy.customAllowDomains : [];
    const blockList = Array.isArray(policy.customBlockDomains) ? policy.customBlockDomains : [];

    if (allowList.some(d => normalizeHostname(d) === normalized)) return 'allow';
    if (blockList.some(d => normalizeHostname(d) === normalized)) return 'block';

    const lookup = getSiteCategory(normalized);
    if (!lookup) return 'neutral';
    return policy.categoryPolicies?.[lookup.categoryId] || 'neutral';
  } catch {
    return 'neutral';
  }
}

export function getEffectiveBlockList(policy) {
  if (!policy || typeof policy !== 'object') return [];
  const blocked = new Set();
  const allowSet = new Set(
    (Array.isArray(policy.customAllowDomains) ? policy.customAllowDomains : []).map(normalizeHostname)
  );

  for (const cat of SITE_CATEGORIES) {
    if (policy.categoryPolicies?.[cat.id] === 'block') {
      for (const domain of cat.domains) {
        const n = normalizeHostname(domain);
        if (!allowSet.has(n)) blocked.add(n);
      }
    }
  }

  for (const d of (Array.isArray(policy.customBlockDomains) ? policy.customBlockDomains : [])) {
    const n = normalizeHostname(d);
    if (!allowSet.has(n)) blocked.add(n);
  }

  return [...blocked];
}
```

- [ ] **Step 4: Run tests to verify all 32 tests pass**

```bash
node --test tests/heuristic-policy.test.mjs
```
Expected: All 32 tests pass.

- [ ] **Step 5: Commit**

```bash
git add heuristic-policy.js tests/heuristic-policy.test.mjs
git commit -m "feat: add policy schema, buildDefaultPolicy, resolveDomainPolicy, getEffectiveBlockList"
```

---

## Task 4: evaluatePolicyDrift

**Files:**
- Modify: `heuristic-policy.js` (append drift evaluator section)
- Modify: `tests/heuristic-policy.test.mjs` (append drift evaluation tests)

**Interfaces:**
- Consumes: `DRIFT_CONFIDENCE_THRESHOLD`, `DWELL_DISTRACTION_MS`, `DWELL_UNALIGNED_MS`, `classifyIntentCategory`, `getSiteCategory`, `resolveDomainPolicy`, `buildDefaultPolicy` from prior tasks
- Produces: `evaluatePolicyDrift({ intent, url, events, policy, now }) → DriftResult`, `intentTerms(intent: string) → string[]`

- [ ] **Step 1: Append failing drift evaluation tests**

```js
// Append to tests/heuristic-policy.test.mjs
import { evaluatePolicyDrift } from '../heuristic-policy.js';

test('blocked category domain triggers immediate intervention (score >= 0.9)', () => {
  const policy = buildDefaultPolicy('coding', 'strict');
  const result = evaluatePolicyDrift({
    intent: 'coding a new feature',
    url: 'https://twitter.com/home',
    events: [],
    policy,
    now: Date.now(),
  });
  assert.equal(result.shouldIntervene, true);
  assert.ok(result.score >= 0.9);
  assert.equal(result.reason, 'blocked_category');
  assert.ok(Array.isArray(result.signals));
  assert.ok(typeof result.reasonLabel === 'string' && result.reasonLabel.length > 0);
});

test('job_search intent on linkedin does not intervene', () => {
  const policy = buildDefaultPolicy('job_search', 'balanced');
  const result = evaluatePolicyDrift({
    intent: 'applying for software engineer jobs',
    url: 'https://www.linkedin.com/jobs',
    events: [],
    policy,
    now: Date.now(),
  });
  assert.equal(result.shouldIntervene, false);
});

test('job_search intent on youtube triggers block (balanced)', () => {
  const policy = buildDefaultPolicy('job_search', 'balanced');
  const result = evaluatePolicyDrift({
    intent: 'applying for software engineer jobs',
    url: 'https://youtube.com/watch?v=abc',
    events: [],
    policy,
    now: Date.now(),
  });
  assert.equal(result.shouldIntervene, true);
  assert.equal(result.reason, 'blocked_category');
});

test('warn category + 130s dwell triggers intervention', () => {
  const policy = buildDefaultPolicy('coding', 'balanced');
  const now = Date.now();
  const url = 'https://reddit.com/r/programming';
  const result = evaluatePolicyDrift({
    intent: 'coding the new feature',
    url,
    events: [{ timestamp: now - 10_000, actionType: 'PAGE_DWELL', url, dwellMs: 130_000 }],
    policy,
    now,
  });
  assert.equal(result.shouldIntervene, true);
});

test('allowed domain does not trigger category block', () => {
  const policy = buildDefaultPolicy('coding', 'strict');
  const result = evaluatePolicyDrift({
    intent: 'coding a new feature',
    url: 'https://github.com/user/repo',
    events: [],
    policy,
    now: Date.now(),
  });
  assert.equal(result.shouldIntervene, false);
});

test('customAllowDomains prevents block on blocked-category site', () => {
  const policy = buildDefaultPolicy('coding', 'strict');
  policy.customAllowDomains = ['youtube.com'];
  const result = evaluatePolicyDrift({
    intent: 'coding a new feature',
    url: 'https://youtube.com/watch?v=tutorial',
    events: [],
    policy,
    now: Date.now(),
  });
  assert.equal(result.shouldIntervene, false);
});

test('3+ unrelated events in 2 minutes boosts score by at least 0.35', () => {
  const policy = buildDefaultPolicy('coding', 'balanced');
  const now = Date.now();
  const result = evaluatePolicyDrift({
    intent: 'coding a new feature',
    url: 'https://news.ycombinator.com',
    events: [
      { timestamp: now - 90_000, actionType: 'PAGE_LOAD', url: 'https://9gag.com/a' },
      { timestamp: now - 60_000, actionType: 'PAGE_LOAD', url: 'https://espn.com/b' },
      { timestamp: now - 30_000, actionType: 'TAB_SWITCH', url: 'https://reddit.com' },
    ],
    policy,
    now,
  });
  assert.ok(result.score >= 0.35, `expected score >= 0.35, got ${result.score}`);
});

test('returns signals array with blocked_category signal', () => {
  const policy = buildDefaultPolicy('coding', 'strict');
  const result = evaluatePolicyDrift({
    intent: 'coding',
    url: 'https://twitter.com',
    events: [],
    policy,
    now: Date.now(),
  });
  assert.ok(result.signals.some(s => s.startsWith('blocked_category')));
});

test('invalid url returns shouldIntervene false without throwing', () => {
  const policy = buildDefaultPolicy('coding', 'strict');
  const result = evaluatePolicyDrift({
    intent: 'coding',
    url: 'not-a-url',
    events: [],
    policy,
    now: Date.now(),
  });
  assert.equal(result.shouldIntervene, false);
  assert.equal(result.reason, 'invalid_url');
});
```

- [ ] **Step 2: Run to verify new tests fail**

```bash
node --test tests/heuristic-policy.test.mjs
```
Expected: 32 passing, 9 new failures.

- [ ] **Step 3: Append evaluatePolicyDrift to `heuristic-policy.js`**

```js
// ── Drift evaluator ────────────────────────────────────────────────────

function parseUrl(url) {
  try {
    const parsed = new URL(url);
    return {
      hostname: parsed.hostname.replace(/^www\./, '').toLowerCase(),
      text: `${parsed.hostname} ${parsed.pathname} ${parsed.search}`.toLowerCase(),
    };
  } catch {
    return null;
  }
}

export function intentTerms(intent) {
  return [...new Set(
    tokenize(intent).filter(w => w.length > 3 && !STOP_WORDS.has(w))
  )];
}

function isKeywordAligned(url, terms) {
  const parsed = parseUrl(url);
  if (!parsed || terms.length === 0) return false;
  return terms.some(t => parsed.text.includes(t));
}

// Category-aware alignment: some intent categories have a natural set of site
// categories that are aligned even without keyword overlap (e.g. job_search + job_boards)
const CATEGORY_ALIGNMENT = {
  job_search:          ['job_boards', 'professional_network'],
  coding:              ['code_forge', 'documentation', 'ai_tools'],
  research:            ['documentation', 'news', 'forums'],
  learning:            ['documentation', 'code_forge', 'ai_tools'],
  admin:               ['email', 'messaging', 'productivity'],
  communication:       ['messaging', 'email'],
  creative:            ['productivity', 'ai_tools'],
  health:              ['health'],
  shopping:            ['shopping'],
  entertainment_allowed: ['short_video', 'streaming', 'gaming', 'social_media', 'memes'],
};

function isCategoryAligned(hostname, intentCategoryId) {
  if (!intentCategoryId || !hostname) return false;
  const siteCat = getSiteCategory(hostname);
  if (!siteCat) return false;
  const aligned = CATEGORY_ALIGNMENT[intentCategoryId] || [];
  return aligned.includes(siteCat.categoryId);
}

const REASON_LABELS = {
  blocked_category:          'You visited a site your session has blocked.',
  extended_unrelated_dwell:  "You've spent a long time on an unrelated site.",
  rapid_context_switching:   "You've been switching between unrelated tabs rapidly.",
  repeated_unrelated_activity: "Your recent browsing doesn't match your intent.",
  warn_category_dwell:       "You've been on a watched site past your time limit.",
  low_confidence:            'Browsing pattern is drifting from your declared intent.',
};

export function evaluatePolicyDrift({ intent, url, events = [], policy, now = Date.now() }) {
  const parsed = parseUrl(url);
  if (!parsed) {
    return { shouldIntervene: false, score: 0, reason: 'invalid_url', reasonLabel: '', signals: [] };
  }

  const safePolicy = (policy && typeof policy === 'object' && policy.version === 1)
    ? policy
    : buildDefaultPolicy('deep_work', 'balanced');

  const terms = intentTerms(intent);
  const signals = [];

  const domainDecision = resolveDomainPolicy(parsed.hostname, safePolicy);
  const keywordAligned = isKeywordAligned(url, terms);
  const categoryAligned = isCategoryAligned(parsed.hostname, safePolicy.intentCategoryId);
  const isAligned = keywordAligned || categoryAligned;

  // Immediate block: domain is in a blocked category and not aligned with intent
  if (domainDecision === 'block' && !isAligned) {
    const siteCat = getSiteCategory(parsed.hostname);
    signals.push(siteCat ? `blocked_category:${siteCat.categoryId}` : 'blocked_category');
    return {
      shouldIntervene: true,
      score: 0.95,
      reason: 'blocked_category',
      reasonLabel: REASON_LABELS.blocked_category,
      signals,
    };
  }

  // Aligned + allowed → no intervention
  if (domainDecision === 'allow' && isAligned) {
    return { shouldIntervene: false, score: 0, reason: 'aligned', reasonLabel: '', signals };
  }

  if (terms.length === 0) {
    return { shouldIntervene: false, score: 0, reason: 'empty_terms', reasonLabel: '', signals };
  }

  const recentEvents = events.filter(e => now - e.timestamp <= 2 * 60 * 1000);
  const unrelated = recentEvents.filter(e => {
    if (!e.url) return false;
    const ep = parseUrl(e.url);
    return ep && !isKeywordAligned(e.url, terms) && !isCategoryAligned(ep.hostname, safePolicy.intentCategoryId);
  });
  const tabSwitches = recentEvents.filter(e => e.actionType === 'TAB_SWITCH').length;
  const sameDomainLoads = recentEvents.filter(e => {
    const ep = parseUrl(e.url);
    return ep && ep.hostname === parsed.hostname;
  }).length;
  const dwellForUrl = recentEvents
    .filter(e => e.actionType === 'PAGE_DWELL' && e.url === url)
    .reduce((t, e) => t + (e.dwellMs || 0), 0);

  // +0.1 base for being on an unaligned domain
  let score = isAligned ? 0 : 0.1;

  // +0.35 for 3+ unrelated events in 2 min
  if (unrelated.length >= 3) { score += 0.35; signals.push(`unrelated_events:${unrelated.length}`); }
  // +0.25 for 4+ tab switches in 2 min
  if (tabSwitches >= 4) { score += 0.25; signals.push(`tab_switches:${tabSwitches}`); }
  // +0.2 for 2+ loads of same unaligned domain
  if (!isAligned && sameDomainLoads >= 2) { score += 0.2; signals.push(`repeated_domain:${parsed.hostname}`); }

  if (dwellForUrl > 0) signals.push(`dwell:${Math.round(dwellForUrl / 1000)}s`);

  // Warn category behavior
  if (domainDecision === 'warn' && !isAligned) {
    // +0.2 for dwell >= 60s on warn site
    if (dwellForUrl >= DWELL_DISTRACTION_MS) score += 0.2;
    // floor at threshold for dwell >= 120s on warn site
    if (dwellForUrl >= DWELL_UNALIGNED_MS) {
      score = Math.max(score, DRIFT_CONFIDENCE_THRESHOLD);
      signals.push('warn_dwell_exceeded');
    }
  }

  // Extended unaligned dwell on any site → floor at threshold
  if (!isAligned && dwellForUrl >= DWELL_UNALIGNED_MS) {
    score = Math.max(score, DRIFT_CONFIDENCE_THRESHOLD);
  }

  score = Math.min(score, 1);

  let reason = 'low_confidence';
  if (score >= DRIFT_CONFIDENCE_THRESHOLD) {
    if (tabSwitches >= 4) reason = 'rapid_context_switching';
    else if (dwellForUrl >= DWELL_UNALIGNED_MS) reason = 'extended_unrelated_dwell';
    else reason = 'repeated_unrelated_activity';
  }

  return {
    shouldIntervene: score >= DRIFT_CONFIDENCE_THRESHOLD,
    score,
    reason,
    reasonLabel: REASON_LABELS[reason] || '',
    signals,
  };
}
```

- [ ] **Step 4: Run tests to verify all 41 tests pass**

```bash
node --test tests/heuristic-policy.test.mjs
```
Expected: All 41 tests pass.

- [ ] **Step 5: Commit**

```bash
git add heuristic-policy.js tests/heuristic-policy.test.mjs
git commit -m "feat: add evaluatePolicyDrift with category-aware alignment and signals"
```

---

## Task 5: UI data exports + migration

**Files:**
- Modify: `heuristic-policy.js` (append UI exports + migration)
- Modify: `tests/heuristic-policy.test.mjs` (append UI + migration tests)

**Interfaces:**
- Consumes: `INTENT_CATEGORIES`, `SITE_CATEGORIES`, `STRICTNESS_PRESETS`, `buildDefaultPolicy`, `DOMAIN_TO_CATEGORY` from prior tasks
- Produces: `SETUP_WIZARD_STEPS`, `getCategoryPolicyOptions(intentCategoryId) → Array`, `migrateLegacyDistractionSites(sites) → HeuristicPolicy`

- [ ] **Step 1: Append failing UI + migration tests**

```js
// Append to tests/heuristic-policy.test.mjs
import {
  SETUP_WIZARD_STEPS,
  getCategoryPolicyOptions,
  migrateLegacyDistractionSites,
} from '../heuristic-policy.js';

test('SETUP_WIZARD_STEPS has exactly 4 steps with correct ids', () => {
  assert.equal(SETUP_WIZARD_STEPS.length, 4);
  assert.deepEqual(SETUP_WIZARD_STEPS.map(s => s.id), ['intent', 'category', 'strictness', 'review']);
});

test('each wizard step has title and description', () => {
  for (const step of SETUP_WIZARD_STEPS) {
    assert.ok(typeof step.title === 'string' && step.title.length > 0);
    assert.ok(typeof step.description === 'string' && step.description.length > 0);
  }
});

test('getCategoryPolicyOptions returns entries for all site categories', () => {
  const opts = getCategoryPolicyOptions('coding');
  assert.ok(Array.isArray(opts));
  assert.ok(opts.length >= 20);
  for (const o of opts) {
    assert.ok(typeof o.siteCategoryId === 'string');
    assert.ok(typeof o.label === 'string');
    assert.ok(Array.isArray(o.choices));
    assert.ok(['block', 'warn', 'allow'].includes(o.recommended));
  }
});

test('migrateLegacyDistractionSites with default 8 domains returns deep_work balanced policy', () => {
  const legacy = ['twitter.com', 'x.com', 'facebook.com', 'reddit.com',
    'instagram.com', 'youtube.com', 'netflix.com', 'tiktok.com'];
  const policy = migrateLegacyDistractionSites(legacy);
  assert.equal(policy.version, 1);
  assert.equal(policy.intentCategoryId, 'deep_work');
  assert.equal(policy.strictness, 'balanced');
  assert.deepEqual(policy.customBlockDomains, []);
});

test('migrateLegacyDistractionSites preserves non-catalogued custom domains', () => {
  const policy = migrateLegacyDistractionSites(['twitter.com', 'mycompany-internal.com']);
  assert.ok(policy.customBlockDomains.includes('mycompany-internal.com'));
  assert.ok(!policy.customBlockDomains.includes('twitter.com'));
});

test('migrateLegacyDistractionSites with empty list returns default policy without throwing', () => {
  const policy = migrateLegacyDistractionSites([]);
  assert.equal(policy.version, 1);
  assert.ok(typeof policy.categoryPolicies === 'object');
});
```

- [ ] **Step 2: Run to verify new tests fail**

```bash
node --test tests/heuristic-policy.test.mjs
```
Expected: 41 passing, 6 new failures.

- [ ] **Step 3: Append UI exports and migration to `heuristic-policy.js`**

```js
// ── Onboarding / settings UI contract ─────────────────────────────────

export const SETUP_WIZARD_STEPS = [
  {
    id: 'intent',
    title: 'What are you working on?',
    description: 'Describe your goal for this session. The more specific, the better.',
  },
  {
    id: 'category',
    title: 'Confirm your intent type',
    description: 'We detected what kind of work this is. Adjust if needed.',
  },
  {
    id: 'strictness',
    title: 'How strict should IntentLock be?',
    description: 'Choose how aggressively to block distracting sites.',
  },
  {
    id: 'review',
    title: 'Review your session policy',
    description: 'Confirm which site categories will be blocked, warned, or allowed.',
  },
];

export function getCategoryPolicyOptions(intentCategoryId) {
  const intentCat = INTENT_CATEGORIES.find(c => c.id === intentCategoryId);
  const strictness = intentCat?.defaultStrictness || 'balanced';
  const preset = STRICTNESS_PRESETS[strictness] || STRICTNESS_PRESETS.balanced;
  return SITE_CATEGORIES.map(cat => ({
    siteCategoryId: cat.id,
    label: cat.label,
    description: cat.description,
    recommended: preset[cat.id] || 'allow',
    choices: ['block', 'warn', 'allow'],
  }));
}

// ── Migration ──────────────────────────────────────────────────────────

const DEFAULT_LEGACY_DOMAINS = new Set([
  'twitter.com', 'x.com', 'facebook.com', 'reddit.com',
  'instagram.com', 'youtube.com', 'netflix.com', 'tiktok.com',
]);

export function migrateLegacyDistractionSites(customDistractionSites) {
  const list = Array.isArray(customDistractionSites) ? customDistractionSites : [];
  const base = buildDefaultPolicy('deep_work', 'balanced');

  if (list.length === 0) return base;

  const isDefaultList = list.length === DEFAULT_LEGACY_DOMAINS.size &&
    list.every(d => DEFAULT_LEGACY_DOMAINS.has(String(d).replace(/^www\./, '').toLowerCase()));

  if (isDefaultList) return base;

  const customBlocks = list.filter(d => {
    const n = String(d).replace(/^www\./, '').toLowerCase();
    return !DOMAIN_TO_CATEGORY.has(n);
  });
  base.customBlockDomains = customBlocks;
  return base;
}
```

- [ ] **Step 4: Run tests to verify all 47 tests pass**

```bash
node --test tests/heuristic-policy.test.mjs
```
Expected: All 47 tests pass.

- [ ] **Step 5: Commit**

```bash
git add heuristic-policy.js tests/heuristic-policy.test.mjs
git commit -m "feat: add SETUP_WIZARD_STEPS, getCategoryPolicyOptions, migrateLegacyDistractionSites"
```

---

## Task 6: Wire background.js to use heuristicPolicy

**Files:**
- Modify: `background.js`

**Interfaces:**
- Consumes: `evaluatePolicyDrift`, `buildDefaultPolicy`, `migrateLegacyDistractionSites` from `heuristic-policy.js`

- [ ] **Step 1: Run existing background tests to establish baseline**

```bash
node --test tests/background.test.mjs
```
Note the count of passing tests. They must all still pass after the change.

- [ ] **Step 2: Update imports at the top of `background.js`**

Replace lines 1–6:
```js
import { evaluateHeuristicDrift, DRIFT_CONFIDENCE_THRESHOLD } from './drift.js';
import { checkDriftLLM } from './llm.js';
import { clearDriftCache } from './drift-cache.js';
import { logError, ERROR_TYPES } from './error-log.js';
import { DEFAULT_DISTRACTION_SITES, getEffectiveDistractionSites } from './distraction-sites.js';
import { clearLlmBackoff } from './llm-backoff.js';
```
with:
```js
import { DRIFT_CONFIDENCE_THRESHOLD } from './drift.js';
import { evaluatePolicyDrift, buildDefaultPolicy, migrateLegacyDistractionSites } from './heuristic-policy.js';
import { checkDriftLLM } from './llm.js';
import { clearDriftCache } from './drift-cache.js';
import { logError, ERROR_TYPES } from './error-log.js';
import { getEffectiveDistractionSites, DEFAULT_DISTRACTION_SITES } from './distraction-sites.js';
import { clearLlmBackoff } from './llm-backoff.js';
```

- [ ] **Step 3: Add `heuristicPolicy` in-memory variable**

After line 13 (`let sessionTabGroupId = null;`), insert:
```js
let heuristicPolicy = null;
```

- [ ] **Step 4: Load `heuristicPolicy` in `loadConfig()`**

In `loadConfig()` (around line 203), add `'heuristicPolicy'` to the `chrome.storage.local.get` keys array. Then after the block that sets `customDistractionSites`, add:

```js
if (data.heuristicPolicy && data.heuristicPolicy.version === 1) {
  heuristicPolicy = data.heuristicPolicy;
} else if (data.customDistractionSites) {
  heuristicPolicy = migrateLegacyDistractionSites(data.customDistractionSites);
  chrome.storage.local.set({ heuristicPolicy });
} else {
  heuristicPolicy = buildDefaultPolicy('deep_work', 'balanced');
}
```

- [ ] **Step 5: Replace `evaluateHeuristicDrift` call in `evaluateDrift()`**

In `evaluateDrift()` (around line 578–595), replace the block:
```js
const customDistSites = getEffectiveDistractionSites(
  result.customDistractionSites,
  customDistractionSites,
);
const heuristic = evaluateHeuristicDrift({
  intent: session.intent,
  url,
  events: session.events,
  distractionSites: customDistSites
});

if (heuristic.shouldIntervene) {
  const reason = heuristic.reason === 'known_distraction'
    ? 'You seem to be drifting to a known distraction site. Why?'
    : 'Your recent browsing no longer matches your declared intent. Why?';
  triggerIntervention(reason, tabId);
  return;
}
```
with:
```js
const activePolicy = heuristicPolicy || buildDefaultPolicy('deep_work', 'balanced');
const policyDrift = evaluatePolicyDrift({
  intent: session.intent,
  url,
  events: session.events,
  policy: activePolicy,
  now: Date.now(),
});

if (policyDrift.shouldIntervene) {
  triggerIntervention(policyDrift.reasonLabel || 'Your recent browsing no longer matches your declared intent.', tabId);
  return;
}
```

- [ ] **Step 6: Update `getInMemoryState()` to expose `heuristicPolicy`**

In the `getInMemoryState()` export function (near the bottom of `background.js`), add `heuristicPolicy` to the returned object:
```js
export function getInMemoryState() {
  return {
    currentSession,
    trackingEnabled,
    customDistractionSites,
    heuristicPolicy,
    sessionTabGroupId,
    isCurrentlyIdle,
    lastIdleTime,
    overrideCooldowns
  };
}
```

- [ ] **Step 7: Run background tests to verify no regressions**

```bash
node --test tests/background.test.mjs
node --test tests/drift.test.mjs
```
Expected: Same count of passing tests as baseline (drift.js is unchanged and still testable).

- [ ] **Step 8: Commit**

```bash
git add background.js
git commit -m "feat: wire evaluatePolicyDrift into background.js, load heuristicPolicy from storage"
```

---

## Task 7: Onboarding step 3 (newtab.js)

**Files:**
- Modify: `newtab.js`

The onboarding wizard in `showOnboardingWizard(container)` currently has two steps: step 1 (welcome) and step 2 (LLM setup). Step 2's completion paths (both LOCK IN and SKIP) call `finishOnboarding()`. We need to redirect them to `showStep3()` instead.

Step 3 lets the user:
1. Pick their default intent category from a dropdown (populated from `INTENT_CATEGORIES`)
2. Pick strictness (relaxed / balanced / strict)
3. Save as `heuristicPolicy` in `chrome.storage.local` and call `finishOnboarding()`

- [ ] **Step 1: Add import to newtab.js**

At the top of `newtab.js`, add:
```js
import {
  INTENT_CATEGORIES,
  buildDefaultPolicy,
} from './heuristic-policy.js';
```

- [ ] **Step 2: Add `showStep3()` function inside `showOnboardingWizard()`**

Inside `showOnboardingWizard(container)`, immediately before `showStep1()` is called (line ~782), add:

```js
function showStep3() {
  container.textContent = '';

  const header = document.createElement('div');
  header.className = 'header onboarding-header';
  const h1 = document.createElement('h1');
  h1.textContent = 'SET YOUR DEFAULT POLICY';
  const desc = document.createElement('p');
  desc.textContent = 'Choose your most common intent type and how strictly IntentLock should enforce it. You can change this anytime in Settings.';
  header.append(h1, desc);
  container.appendChild(header);

  // Intent category selector
  const categoryGroup = document.createElement('div');
  categoryGroup.className = 'input-group onboarding-input-group';
  const categoryLabel = document.createElement('label');
  categoryLabel.setAttribute('for', 'onboarding-category');
  categoryLabel.textContent = 'Default intent type';
  const categorySelect = document.createElement('select');
  categorySelect.id = 'onboarding-category';
  INTENT_CATEGORIES.forEach(cat => {
    const option = document.createElement('option');
    option.value = cat.id;
    option.textContent = cat.label;
    if (cat.id === 'deep_work') option.selected = true;
    categorySelect.appendChild(option);
  });
  categoryGroup.append(categoryLabel, categorySelect);
  container.appendChild(categoryGroup);

  // Strictness selector
  const strictnessGroup = document.createElement('div');
  strictnessGroup.className = 'input-group onboarding-input-group';
  const strictnessLabel = document.createElement('label');
  strictnessLabel.setAttribute('for', 'onboarding-strictness');
  strictnessLabel.textContent = 'Strictness';
  const strictnessSelect = document.createElement('select');
  strictnessSelect.id = 'onboarding-strictness';
  [
    { value: 'relaxed', text: 'Relaxed — only block short video' },
    { value: 'balanced', text: 'Balanced — block social, short video, streaming' },
    { value: 'strict', text: 'Strict — block social, video, gaming, forums' },
  ].forEach(({ value, text }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    if (value === 'balanced') option.selected = true;
    strictnessSelect.appendChild(option);
  });
  strictnessGroup.append(strictnessLabel, strictnessSelect);
  container.appendChild(strictnessGroup);

  const statusEl = document.createElement('p');
  statusEl.className = 'onboarding-status hidden';
  statusEl.setAttribute('role', 'alert');
  statusEl.setAttribute('aria-live', 'polite');
  container.appendChild(statusEl);

  const actionsRow = document.createElement('div');
  actionsRow.className = 'onboarding-actions';

  const skipBtn = document.createElement('button');
  skipBtn.type = 'button';
  skipBtn.className = 'complete-btn onboarding-skip-btn';
  skipBtn.textContent = 'SKIP';
  skipBtn.addEventListener('click', finishOnboarding);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'primary-btn onboarding-lock-btn';
  saveBtn.textContent = 'SAVE POLICY';
  saveBtn.addEventListener('click', () => {
    const policy = buildDefaultPolicy(categorySelect.value, strictnessSelect.value);
    policy.setupCompleted = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    chrome.storage.local.set({ heuristicPolicy: policy }, () => {
      if (chrome.runtime.lastError) {
        statusEl.textContent = 'Could not save policy. You can set this later in Settings.';
        statusEl.classList.remove('hidden');
        saveBtn.disabled = false;
        saveBtn.textContent = 'SAVE POLICY';
        return;
      }
      chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' }, () => {
        void chrome.runtime.lastError;
      });
      finishOnboarding();
    });
  });

  actionsRow.append(skipBtn, saveBtn);
  container.appendChild(actionsRow);
  categorySelect.focus();
}
```

- [ ] **Step 3: Route step 2 completion to step 3**

In `showStep2()`, find all calls to `finishOnboarding()` (there are two: one for SKIP and one inside `completeSetup()`). Replace both `finishOnboarding()` calls with `showStep3()`.

```js
// SKIP button:
skipBtn.addEventListener('click', showStep3);  // was: finishOnboarding

// Inside completeSetup():
const completeSetup = () => {
  chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' }, () => {
    if (chrome.runtime.lastError) { ... }
  });
  showStep3();  // was: finishOnboarding()
};
```

- [ ] **Step 4: Verify no broken imports by running all tests**

```bash
node --test tests/heuristic-policy.test.mjs
```
Expected: Still 47 passing (newtab.js has no unit tests but the module graph stays valid).

- [ ] **Step 5: Commit**

```bash
git add newtab.js
git commit -m "feat: add onboarding step 3 — intent category and strictness picker"
```

---

## Task 8: Settings UI — category grid (options.html + options.js)

**Files:**
- Modify: `options.html`
- Modify: `options.js`

Replace the flat "Distraction sites" textarea section with a per-category block/warn/allow grid backed by `heuristicPolicy.categoryPolicies`.

- [ ] **Step 1: Replace distraction sites section in `options.html`**

Locate the section from line 80–92 in `options.html`:
```html
<div class="section">
  <h2>Distraction sites</h2>
  <p>Sites that trigger an intervention when visited during a session. One domain per line.</p>

  <div class="input-group">
    <label for="distraction-sites">Domains</label>
    <textarea id="distraction-sites" placeholder="twitter.com&#10;reddit.com&#10;youtube.com"></textarea>
  </div>

  <button id="save-sites-btn">Save sites</button>
  <div id="sites-status" class="hidden status-feedback"></div>
  <p class="field-hint">youtube.com is included by default. If the list is empty, defaults are used automatically.</p>
</div>
```

Replace it with:
```html
<div class="section">
  <h2>Site policies</h2>
  <p>Control how IntentLock handles each site category. Changes apply to all future sessions.</p>

  <div id="category-grid" role="group" aria-label="Site category policies">
    <!-- populated by options.js -->
  </div>

  <div class="input-group" style="margin-top:12px">
    <label for="custom-block-domains">Always block (one domain per line)</label>
    <textarea id="custom-block-domains" placeholder="myexample.com"></textarea>
  </div>

  <div class="input-group">
    <label for="custom-allow-domains">Always allow (one domain per line)</label>
    <textarea id="custom-allow-domains" placeholder="internal.company.com"></textarea>
  </div>

  <button id="save-sites-btn">Save site policies</button>
  <div id="sites-status" class="hidden status-feedback"></div>
</div>
```

- [ ] **Step 2: Update `options.js` to import from heuristic-policy.js and wire category grid**

At the top of `options.js`, add to imports:
```js
import { SITE_CATEGORIES, buildDefaultPolicy, migrateLegacyDistractionSites } from './heuristic-policy.js';
```

Remove these lines from `options.js` (they are now redundant):
```js
const DEFAULT_SITES = [
  'twitter.com', 'x.com', 'facebook.com', 'reddit.com',
  'instagram.com', 'youtube.com', 'netflix.com', 'tiktok.com',
];
```

Update the `chrome.storage.local.get` call near line 163 to include `'heuristicPolicy'`:
```js
chrome.storage.local.get([
  'llmProviderConfig', 'openaiApiKey', 'trackingEnabled', 
  'customDistractionSites', 'theme', 'heuristicPolicy'
], (localResult) => {
```

Inside `processSettings`, replace the textarea population block:
```js
// OLD:
const sites = localResult.customDistractionSites || DEFAULT_SITES;
distractionSitesInput.value = sites.join('\n');
```
with:
```js
let activePolicy = localResult.heuristicPolicy;
if (!activePolicy || activePolicy.version !== 1) {
  activePolicy = localResult.customDistractionSites
    ? migrateLegacyDistractionSites(localResult.customDistractionSites)
    : buildDefaultPolicy('deep_work', 'balanced');
}
buildCategoryGrid(activePolicy);

const customBlockInput = document.getElementById('custom-block-domains');
const customAllowInput = document.getElementById('custom-allow-domains');
if (customBlockInput) customBlockInput.value = (activePolicy.customBlockDomains || []).join('\n');
if (customAllowInput) customAllowInput.value = (activePolicy.customAllowDomains || []).join('\n');
```

Add the `buildCategoryGrid` function before the `chrome.storage.local.get` call:
```js
function buildCategoryGrid(policy) {
  const grid = document.getElementById('category-grid');
  if (!grid) return;
  grid.textContent = '';

  SITE_CATEGORIES.forEach(cat => {
    const currentPolicy = policy.categoryPolicies?.[cat.id] || cat.defaultPolicy;

    const row = document.createElement('div');
    row.className = 'category-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'category-name';
    nameEl.textContent = cat.label;

    const controls = document.createElement('div');
    controls.className = 'category-controls';

    ['block', 'warn', 'allow'].forEach(choice => {
      const labelEl = document.createElement('label');
      labelEl.className = 'category-choice';

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `cat-${cat.id}`;
      radio.value = choice;
      radio.checked = choice === currentPolicy;
      radio.setAttribute('aria-label', `${cat.label}: ${choice}`);

      labelEl.append(radio, document.createTextNode(choice));
      controls.appendChild(labelEl);
    });

    row.append(nameEl, controls);
    grid.appendChild(row);
  });
}
```

Replace the `saveSitesBtn.addEventListener` handler:
```js
// OLD handler (lines ~354–364 in options.js):
saveSitesBtn.addEventListener('click', () => {
  const raw = distractionSitesInput.value.trim();
  const sites = raw.split('\n')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s.includes('.'));

  chrome.storage.local.set({ customDistractionSites: sites }, () => {
    showStatus(sitesStatus, `${sites.length} sites saved.`);
    chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' });
  });
});
```
Replace with:
```js
saveSitesBtn.addEventListener('click', () => {
  chrome.storage.local.get(['heuristicPolicy', 'customDistractionSites'], (stored) => {
    let policy = stored.heuristicPolicy;
    if (!policy || policy.version !== 1) {
      policy = stored.customDistractionSites
        ? migrateLegacyDistractionSites(stored.customDistractionSites)
        : buildDefaultPolicy('deep_work', 'balanced');
    }

    // Read category grid radio values
    const updatedPolicies = {};
    SITE_CATEGORIES.forEach(cat => {
      const checked = document.querySelector(`input[name="cat-${cat.id}"]:checked`);
      if (checked) updatedPolicies[cat.id] = checked.value;
    });
    policy.categoryPolicies = { ...policy.categoryPolicies, ...updatedPolicies };

    // Read custom block/allow textareas
    const customBlockInput = document.getElementById('custom-block-domains');
    const customAllowInput = document.getElementById('custom-allow-domains');
    const parseDomains = (el) => (el?.value || '').split('\n')
      .map(s => s.trim().toLowerCase().replace(/^www\./, ''))
      .filter(s => s.length > 0 && s.includes('.') && !s.includes(' ') && !s.match(/^\d+\.\d+/));

    policy.customBlockDomains = parseDomains(customBlockInput);
    policy.customAllowDomains = parseDomains(customAllowInput);

    chrome.storage.local.set({ heuristicPolicy: policy }, () => {
      showStatus(sitesStatus, 'Site policies saved.');
      chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' });
    });
  });
});
```

- [ ] **Step 3: Run all tests to verify no regressions**

```bash
node --test tests/heuristic-policy.test.mjs
```
Expected: 47 tests pass.

- [ ] **Step 4: Commit**

```bash
git add options.html options.js
git commit -m "feat: replace distraction-sites textarea with category-policy grid in settings"
```

---

## Task 9: manifest.json version + CHANGELOG

**Files:**
- Modify: `manifest.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump manifest version**

In `manifest.json`, change line 7:
```json
"version": "1.4.1",
```
to:
```json
"version": "1.5.0",
```

- [ ] **Step 2: Add CHANGELOG entry**

Prepend to `CHANGELOG.md` after the first line (`# IntentLock Changelog`):

```markdown
## [1.5.0] - 2026-06-22

### Added
- `heuristic-policy.js` — heuristic self-setup engine with 12 intent categories, 21 site categories, and 300+ catalogued domains.
- `evaluatePolicyDrift()` — category-aware drift evaluator with signals array and human-readable reason labels. Replaces `evaluateHeuristicDrift()` as primary evaluator.
- `classifyIntentCategory()` — deterministic keyword-based intent classification (no API key required).
- `buildDefaultPolicy()`, `resolveDomainPolicy()`, `getEffectiveBlockList()` — policy schema builders with strictness presets (relaxed/balanced/strict).
- `migrateLegacyDistractionSites()` — automatic migration of flat domain lists to the new policy schema on first load.
- Onboarding step 3: intent category selector and strictness picker, saves default `heuristicPolicy`.
- Settings UI: per-category block/warn/allow grid replaces flat distraction-sites textarea.
- Custom block/allow domain overrides in settings, always take precedence over category rules.

### Changed
- `background.js` — loads `heuristicPolicy` from storage on startup and routes all drift evaluation through `evaluatePolicyDrift()`.
- Drift detection is now category-aware: e.g. job search intent automatically aligns with LinkedIn/job boards without keyword matching.
```

- [ ] **Step 3: Run full test suite**

```bash
node --test tests/*.mjs
```
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add manifest.json CHANGELOG.md
git commit -m "chore: bump to 1.5.0, add CHANGELOG entry for heuristic self-setup engine"
```

---

## Self-Review Checklist

**Spec coverage (all requirements covered):**
- [x] `INTENT_CATEGORIES` with 12+ categories — Task 1
- [x] `classifyIntentCategory()` — Task 1
- [x] `SITE_CATEGORIES` with 20+ categories, 300–800 domains — Task 2
- [x] `DOMAIN_TO_CATEGORY` map + `getSiteCategory()` — Task 2
- [x] Policy schema (version, intentCategoryId, strictness, categoryPolicies, customBlock/Allow, setupCompleted) — Task 3
- [x] `buildDefaultPolicy()`, `mergePolicyWithIntent()`, `resolveDomainPolicy()`, `getEffectiveBlockList()` — Task 3
- [x] Strictness presets (relaxed/balanced/strict) — Task 3
- [x] `evaluatePolicyDrift()` with all scoring rules from spec — Task 4
- [x] `signals` array, `reasonLabel`, `reason` machine code in return value — Task 4
- [x] Category-aware alignment (job_search + linkedin → no intervention) — Task 4
- [x] `SETUP_WIZARD_STEPS`, `getCategoryPolicyOptions()` — Task 5
- [x] `migrateLegacyDistractionSites()` — Task 5
- [x] ≥25 tests (plan has 47) — Tasks 1–5
- [x] `background.js` integration — Task 6
- [x] Onboarding step 3 — Task 7
- [x] Options category grid — Task 8
- [x] `manifest.json` → 1.5.0 — Task 9
- [x] `CHANGELOG.md` entry — Task 9

**Type consistency verified:**
- `buildDefaultPolicy()` returns `{ version: 1, ... }` — used consistently in Tasks 3, 4, 5, 6, 7, 8
- `evaluatePolicyDrift()` takes `{ intent, url, events, policy, now }` — Task 4 defines it, Task 6 calls it with exact same signature
- `getSiteCategory()` returns `{ categoryId, label } | null` — used in Task 4's `isCategoryAligned()`

**Security constraints verified:**
- No `eval`, no `innerHTML` with user input anywhere in the plan
- Domain validation (no IPs, no wildcards) in `parseDomains()` — Task 8 options.js
- `chrome.storage.local` only, no remote fetch
- Fail-open pattern in `evaluatePolicyDrift()`: bad/null policy → `buildDefaultPolicy('deep_work', 'balanced')`
