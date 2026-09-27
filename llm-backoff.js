// llm-backoff.js — Pause LLM calls after quota/rate-limit errors

export const DEFAULT_QUOTA_BACKOFF_MS = 30 * 60 * 1000;
// Unreachable or failing providers pause briefly instead of being retried on
// every navigation; the local lock is unaffected.
export const TRANSIENT_BACKOFF_MS = 60 * 1000;
// A provider hint can shorten or extend a pause, within sane bounds.
export const MIN_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

function boundBackoff(ms) {
  if (!Number.isFinite(ms) || ms < 0) return DEFAULT_QUOTA_BACKOFF_MS;
  return Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, Math.ceil(ms)));
}

let quotaBackoffUntil = 0;
let lastQuotaLogAt = 0;
let _backoffCallback = null;

export function isLlmBackedOff(now = Date.now()) {
  return now < quotaBackoffUntil;
}

export function getQuotaBackoffUntil() {
  return quotaBackoffUntil;
}

export function clearLlmBackoff() {
  quotaBackoffUntil = 0;
  lastQuotaLogAt = 0;
}

// Prefers the HTTP Retry-After header (seconds or HTTP date), then a
// "retry in Ns" body hint; results are bounded.
export function parseRetryAfterMs(bodyText = '', now = Date.now(), retryAfterHeader = null) {
  const header = typeof retryAfterHeader === 'string' ? retryAfterHeader.trim() : '';
  if (/^\d+(?:\.\d+)?$/.test(header)) return boundBackoff(parseFloat(header) * 1000);
  if (header) {
    const date = Date.parse(header);
    if (Number.isFinite(date) && date > now) return boundBackoff(date - now);
  }
  const match = String(bodyText).match(/retry in (\d+(?:\.\d+)?)s/i);
  if (match) {
    return boundBackoff(parseFloat(match[1]) * 1000);
  }
  return DEFAULT_QUOTA_BACKOFF_MS;
}

export function setQuotaBackoff({ retryAfterMs = DEFAULT_QUOTA_BACKOFF_MS, now = Date.now() } = {}) {
  quotaBackoffUntil = Math.max(quotaBackoffUntil, now + boundBackoff(retryAfterMs));
  if (_backoffCallback) _backoffCallback(quotaBackoffUntil);
}

export function shouldLogQuotaError(now = Date.now()) {
  if (lastQuotaLogAt > 0 && now - lastQuotaLogAt < DEFAULT_QUOTA_BACKOFF_MS) {
    return false;
  }
  lastQuotaLogAt = now;
  return true;
}

export function registerBackoffCallback(fn) {
  _backoffCallback = fn;
}

export function _resetBackoffCallbackForTest() {
  _backoffCallback = null;
}