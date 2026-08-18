import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INTENT_CATEGORIES,
  classifyIntentCategory,
  SITE_CATEGORIES,
  DOMAIN_TO_CATEGORY,
  getSiteCategory,
  buildDefaultPolicy,
  mergePolicyWithIntent,
  resolveDomainPolicy,
  getEffectiveBlockList,
  evaluatePolicyDrift,
  isUrlAligned,
  intentTerms,
  normalizeCustomDomainRules,
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

test('site catalog resolves parent-domain subdomains and path-specific entries', () => {
  assert.equal(getSiteCategory('m.youtube.com')?.categoryId, 'short_video');
  assert.equal(getSiteCategory('google.com', '/travel')?.categoryId, 'travel');
  assert.equal(resolveDomainPolicy('https://google.com/travel/flights', buildDefaultPolicy('coding', 'balanced')), 'allow');
});

test('custom domain normalization preserves path rules for settings and policy matching', () => {
  assert.deepEqual(
    normalizeCustomDomainRules(' Google.com/travel/ \nhttps://WWW.Example.com/work?view=1\ninvalid'),
    ['google.com/travel', 'example.com/work'],
  );

  const policy = buildDefaultPolicy('coding', 'strict');
  policy.customAllowDomains = ['youtube.com/watch'];
  assert.equal(
    evaluatePolicyDrift({
      intent: 'coding the new feature',
      url: 'https://youtube.com/watch?v=123',
      events: [],
      policy,
    }).reason,
    'custom_allow',
  );
});

test('site catalog resolves overlapping entries explicitly instead of first-write wins', () => {
  assert.equal(getSiteCategory('cvs.com')?.categoryId, 'shopping');
  assert.equal(getSiteCategory('cvs.com', '/minuteclinic')?.categoryId, 'health');
});

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

test('getEffectiveBlockList represents path allows as scoped exceptions', () => {
  const policy = buildDefaultPolicy('coding', 'strict');
  policy.customAllowDomains = ['youtube.com/watch'];
  const list = getEffectiveBlockList(policy);

  assert.ok(!list.includes('youtube.com'), 'path allow must not block the whole hostname');
  assert.ok(list.includes('youtube.com/*'), 'path-aware block rule should cover the remaining paths');
  assert.ok(list.includes('!youtube.com/watch'), 'path allow should be retained as an exception');
  assert.equal(resolveDomainPolicy('https://youtube.com/watch?v=123', policy), 'allow');
  assert.equal(resolveDomainPolicy('https://youtube.com/shorts/123', policy), 'block');
});

test('getEffectiveBlockList preserves path-specific catalog and custom rules', () => {
  const policy = buildDefaultPolicy('coding', 'balanced');
  policy.categoryPolicies.travel = 'block';
  let list = getEffectiveBlockList(policy);
  assert.ok(list.includes('google.com/travel'));
  assert.ok(!list.includes('google.com'));

  policy.customAllowDomains = ['google.com/travel'];
  list = getEffectiveBlockList(policy);
  assert.ok(!list.includes('google.com/travel'));

  policy.customBlockDomains = ['example.com/work'];
  list = getEffectiveBlockList(policy);
  assert.ok(list.includes('example.com/work'));
});

test('getEffectiveBlockList scopes nested catalog and custom path allows', () => {
  const policy = buildDefaultPolicy('coding', 'balanced');
  policy.categoryPolicies.shopping = 'block';
  let list = getEffectiveBlockList(policy);

  assert.ok(list.includes('cvs.com/*'));
  assert.ok(list.includes('!cvs.com/minuteclinic'));
  assert.ok(!list.includes('cvs.com'));

  policy.categoryPolicies.travel = 'block';
  policy.customAllowDomains = ['google.com/travel/flights'];
  list = getEffectiveBlockList(policy);

  assert.ok(list.includes('google.com/travel/*'));
  assert.ok(list.includes('!google.com/travel/flights'));
  assert.ok(!list.includes('google.com/travel'));
});

test('mergePolicyWithIntent auto-classifies job_search text', () => {
  const policy = mergePolicyWithIntent('applying for software engineer jobs');
  assert.equal(policy.intentCategoryId, 'job_search');
  assert.equal(policy.setupCompleted, false);
});

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

test('dwell thresholds use delta events once and ignore repeated cumulative snapshots', () => {
  const policy = buildDefaultPolicy('coding', 'balanced');
  const now = Date.now();
  const url = 'https://reddit.com/r/programming';
  const at59 = evaluatePolicyDrift({
    intent: 'coding the new feature',
    url,
    events: [
      { timestamp: now - 3_000, actionType: 'PAGE_DWELL', url, dwellMs: 59_000 },
      { timestamp: now - 2_000, actionType: 'PAGE_DWELL', url, dwellMs: 59_000 },
    ],
    policy,
    now,
  });
  const at60 = evaluatePolicyDrift({
    intent: 'coding the new feature',
    url,
    events: [{ timestamp: now - 2_000, actionType: 'PAGE_DWELL', url, dwellDeltaMs: 60_000, dwellMs: 60_000 }],
    policy,
    now,
  });
  const repeatedAt60 = evaluatePolicyDrift({
    intent: 'coding the new feature',
    url,
    events: [
      { timestamp: now - 3_000, actionType: 'PAGE_DWELL', url, dwellMs: 60_000 },
      { timestamp: now - 2_000, actionType: 'PAGE_DWELL', url, dwellMs: 60_000 },
    ],
    policy,
    now,
  });
  const at119 = evaluatePolicyDrift({
    intent: 'coding the new feature',
    url,
    events: [{ timestamp: now - 2_000, actionType: 'PAGE_DWELL', url, dwellDeltaMs: 119_000, dwellMs: 119_000 }],
    policy,
    now,
  });
  const at120 = evaluatePolicyDrift({
    intent: 'coding the new feature',
    url,
    events: [{ timestamp: now - 2_000, actionType: 'PAGE_DWELL', url, dwellDeltaMs: 120_000, dwellMs: 120_000 }],
    policy,
    now,
  });

  assert.equal(at59.shouldIntervene, false);
  assert.equal(at60.shouldIntervene, false);
  assert.equal(repeatedAt60.shouldIntervene, false);
  assert.equal(at119.shouldIntervene, false);
  assert.equal(at120.shouldIntervene, true);
  assert.ok(!at59.signals.some((signal) => signal === 'unrelated_events:2'));
  assert.ok(!at59.signals.some((signal) => signal.startsWith('repeated_domain:')));
});

test('mixed legacy cumulative and new dwell deltas are counted without double-counting', () => {
  const policy = buildDefaultPolicy('coding', 'balanced');
  const now = Date.now();
  const url = 'https://reddit.com/r/programming';
  const result = evaluatePolicyDrift({
    intent: 'coding the new feature',
    url,
    events: [
      { timestamp: now - 3_000, actionType: 'PAGE_DWELL', url, dwellMs: 60_000 },
      {
        timestamp: now - 2_000,
        actionType: 'PAGE_DWELL',
        url,
        dwellMs: 120_000,
        dwellDeltaMs: 60_000,
      },
    ],
    policy,
    now,
  });

  assert.equal(result.shouldIntervene, true);
  assert.ok(result.signals.includes('dwell:120s'));
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

test('custom allow and block rules match subdomains with block taking precedence', () => {
  const allowPolicy = buildDefaultPolicy('coding', 'strict');
  allowPolicy.customAllowDomains = ['youtube.com'];
  assert.equal(resolveDomainPolicy('m.youtube.com', allowPolicy), 'allow');
  assert.equal(evaluatePolicyDrift({
    intent: 'coding a new feature',
    url: 'https://m.youtube.com/watch?v=tutorial',
    events: [],
    policy: allowPolicy,
  }).shouldIntervene, false);

  const blockPolicy = buildDefaultPolicy('coding', 'strict');
  blockPolicy.customAllowDomains = ['youtube.com'];
  blockPolicy.customBlockDomains = ['youtube.com'];
  const result = evaluatePolicyDrift({
    intent: 'find YouTube API documentation',
    url: 'https://m.youtube.com/developers',
    events: [],
    policy: blockPolicy,
  });
  assert.equal(resolveDomainPolicy('m.youtube.com', blockPolicy), 'block');
  assert.equal(result.shouldIntervene, true);
  assert.equal(result.reason, 'blocked_category');
});

test('custom blocks are never treated as aligned by alignment helpers', () => {
  const policy = buildDefaultPolicy('research', 'balanced');
  policy.customBlockDomains = ['youtube.com'];
  assert.equal(
    isUrlAligned(
      'research YouTube API documentation',
      'https://m.youtube.com/developers',
      policy,
      ['youtube.com'],
    ),
    false,
  );
});

test('deep_work and writing categories align with work-oriented catalog sites', () => {
  const deepWork = buildDefaultPolicy('deep_work', 'strict');
  assert.equal(evaluatePolicyDrift({
    intent: 'focus on the project deliverable',
    url: 'https://docs.google.com/document/d/abc',
    events: [],
    policy: deepWork,
  }).shouldIntervene, false);

  const writing = buildDefaultPolicy('writing', 'strict');
  assert.equal(evaluatePolicyDrift({
    intent: 'write the project article',
    url: 'https://docs.google.com/document/d/abc',
    events: [],
    policy: writing,
  }).shouldIntervene, false);
});

test('research intent aligns with an explicitly named YouTube documentation destination', () => {
  const policy = buildDefaultPolicy('research', 'balanced');
  const result = evaluatePolicyDrift({
    intent: 'research YouTube API documentation',
    url: 'https://m.youtube.com/developers',
    events: [],
    policy,
  });
  assert.equal(result.shouldIntervene, false);
});

test('keyword alignment uses token boundaries', () => {
  const policy = buildDefaultPolicy('coding', 'strict');
  const result = evaluatePolicyDrift({
    intent: 'plan the work',
    url: 'https://example.com/planning',
    events: [],
    policy,
  });
  assert.equal(result.shouldIntervene, false);
  assert.equal(result.reason, 'low_confidence');
  assert.deepEqual(intentTerms('plan the work'), ['plan', 'work']);
  assert.notEqual(classifyIntentCategory('planning').categoryId, 'deep_work');
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

// ── UI exports and migration ──────────────────────────────────────────

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
