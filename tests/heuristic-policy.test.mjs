import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INTENT_CATEGORIES,
  classifyIntentCategory,
  SITE_CATEGORIES,
  DOMAIN_TO_CATEGORY,
  getSiteCategory,
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
