import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearLlmBackoff,
  isLlmBackedOff,
  parseRetryAfterMs,
  setQuotaBackoff,
  shouldLogQuotaError,
} from '../llm-backoff.js';

test('parseRetryAfterMs reads provider retry hints', () => {
  const ms = parseRetryAfterMs('Please retry in 24.205104708s.');
  assert.ok(ms >= 24000 && ms <= 25000);
});

test('setQuotaBackoff pauses LLM calls until retry window ends', () => {
  clearLlmBackoff();
  const now = 1_000_000;
  setQuotaBackoff({ retryAfterMs: 5000, now });
  assert.equal(isLlmBackedOff(now + 1000), true);
  assert.equal(isLlmBackedOff(now + 6000), false);
});

test('shouldLogQuotaError dedupes repeated quota logs', () => {
  clearLlmBackoff();
  const now = 1_000_000;
  assert.equal(shouldLogQuotaError(now), true);
  assert.equal(shouldLogQuotaError(now + 1000), false);
});