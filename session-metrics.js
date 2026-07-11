// session-metrics.js — Local-only session health metrics for IntentLock
// Nothing here leaves the device; these are pure helpers used by background + UI.

/** The ONE activation event for IntentLock (spec IL-1). */
export const ACTIVATION_EVENT = 'session_report_viewed_after_10_min_session';
export const ACTIVATION_MIN_SESSION_MS = 10 * 60 * 1000;
export const MAX_DOMAIN_ENTRIES = 50;

export const PRIVACY_COPY = 'Stored only on this device. Never uploaded.';
export const ON_INTENT_METHOD_COPY =
  "On-intent % is time on sites that matched your intent policy vs total active browsing in this session. " +
  "It is an estimate from active-tab time — heuristics don't need an API key.";

export function createSessionMetrics() {
  return {
    activeMs: 0,
    alignedActiveMs: 0,
    interventionCount: 0,
    overrideCount: 0,
    domains: {},
  };
}

export function ensureMetrics(session) {
  if (!session || typeof session !== 'object') return createSessionMetrics();
  if (!session.metrics || typeof session.metrics !== 'object') {
    session.metrics = createSessionMetrics();
  }
  if (typeof session.metrics.activeMs !== 'number') session.metrics.activeMs = 0;
  if (typeof session.metrics.alignedActiveMs !== 'number') session.metrics.alignedActiveMs = 0;
  if (typeof session.metrics.interventionCount !== 'number') session.metrics.interventionCount = 0;
  if (typeof session.metrics.overrideCount !== 'number') session.metrics.overrideCount = 0;
  if (!session.metrics.domains || typeof session.metrics.domains !== 'object') {
    session.metrics.domains = {};
  }
  return session.metrics;
}

/**
 * @param {object} metrics
 * @param {{ hostname: string, deltaMs: number, aligned: boolean }} delta
 * @returns {object} new metrics object (immutable-ish)
 */
export function applyDwellDelta(metrics, { hostname, deltaMs, aligned }) {
  const base = metrics && typeof metrics === 'object' ? metrics : createSessionMetrics();
  const ms = Math.max(0, Number(deltaMs) || 0);
  if (ms <= 0 || !hostname) {
    return {
      activeMs: base.activeMs || 0,
      alignedActiveMs: base.alignedActiveMs || 0,
      interventionCount: base.interventionCount || 0,
      overrideCount: base.overrideCount || 0,
      domains: { ...(base.domains || {}) },
    };
  }

  const next = {
    activeMs: (base.activeMs || 0) + ms,
    alignedActiveMs: (base.alignedActiveMs || 0) + (aligned ? ms : 0),
    interventionCount: base.interventionCount || 0,
    overrideCount: base.overrideCount || 0,
    domains: { ...(base.domains || {}) },
  };

  const key = String(hostname).replace(/^www\./, '').toLowerCase();
  const prev = next.domains[key] || { activeMs: 0, alignedMs: 0 };
  next.domains[key] = {
    activeMs: prev.activeMs + ms,
    alignedMs: prev.alignedMs + (aligned ? ms : 0),
  };

  return capDomains(next);
}

function capDomains(metrics) {
  const entries = Object.entries(metrics.domains || {});
  if (entries.length <= MAX_DOMAIN_ENTRIES) return metrics;
  entries.sort((a, b) => (a[1].activeMs || 0) - (b[1].activeMs || 0));
  const drop = entries.length - MAX_DOMAIN_ENTRIES;
  const nextDomains = { ...metrics.domains };
  for (let i = 0; i < drop; i++) {
    delete nextDomains[entries[i][0]];
  }
  return { ...metrics, domains: nextDomains };
}

/** @returns {number|null} ratio 0–1, or null if no active time */
export function computeOnIntentRatio(metrics) {
  const active = metrics?.activeMs || 0;
  if (active <= 0) return null;
  const aligned = metrics?.alignedActiveMs || 0;
  return Math.min(1, Math.max(0, aligned / active));
}

export function topDomains(metrics, n = 5) {
  const entries = Object.entries(metrics?.domains || {});
  return entries
    .map(([hostname, v]) => ({
      hostname,
      activeMs: v.activeMs || 0,
      aligned: (v.alignedMs || 0) >= (v.activeMs || 0) * 0.5 && (v.activeMs || 0) > 0
        ? true
        : (v.alignedMs || 0) > 0 && (v.alignedMs || 0) === (v.activeMs || 0),
      alignedMs: v.alignedMs || 0,
    }))
    .map((row) => ({
      hostname: row.hostname,
      activeMs: row.activeMs,
      aligned: row.alignedMs > 0 && row.alignedMs >= row.activeMs * 0.5,
    }))
    .sort((a, b) => b.activeMs - a.activeMs)
    .slice(0, n);
}

export function qualifiesForActivation(historyEntry) {
  if (!historyEntry || typeof historyEntry !== 'object') return false;
  const start = historyEntry.startTime || 0;
  const end = historyEntry.endTime || 0;
  const duration = end - start;
  return duration >= ACTIVATION_MIN_SESSION_MS && historyEntry.reportViewed === true;
}

export function isActivated(activationState) {
  return Boolean(activationState?.activatedAt);
}

export function summarizeWeek(sessionHistory, now = Date.now()) {
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const cutoff = now - weekMs;
  const sessions = (Array.isArray(sessionHistory) ? sessionHistory : []).filter(
    (s) => (s.endTime || s.startTime || 0) >= cutoff
  );

  const ratios = sessions
    .map((s) => (typeof s.onIntentRatio === 'number' ? s.onIntentRatio : null))
    .filter((r) => r != null);

  const avgOnIntentRatio =
    ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null;

  const byDay = {};
  for (const s of sessions) {
    const t = s.endTime || s.startTime || now;
    const day = new Date(t).toLocaleDateString('en-US', { weekday: 'short' });
    if (!byDay[day]) byDay[day] = { count: 0, ratioSum: 0, ratioN: 0 };
    byDay[day].count += 1;
    if (typeof s.onIntentRatio === 'number') {
      byDay[day].ratioSum += s.onIntentRatio;
      byDay[day].ratioN += 1;
    }
  }

  let bestDay = null;
  let bestScore = -1;
  for (const [day, v] of Object.entries(byDay)) {
    const score = v.ratioN > 0 ? v.ratioSum / v.ratioN : v.count * 0.01;
    if (score > bestScore) {
      bestScore = score;
      bestDay = day;
    }
  }

  const totalActiveMs = sessions.reduce((sum, s) => sum + (s.activeMs || 0), 0);

  return {
    sessionCount: sessions.length,
    avgOnIntentRatio,
    bestDay,
    totalActiveMs,
  };
}

export function formatWeekExport(summary, now = Date.now()) {
  const s = summary || summarizeWeek([], now);
  const avg =
    s.avgOnIntentRatio == null ? '—' : `${Math.round(s.avgOnIntentRatio * 100)}%`;
  const date = new Date(now).toISOString().slice(0, 10);
  return [
    `IntentLock — week summary (${date})`,
    `Sessions: ${s.sessionCount}`,
    `Average on-intent: ${avg}`,
    `Best day: ${s.bestDay || '—'}`,
    `Active browsing: ${Math.round((s.totalActiveMs || 0) / 60000)} min`,
    PRIVACY_COPY,
  ].join('\n');
}
