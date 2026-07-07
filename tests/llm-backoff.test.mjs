import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearLlmBackoff,
  isLlmBackedOff,
  parseRetryAfterMs,
  setQuotaBackoff,
  shouldLogQuotaError,
  registerBackoffCallback,
  _resetBackoffCallbackForTest,
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

test('registerBackoffCallback is called when setQuotaBackoff fires', () => {
  _resetBackoffCallbackForTest();
  clearLlmBackoff();
  let received = null;
  registerBackoffCallback((until) => { received = until; });
  const now = 2_000_000;
  setQuotaBackoff({ retryAfterMs: 5000, now });
  assert.ok(received !== null, 'callback should have been called');
  assert.ok(received > now, 'callback should receive a future timestamp');
});

test('_resetBackoffCallbackForTest clears the registered callback', () => {
  _resetBackoffCallbackForTest();
  clearLlmBackoff();
  let called = false;
  registerBackoffCallback(() => { called = true; });
  _resetBackoffCallbackForTest();
  setQuotaBackoff({ retryAfterMs: 1000 });
  assert.equal(called, false, 'callback should not fire after reset');
  clearLlmBackoff();
});