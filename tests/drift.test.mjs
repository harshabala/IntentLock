import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateHeuristicDrift } from '../drift.js';

test('known distraction domains exceed the intervention threshold', () => {
  const result = evaluateHeuristicDrift({
    intent: 'Write the project proposal',
    url: 'https://www.youtube.com/watch?v=abc',
    events: [],
    distractionSites: ['youtube.com'],
  });

  assert.equal(result.shouldIntervene, true);
  assert.equal(result.reason, 'known_distraction');
  assert.ok(result.score >= 0.7);
});

test('domains named in the intent are not treated as distractions', () => {
  const result = evaluateHeuristicDrift({
    intent: 'Find the latest YouTube API quota documentation',
    url: 'https://youtube.com/developers',
    events: [],
    distractionSites: ['youtube.com'],
  });

  assert.equal(result.shouldIntervene, false);
});

test('repeated unrelated browsing crosses the intervention threshold', () => {
  const now = Date.now();
  const events = [
    { timestamp: now - 90_000, actionType: 'PAGE_LOAD', url: 'https://news.example.com/a' },
    { timestamp: now - 60_000, actionType: 'PAGE_LOAD', url: 'https://news.example.com/b' },
    { timestamp: now - 30_000, actionType: 'TAB_SWITCH', url: 'https://shop.example.com' },
  ];

  const result = evaluateHeuristicDrift({
    intent: 'Debug the Chrome extension background worker',
    url: 'https://news.example.com/c',
    events,
    distractionSites: [],
    now,
  });

  assert.equal(result.shouldIntervene, true);
  assert.equal(result.reason, 'repeated_unrelated_activity');
});

test('extended dwell on unrelated page crosses intervention threshold', () => {
  const now = Date.now();
  const url = 'https://shop.example.com/products';
  const events = [
    { timestamp: now - 30_000, actionType: 'PAGE_DWELL', url, dwellMs: 130_000 },
  ];

  const result = evaluateHeuristicDrift({
    intent: 'Debug the Chrome extension background worker',
    url,
    events,
    distractionSites: [],
    now,
  });

  assert.equal(result.shouldIntervene, true);
  assert.equal(result.reason, 'extended_unrelated_dwell');
});

test('dwell on distraction domain boosts known distraction detection', () => {
  const now = Date.now();
  const url = 'https://www.youtube.com/watch?v=abc';
  const events = [
    { timestamp: now - 10_000, actionType: 'PAGE_DWELL', url, dwellMs: 70_000 },
  ];

  const result = evaluateHeuristicDrift({
    intent: 'Write the project proposal',
    url,
    events,
    distractionSites: ['youtube.com'],
    now,
  });

  assert.equal(result.shouldIntervene, true);
  assert.equal(result.reason, 'known_distraction');
});

test('stop-word only intent does not trigger false positive intervention on normal sites', () => {
  const now = Date.now();
  const events = [
    { timestamp: now - 90_000, actionType: 'PAGE_LOAD', url: 'https://news.example.com/a' },
    { timestamp: now - 60_000, actionType: 'PAGE_LOAD', url: 'https://news.example.com/b' },
  ];

  const result = evaluateHeuristicDrift({
    intent: 'do my work',
    url: 'https://news.example.com/c',
    events,
    distractionSites: [],
    now,
  });

  assert.equal(result.shouldIntervene, false);
  assert.equal(result.reason, 'empty_terms');
});
