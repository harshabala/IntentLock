import assert from 'node:assert/strict';
import test from 'node:test';
import { loadClassicScript } from './helpers/load-classic-script.mjs';

const pageTrackerRuntime = await loadClassicScript(new URL('../page-tracker.js', import.meta.url));
const {
  accumulateDwell,
  createPageTracker,
  shouldReportSpaNavigation,
} = pageTrackerRuntime.IntentLock.pageTracker;

function installBrowserMocks() {
  const listeners = new Map();
  pageTrackerRuntime.history = {
    pushState() {},
    replaceState() {},
  };
  pageTrackerRuntime.document = {
    hidden: false,
    addEventListener: (type, handler) => {
      listeners.set(`document:${type}`, handler);
    },
    removeEventListener: (type) => {
      listeners.delete(`document:${type}`);
    },
  };
  pageTrackerRuntime.window = {
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
  pageTrackerRuntime.history.pushState({}, '', '/next');

  assert.equal(reports.length, 1);
  assert.equal(reports[0].actionType, 'SPA_NAVIGATION');
  assert.equal(reports[0].previousUrl, 'https://app.example.com/start');
  assert.equal(reports[0].url, 'https://app.example.com/start');
  assert.equal(reports[0].navigationUrl, 'https://app.example.com/next');

  tracker.stop();
});

test('visibility and idle transitions do not count inactive time as dwell', () => {
  const listeners = installBrowserMocks();
  const reports = [];
  let now = 0;
  let hidden = false;
  const tracker = createPageTracker({
    onReport: (payload) => reports.push(payload),
    getLocation: () => 'https://example.com',
    isVisible: () => !hidden,
    now: () => now,
    reportIntervalMs: 60_000,
  });

  tracker.start();
  now = 1000;
  hidden = true;
  listeners.get('document:visibilitychange')();
  now = 11_000;
  hidden = false;
  listeners.get('document:visibilitychange')();
  now = 12_000;
  tracker.report('PAGE_DWELL');
  assert.equal(reports.at(-1).dwellMs, 2000);

  now = 20_000;
  tracker.setIdle(true);
  now = 40_000;
  tracker.setIdle(false);
  now = 41_000;
  tracker.report('PAGE_DWELL');
  assert.equal(reports.at(-1).dwellMs, 11_000);
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

test('repeated dwell snapshots carry only the new dwell delta', () => {
  installBrowserMocks();
  const reports = [];
  let now = 0;
  const tracker = createPageTracker({
    onReport: (payload) => reports.push(payload),
    getLocation: () => 'https://example.com/static',
    isVisible: () => true,
    now: () => now,
    reportIntervalMs: 60_000,
  });

  tracker.start();
  now = 59_000;
  tracker.report('PAGE_DWELL');
  now = 60_000;
  tracker.report('PAGE_DWELL');

  assert.equal(reports[0].dwellMs, 59_000);
  assert.equal(reports[0].dwellDeltaMs, 59_000);
  assert.equal(reports[1].dwellMs, 60_000);
  assert.equal(reports[1].dwellDeltaMs, 1_000);
  tracker.stop();
});

test('flush reports final dwell and is idempotent while persistence is pending', async () => {
  installBrowserMocks();
  const reports = [];
  let now = 0;
  let resolvePersistence;
  const persistence = new Promise((resolve) => { resolvePersistence = resolve; });
  const tracker = createPageTracker({
    onReport: (payload) => {
      reports.push(payload);
      return persistence;
    },
    getLocation: () => 'https://example.com/final',
    isVisible: () => true,
    now: () => now,
  });

  tracker.start();
  now = 7_000;
  const first = tracker.flush();
  const second = tracker.flush();

  assert.strictEqual(first, second);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].dwellDeltaMs, 7_000);
  resolvePersistence();
  assert.equal((await first).flushed, true);
  tracker.stop();
});

test('failed dwell persistence keeps the delta available for a retry', async () => {
  installBrowserMocks();
  const reports = [];
  let now = 0;
  let attempts = 0;
  const tracker = createPageTracker({
    onReport: (payload) => {
      reports.push(payload);
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('persistence failed'))
        : Promise.resolve();
    },
    getLocation: () => 'https://example.com/retry',
    isVisible: () => true,
    now: () => now,
  });

  tracker.start();
  now = 5_000;
  await assert.rejects(tracker.flush(), /persistence failed/);
  await tracker.flush();

  assert.equal(reports.length, 2);
  assert.equal(reports[0].dwellDeltaMs, 5_000);
  assert.equal(reports[1].dwellDeltaMs, 5_000);
  tracker.stop();
});

test('overlapping reports serialize so each active interval is counted once', async () => {
  installBrowserMocks();
  const reports = [];
  let now = 0;
  let resolveFirst;
  const firstPersistence = new Promise((resolve) => { resolveFirst = resolve; });
  const tracker = createPageTracker({
    onReport: (payload) => {
      reports.push(payload);
      return reports.length === 1 ? firstPersistence : Promise.resolve();
    },
    getLocation: () => 'https://example.com/overlap',
    isVisible: () => true,
    now: () => now,
  });

  tracker.start();
  now = 5_000;
  const first = tracker.flush();
  now = 6_000;
  const second = tracker.report('PAGE_DWELL');

  assert.equal(reports.length, 1);
  resolveFirst();
  await first;
  await second;

  assert.equal(reports.length, 2);
  assert.equal(reports[0].dwellDeltaMs, 5_000);
  assert.equal(reports[1].dwellDeltaMs, 1_000);
  tracker.stop();
});

test('normal report write failures reject and leave the full interval for retry', async () => {
  installBrowserMocks();
  const reports = [];
  let now = 0;
  let attempts = 0;
  const tracker = createPageTracker({
    onReport: (payload) => {
      reports.push(payload);
      attempts += 1;
      return attempts === 1
        ? Promise.resolve({
          response: { status: 'error', message: 'normal write failed' },
          error: null,
        })
        : Promise.resolve({ response: { status: 'ok' }, error: null });
    },
    getLocation: () => 'https://example.com/write-failure',
    isVisible: () => true,
    now: () => now,
  });

  tracker.start();
  now = 5_000;
  await assert.rejects(tracker.report('PAGE_DWELL'), /normal write failed/);
  now = 6_000;
  await tracker.report('PAGE_DWELL');

  assert.equal(reports[0].dwellDeltaMs, 5_000);
  assert.equal(reports[1].dwellDeltaMs, 6_000);
  tracker.stop();
});

test('classic page tracker refuses a pre-existing global API property', async () => {
  await assert.rejects(
    loadClassicScript(new URL('../page-tracker.js', import.meta.url), {
      IntentLock: { pageTracker: { occupied: true } },
    }),
    /IntentLock\.pageTracker is already defined/,
  );
  await assert.rejects(
    loadClassicScript(new URL('../page-tracker.js', import.meta.url), {
      IntentLock: 'occupied',
    }),
    /IntentLock global must be an object/,
  );
});
