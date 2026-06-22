import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accumulateDwell,
  createPageTracker,
  shouldReportSpaNavigation,
} from '../page-tracker.js';

function installBrowserMocks() {
  const listeners = new Map();
  globalThis.history = {
    pushState() {},
    replaceState() {},
  };
  globalThis.document = {
    hidden: false,
    addEventListener: (type, handler) => {
      listeners.set(`document:${type}`, handler);
    },
    removeEventListener: (type) => {
      listeners.delete(`document:${type}`);
    },
  };
  globalThis.window = {
    addEventListener: (type, handler) => {
      listeners.set(`window:${type}`, handler);
    },
    removeEventListener: (type) => {
      listeners.delete(`window:${type}`);
    },
  };
  return listeners;
}

test('accumulateDwell adds elapsed time only while visible', () => {
  const first = accumulateDwell({ activeMs: 0, lastTick: 1000, isVisible: true, now: 4000 });
  assert.equal(first.activeMs, 3000);
  const second = accumulateDwell({ ...first, isVisible: false, now: 9000 });
  assert.equal(second.activeMs, 3000);
});

test('shouldReportSpaNavigation detects same-origin URL changes', () => {
  assert.equal(
    shouldReportSpaNavigation('https://app.example.com/a', 'https://app.example.com/b'),
    true,
  );
  assert.equal(
    shouldReportSpaNavigation('https://app.example.com/a', 'https://app.example.com/a'),
    false,
  );
  assert.equal(
    shouldReportSpaNavigation('https://app.example.com/a', 'https://other.example.com/a'),
    false,
  );
});

test('createPageTracker reports SPA navigation via history patch', () => {
  installBrowserMocks();
  const reports = [];
  let href = 'https://app.example.com/start';
  const tracker = createPageTracker({
    onReport: (payload) => reports.push(payload),
    getLocation: () => href,
    getTitle: () => 'App',
    isVisible: () => true,
    now: () => 10_000,
    reportIntervalMs: 60_000,
  });

  tracker.start();
  href = 'https://app.example.com/next';
  history.pushState({}, '', '/next');

  assert.equal(reports.length, 1);
  assert.equal(reports[0].actionType, 'SPA_NAVIGATION');
  assert.equal(reports[0].previousUrl, 'https://app.example.com/start');
  assert.equal(reports[0].url, 'https://app.example.com/next');

  tracker.stop();
});

test('createPageTracker reports dwell snapshots', () => {
  installBrowserMocks();
  const reports = [];
  let now = 0;
  const tracker = createPageTracker({
    onReport: (payload) => reports.push(payload),
    getLocation: () => 'https://example.com',
    getTitle: () => 'Example',
    isVisible: () => true,
    now: () => now,
    reportIntervalMs: 1000,
  });

  tracker.start();
  now = 2500;
  tracker.report('PAGE_DWELL');

  assert.equal(reports.length, 1);
  assert.equal(reports[0].actionType, 'PAGE_DWELL');
  assert.equal(reports[0].dwellMs, 2500);

  tracker.stop();
  assert.ok(reports.length >= 2);
});