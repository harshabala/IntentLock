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
