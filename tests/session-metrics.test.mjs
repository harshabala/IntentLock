import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVATION_EVENT,
  ACTIVATION_MIN_SESSION_MS,
  PRIVACY_COPY,
  applyDwellDelta,
  computeOnIntentRatio,
  createSessionMetrics,
  formatWeekExport,
  qualifiesForActivation,
  isActivated,
  summarizeWeek,
  topDomains,
  MAX_DOMAIN_ENTRIES,
} from '../session-metrics.js';

test('ACTIVATION_EVENT is stable named constant', () => {
  assert.equal(ACTIVATION_EVENT, 'session_report_viewed_after_10_min_session');
  assert.equal(ACTIVATION_MIN_SESSION_MS, 600_000);
});

test('qualifiesForActivation boundary at 10 minutes', () => {
  const base = { startTime: 0, endTime: ACTIVATION_MIN_SESSION_MS - 1, reportViewed: true };
  assert.equal(qualifiesForActivation(base), false);
  assert.equal(
    qualifiesForActivation({ ...base, endTime: ACTIVATION_MIN_SESSION_MS, reportViewed: true }),
    true
  );
  assert.equal(
    qualifiesForActivation({ ...base, endTime: ACTIVATION_MIN_SESSION_MS, reportViewed: false }),
    false
  );
});

test('isActivated', () => {
  assert.equal(isActivated(null), false);
  assert.equal(isActivated({}), false);
  assert.equal(isActivated({ activatedAt: 1 }), true);
});

test('computeOnIntentRatio null when no activity', () => {
  assert.equal(computeOnIntentRatio(createSessionMetrics()), null);
  assert.equal(computeOnIntentRatio({ activeMs: 0, alignedActiveMs: 0 }), null);
});

test('computeOnIntentRatio math', () => {
  assert.equal(computeOnIntentRatio({ activeMs: 100, alignedActiveMs: 50 }), 0.5);
  assert.equal(computeOnIntentRatio({ activeMs: 100, alignedActiveMs: 100 }), 1);
});

test('applyDwellDelta accumulates aligned and drift', () => {
  let m = createSessionMetrics();
  m = applyDwellDelta(m, { hostname: 'github.com', deltaMs: 1000, aligned: true });
  m = applyDwellDelta(m, { hostname: 'youtube.com', deltaMs: 3000, aligned: false });
  assert.equal(m.activeMs, 4000);
  assert.equal(m.alignedActiveMs, 1000);
  assert.equal(computeOnIntentRatio(m), 0.25);
  assert.equal(m.domains['github.com'].alignedMs, 1000);
  assert.equal(m.domains['youtube.com'].activeMs, 3000);
});

test('domain cap drops smallest hosts', () => {
  let m = createSessionMetrics();
  for (let i = 0; i < MAX_DOMAIN_ENTRIES + 5; i++) {
    m = applyDwellDelta(m, {
      hostname: `site${i}.example`,
      deltaMs: i + 1,
      aligned: false,
    });
  }
  assert.ok(Object.keys(m.domains).length <= MAX_DOMAIN_ENTRIES);
});

test('topDomains sorts by active time', () => {
  let m = createSessionMetrics();
  m = applyDwellDelta(m, { hostname: 'a.com', deltaMs: 100, aligned: true });
  m = applyDwellDelta(m, { hostname: 'b.com', deltaMs: 500, aligned: false });
  const top = topDomains(m, 2);
  assert.equal(top[0].hostname, 'b.com');
  assert.equal(top[1].hostname, 'a.com');
});

test('summarizeWeek empty', () => {
  const s = summarizeWeek([], 1_000_000);
  assert.equal(s.sessionCount, 0);
  assert.equal(s.avgOnIntentRatio, null);
  assert.equal(s.bestDay, null);
});

test('summarizeWeek averages ratios and finds best day', () => {
  const now = Date.now();
  const history = [
    { endTime: now - 1000, onIntentRatio: 0.8, activeMs: 1000 },
    { endTime: now - 2000, onIntentRatio: 0.4, activeMs: 2000 },
    { endTime: now - 3000, onIntentRatio: null, activeMs: 500 },
  ];
  const s = summarizeWeek(history, now);
  assert.equal(s.sessionCount, 3);
  assert.ok(Math.abs(s.avgOnIntentRatio - 0.6) < 1e-9);
  assert.ok(s.bestDay);
  assert.equal(s.totalActiveMs, 3500);
});

test('formatWeekExport includes privacy line', () => {
  const text = formatWeekExport({ sessionCount: 2, avgOnIntentRatio: 0.5, bestDay: 'Mon', totalActiveMs: 120000 });
  assert.match(text, /Sessions: 2/);
  assert.match(text, /50%/);
  assert.match(text, new RegExp(PRIVACY_COPY));
});
