// drift-cache.js — In-memory TTL cache for LLM drift check results

export const DRIFT_CACHE_TTL_MS = 60_000;
export const DRIFT_CACHE_MAX_ENTRIES = 100;

const cache = new Map();

export function buildDriftCacheKey(intent, url, history = []) {
  const recent = (Array.isArray(history) ? history : [])
    .slice(-5)
    .map((event) => `${event.actionType || 'unknown'}:${event.url || 'n/a'}`)
    .join('|');
  return `${String(intent || '').trim()}::${String(url || '').trim()}::${recent}`;
}

function pruneExpired(now = Date.now()) {
  for (const [key, entry] of cache.entries()) {
    if (!entry || entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
}

function evictOldestIfNeeded() {
  if (cache.size < DRIFT_CACHE_MAX_ENTRIES) return;
  const oldestKey = cache.keys().next().value;
  if (oldestKey !== undefined) {
    cache.delete(oldestKey);
  }
}

export function getCachedDrift(key, now = Date.now()) {
  pruneExpired(now);
  const entry = cache.get(key);
  if (!entry || entry.expiresAt <= now) {
    if (entry) cache.delete(key);
    return null;
  }
  return { ...entry.result, cached: true };
}

export function setCachedDrift(key, result, now = Date.now()) {
  pruneExpired(now);
  evictOldestIfNeeded();
  cache.set(key, {
    result: {
      isAligned: Boolean(result?.isAligned),
      confidence: typeof result?.confidence === 'number' ? result.confidence : 0,
    },
    expiresAt: now + DRIFT_CACHE_TTL_MS,
  });
}

export function clearDriftCache() {
  cache.clear();
}

export function getDriftCacheSize() {
  pruneExpired();
  return cache.size;
}