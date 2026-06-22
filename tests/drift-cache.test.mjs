import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDriftCacheKey,
  clearDriftCache,
  DRIFT_CACHE_MAX_ENTRIES,
  DRIFT_CACHE_TTL_MS,
  getCachedDrift,
  getDriftCacheSize,
  setCachedDrift,
} from '../drift-cache.js';

test('buildDriftCacheKey incorporates intent, url, and recent history', () => {
  const key = buildDriftCacheKey('Write report', 'https://example.com', [
    { actionType: 'PAGE_LOAD', url: 'https://a.com' },
    { actionType: 'TAB_SWITCH', url: 'https://b.com' },
  ]);
  assert.match(key, /Write report::https:\/\/example\.com::/);
  assert.match(key, /PAGE_LOAD:https:\/\/a\.com/);
});

test('getCachedDrift returns cached result within TTL', () => {
  clearDriftCache();
  const key = 'intent::url::history';
  const now = 1_000_000;
  setCachedDrift(key, { isAligned: false, confidence: 0.9 }, now);
  const cached = getCachedDrift(key, now + 1_000);
  assert.deepEqual(cached, { isAligned: false, confidence: 0.9, cached: true });
});

test('getCachedDrift misses after TTL expires', () => {
  clearDriftCache();
  const key = 'intent::url::history';
  const now = 1_000_000;
  setCachedDrift(key, { isAligned: false, confidence: 0.9 }, now);
  const cached = getCachedDrift(key, now + DRIFT_CACHE_TTL_MS + 1);
  assert.equal(cached, null);
});

test('setCachedDrift evicts oldest entry when max size exceeded', () => {
  clearDriftCache();
  const now = Date.now();
  for (let i = 0; i < DRIFT_CACHE_MAX_ENTRIES; i += 1) {
    setCachedDrift(`key-${i}`, { isAligned: true, confidence: 1 }, now);
  }
  assert.equal(getDriftCacheSize(), DRIFT_CACHE_MAX_ENTRIES);
  setCachedDrift('key-new', { isAligned: false, confidence: 0.8 }, now);
  assert.equal(getDriftCacheSize(), DRIFT_CACHE_MAX_ENTRIES);
  assert.equal(getCachedDrift('key-0', now), null);
  assert.deepEqual(getCachedDrift('key-new', now), {
    isAligned: false,
    confidence: 0.8,
    cached: true,
  });
});