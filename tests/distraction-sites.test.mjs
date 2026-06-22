import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_DISTRACTION_SITES,
  getEffectiveDistractionSites,
} from '../distraction-sites.js';

test('getEffectiveDistractionSites falls back when stored list is empty', () => {
  assert.deepEqual(getEffectiveDistractionSites([]), DEFAULT_DISTRACTION_SITES);
  assert.deepEqual(getEffectiveDistractionSites(undefined), DEFAULT_DISTRACTION_SITES);
  assert.deepEqual(getEffectiveDistractionSites(['reddit.com']), ['reddit.com']);
});

test('DEFAULT_DISTRACTION_SITES includes youtube.com', () => {
  assert.ok(DEFAULT_DISTRACTION_SITES.includes('youtube.com'));
});