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
  intentTerms,
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
