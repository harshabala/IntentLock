// llm-backoff.js — Pause LLM calls after quota/rate-limit errors

export const DEFAULT_QUOTA_BACKOFF_MS = 30 * 60 * 1000;

let quotaBackoffUntil = 0;
let lastQuotaLogAt = 0;

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

export function parseRetryAfterMs(bodyText = '', now = Date.now()) {
  const match = String(bodyText).match(/retry in ([\d.]+)s/i);
  if (match) {
    return Math.ceil(parseFloat(match[1]) * 1000);
  }
  return DEFAULT_QUOTA_BACKOFF_MS;
}

export function setQuotaBackoff({ retryAfterMs = DEFAULT_QUOTA_BACKOFF_MS, now = Date.now() } = {}) {
  quotaBackoffUntil = Math.max(quotaBackoffUntil, now + retryAfterMs);
}

export function shouldLogQuotaError(now = Date.now()) {
  if (lastQuotaLogAt > 0 && now - lastQuotaLogAt < DEFAULT_QUOTA_BACKOFF_MS) {
    return false;
  }
  lastQuotaLogAt = now;
  return true;
}