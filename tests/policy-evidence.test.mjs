import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDefaultPolicy, evaluatePolicyDrift, DWELL_UNALIGNED_MS } from '../heuristic-policy.js';

const intent = 'write the quarterly budget memo';
const policy = buildDefaultPolicy('coding', 'balanced');
const url = 'https://unknown-site.example/article';
const now = 1_000_000;

// page-tracker reports cumulative dwellMs every 30 s with a 30 s dwellDeltaMs.
function dwellReports(count) {
  return Array.from({ length: count }, (_, i) => ({
    actionType: 'PAGE_DWELL', url,
    timestamp: now - (count - 1 - i) * 30_000,
    dwellMs: (i + 1) * 30_000,
    dwellDeltaMs: 30_000,
  }));
}

test('cumulative dwell reports count each active second once', () => {
  const three = evaluatePolicyDrift({ intent, url, policy, now, events: dwellReports(3) });
  assert.equal(three.shouldIntervene, false, JSON.stringify(three));
  assert.ok(three.signals.includes('dwell:90s'), JSON.stringify(three.signals));
  const four = evaluatePolicyDrift({ intent, url, policy, now, events: dwellReports(4) });
  assert.equal(four.shouldIntervene, true, JSON.stringify(four));
  assert.equal(four.reason, 'extended_unrelated_dwell');
  assert.equal(DWELL_UNALIGNED_MS, 120_000);
});

test('legacy dwell events without deltas use their largest cumulative value', () => {
  const events = dwellReports(3).map(({ dwellDeltaMs, ...event }) => event);
  const result = evaluatePolicyDrift({ intent, url, policy, now, events });
  assert.equal(result.shouldIntervene, false, JSON.stringify(result));
  assert.ok(result.signals.includes('dwell:90s'));
});

test('future-dated, malformed and null evidence is ignored', () => {
  const events = [
    null, 'bad', { actionType: 'PAGE_DWELL', url, dwellMs: 999_999 },
    { actionType: 'PAGE_DWELL', url, timestamp: now + 60_000, dwellMs: 200_000, dwellDeltaMs: 200_000 },
    { actionType: 'PAGE_DWELL', url, timestamp: 'yesterday', dwellMs: 200_000, dwellDeltaMs: 200_000 },
    { actionType: 'PAGE_DWELL', url, timestamp: now, dwellMs: 30_000, dwellDeltaMs: -500_000 },
  ];
  const result = evaluatePolicyDrift({ intent, url, policy, now, events });
  assert.equal(result.shouldIntervene, false, JSON.stringify(result));
  for (const bad of [null, undefined, 'events', { length: 3 }]) {
    assert.doesNotThrow(() => evaluatePolicyDrift({ intent, url, policy, now, events: bad }));
  }
});

test('explicit allow stays permitted after two minutes of dwell', () => {
  const allowPolicy = { ...policy, customAllowDomains: ['unknown-site.example'] };
  const result = evaluatePolicyDrift({ intent, url, policy: allowPolicy, now, events: dwellReports(6) });
  assert.equal(result.shouldIntervene, false, JSON.stringify(result));
  assert.equal(result.reason, 'explicit_allow');
  assert.equal(result.explicit, true);
});

test('related correction covers host and descendants but not parent or sibling', () => {
  const related = ['docs.unknown-site.example'];
  const events = [];
  const child = evaluatePolicyDrift({ intent, policy, now, events, relatedHostnames: related,
    url: 'https://api.docs.unknown-site.example/page' });
  assert.equal(child.reason, 'related_correction');
  assert.equal(child.explicit, true);
  for (const other of ['https://unknown-site.example/', 'https://blog.unknown-site.example/',
    'https://docs.unknown-site.example.evil.test/']) {
    const result = evaluatePolicyDrift({ intent, policy, now, events, relatedHostnames: related, url: other });
    assert.notEqual(result.reason, 'related_correction', other);
    assert.notEqual(result.explicit, true, other);
  }
});

test('inferred category allow is not treated as an explicit permission', () => {
  const result = evaluatePolicyDrift({ intent, policy, now, events: [],
    url: 'https://docs.google.com/document/d/example' });
  assert.notEqual(result.explicit, true);
});
