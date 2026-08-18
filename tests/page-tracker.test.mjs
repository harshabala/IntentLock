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

  assert.equal(reports.length, 3);
  assert.equal(reports[0].reportId, reports[1].reportId);
  assert.notEqual(reports[1].reportId, reports[2].reportId);
  assert.equal(reports[0].dwellDeltaMs, 5_000);
  assert.equal(reports[1].dwellDeltaMs, 5_000);
  assert.equal(reports[2].dwellDeltaMs, 0);
  tracker.stop();
});

test('final flush receipt ids are stable for retries and change for later dwell', async () => {
  installBrowserMocks();
  const reports = [];
  let now = 0;
  let attempts = 0;
  const tracker = createPageTracker({
    onReport: (payload) => {
      reports.push(payload);
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('flush write failed'))
        : Promise.resolve({ response: { status: 'ok', requestId: payload.reportId }, error: null });
    },
    getLocation: () => 'https://example.com/receipt-id',
    isVisible: () => true,
    now: () => now,
  });

  tracker.start();
  now = 5_000;
  await assert.rejects(tracker.flush({
    sessionId: 'receipt-session',
    generation: 1,
    flushCorrelationId: 'flush-1',
  }), /flush write failed/);
  now = 8_000;
  const retried = await tracker.flush({
    sessionId: 'receipt-session',
    generation: 1,
    flushCorrelationId: 'flush-2',
  });

  assert.equal(reports.length, 3);
  assert.equal(reports[0].reportId, reports[1].reportId);
  assert.notEqual(reports[1].reportId, reports[2].reportId);
  assert.equal(reports[0].dwellDeltaMs, 5_000);
  assert.equal(reports[2].dwellDeltaMs, 3_000);
  assert.equal(retried.receiptId, reports[2].reportId);
  tracker.stop();
});

test('periodic reports reconcile a pending final receipt before advancing baseline', async () => {
  installBrowserMocks();
  const reports = [];
  let now = 0;
  let finalAttempts = 0;
  const tracker = createPageTracker({
    onReport: (payload) => {
      reports.push(payload);
      if (payload.flushCorrelationId) {
        finalAttempts += 1;
        if (finalAttempts === 1) return Promise.reject(new Error('one-sided final write'));
      }
      return Promise.resolve();
    },
    getLocation: () => 'https://example.com/periodic-after-final',
    isVisible: () => true,
    now: () => now,
  });

  tracker.start();
  now = 5_000;
  await assert.rejects(tracker.flush({
    sessionId: 'periodic-session',
    generation: 1,
    flushCorrelationId: 'flush-1',
  }), /one-sided final write/);
  now = 8_000;
  await tracker.report('PAGE_DWELL');

  assert.equal(reports.length, 3);
  assert.equal(reports[0].reportId, reports[1].reportId);
  assert.equal(reports[0].dwellDeltaMs, 5_000);
  assert.equal(reports[1].dwellDeltaMs, 5_000);
  assert.equal(reports[2].dwellDeltaMs, 3_000);
  tracker.stop();
});

test('queued periodic reports reconcile a final failure before execution', async () => {
  installBrowserMocks();
  const reports = [];
  let now = 0;
  let finalAttempts = 0;
  const tracker = createPageTracker({
    onReport: (payload) => {
      reports.push(payload);
      if (payload.flushCorrelationId) {
        finalAttempts += 1;
        if (finalAttempts === 1) return Promise.reject(new Error('in-flight final failed'));
        return Promise.resolve({ response: { status: 'ok', requestId: payload.reportId }, error: null });
      }
      return Promise.resolve();
    },
    getLocation: () => 'https://example.com/queued-periodic',
    isVisible: () => true,
    now: () => now,
  });

  tracker.start();
  now = 5_000;
  const final = tracker.flush({
    sessionId: 'queued-session',
    generation: 1,
    flushCorrelationId: 'flush-1',
  });
  now = 6_000;
  const periodic = tracker.report('PAGE_DWELL');

  await assert.rejects(final, /in-flight final failed/);
  await periodic;

  assert.equal(reports.length, 3);
  assert.equal(reports[0].reportId, reports[1].reportId);
  assert.equal(reports[0].dwellDeltaMs, 5_000);
  assert.equal(reports[2].dwellDeltaMs, 1_000);
  tracker.stop();
});

test('repeated final failures preserve SPA navigation and prior-page dwell', async () => {
  installBrowserMocks();
  const reports = [];
  let href = 'https://example.com/old-page';
  let now = 0;
  let finalFailures = 0;
  const tracker = createPageTracker({
    onReport: (payload) => {
      reports.push(payload);
      if (payload.flushCorrelationId) {
        if (finalFailures < 2) {
          finalFailures += 1;
          return Promise.reject(new Error('final persistence failed'));
        }
        return Promise.resolve({
          response: { status: 'ok', requestId: payload.reportId },
          error: null,
        });
      }
      return Promise.resolve({ response: { status: 'ok' }, error: null });
    },
    getLocation: () => href,
    isVisible: () => true,
    now: () => now,
  });

  tracker.start();
  now = 5_000;
  await assert.rejects(tracker.flush({
    sessionId: 'spa-session',
    generation: 1,
    flushCorrelationId: 'flush-1',
  }), /final persistence failed/);

  href = 'https://example.com/new-page';
  pageTrackerRuntime.history.pushState({}, '', '/new-page');
  now = 8_000;
  await tracker.flush({
    sessionId: 'spa-session',
    generation: 1,
    flushCorrelationId: 'flush-2',
  });

  const navigation = reports.find((payload) => payload.actionType === 'SPA_NAVIGATION');
  assert.ok(navigation, 'the navigation report should survive repeated final failures');
  assert.equal(navigation.url, 'https://example.com/old-page');
  assert.equal(navigation.dwellMs, 5_000);

  now = 11_000;
  await tracker.flush({
    sessionId: 'spa-session',
    generation: 1,
    flushCorrelationId: 'flush-3',
  });
  const laterDwell = reports.at(-1);
  assert.equal(laterDwell.url, 'https://example.com/new-page');
  assert.equal(laterDwell.dwellDeltaMs, 3_000);
  tracker.stop();
});

test('failed SPA navigation retries rebase the queued periodic dwell report', async () => {
  installBrowserMocks();
  const reports = [];
  let href = 'https://example.com/old-page';
  let now = 0;
  let navigationAttempts = 0;
  const tracker = createPageTracker({
    onReport: (payload) => {
      reports.push(payload);
      if (payload.actionType === 'SPA_NAVIGATION') {
        navigationAttempts += 1;
        return navigationAttempts === 1
          ? Promise.reject(new Error('navigation persistence failed'))
          : Promise.resolve({ response: { status: 'ok' }, error: null });
      }
      return Promise.resolve({ response: { status: 'ok' }, error: null });
    },
    getLocation: () => href,
    isVisible: () => true,
    now: () => now,
  });

  tracker.start();
  now = 5_000;
  href = 'https://example.com/new-page';
  pageTrackerRuntime.history.pushState({}, '', '/new-page');
  now = 8_000;
  await tracker.report('PAGE_DWELL');

  assert.equal(navigationAttempts, 2);
  assert.equal(reports.length, 3);
  assert.equal(reports[2].actionType, 'PAGE_DWELL');
  assert.equal(reports[2].url, 'https://example.com/new-page');
  assert.equal(reports[2].dwellMs, 3_000);
  assert.equal(reports[2].dwellDeltaMs, 3_000);
  tracker.stop({ discard: true });
});

test('all queued periodic reports rebase after SPA navigation retry', async () => {
  installBrowserMocks();
  const reports = [];
  let href = 'https://example.com/old-page';
  let now = 0;
  let navigationAttempts = 0;
  let periodicReports = 0;
  let resolveFirstPeriodic;
  const tracker = createPageTracker({
    onReport: (payload) => {
      reports.push(payload);
      if (payload.actionType === 'SPA_NAVIGATION') {
        navigationAttempts += 1;
        return navigationAttempts === 1
          ? Promise.reject(new Error('navigation persistence failed'))
          : Promise.resolve({ response: { status: 'ok' }, error: null });
      }
      periodicReports += 1;
      if (periodicReports === 1) {
        return new Promise((resolve) => {
          resolveFirstPeriodic = () => resolve({ response: { status: 'ok' }, error: null });
        });
      }
      return Promise.resolve({ response: { status: 'ok' }, error: null });
    },
    getLocation: () => href,
    isVisible: () => true,
    now: () => now,
  });

  tracker.start();
  now = 5_000;
  href = 'https://example.com/new-page';
  pageTrackerRuntime.history.pushState({}, '', '/new-page');
  now = 8_000;
  const first = tracker.report('PAGE_DWELL');
  const second = tracker.report('PAGE_DWELL');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(typeof resolveFirstPeriodic, 'function');

  now = 9_000;
  resolveFirstPeriodic();
  await first;
  await second;

  assert.equal(navigationAttempts, 2);
  assert.equal(reports.length, 4);
  assert.equal(reports[2].url, 'https://example.com/new-page');
  assert.equal(reports[2].dwellMs, 3_000);
  assert.equal(reports[2].dwellDeltaMs, 3_000);
  assert.equal(reports[3].url, 'https://example.com/new-page');
  assert.equal(reports[3].dwellMs, 4_000);
  assert.equal(reports[3].dwellDeltaMs, 1_000);
  tracker.stop({ discard: true });
});

test('failed SPA navigations queue in order and preserve later dwell', async () => {
  installBrowserMocks();
  const reports = [];
  let href = 'https://example.com/page-one';
  let now = 0;
  const navigationAttempts = new Map();
  const tracker = createPageTracker({
    onReport: (payload) => {
      reports.push(payload);
      if (payload.actionType === 'SPA_NAVIGATION') {
        const attempts = (navigationAttempts.get(payload.navigationUrl) || 0) + 1;
        navigationAttempts.set(payload.navigationUrl, attempts);
        return attempts === 1
          ? Promise.reject(new Error('navigation persistence failed'))
          : Promise.resolve({ response: { status: 'ok' }, error: null });
      }
      return Promise.resolve({ response: { status: 'ok' }, error: null });
    },
    getLocation: () => href,
    isVisible: () => true,
    now: () => now,
  });

  tracker.start();
  now = 5_000;
  href = 'https://example.com/page-two';
  pageTrackerRuntime.history.pushState({}, '', '/page-two');
  now = 6_000;
  href = 'https://example.com/page-three';
  pageTrackerRuntime.history.pushState({}, '', '/page-three');

  now = 8_000;
  await assert.rejects(tracker.report('PAGE_DWELL'), /navigation persistence failed/);
  now = 9_000;
  await tracker.report('PAGE_DWELL');

  const navigationReports = reports.filter((payload) => payload.actionType === 'SPA_NAVIGATION');
  assert.deepEqual(
    Object.fromEntries(navigationAttempts),
    {
      'https://example.com/page-two': 2,
      'https://example.com/page-three': 2,
    },
  );
  assert.deepEqual(
    navigationReports.map((payload) => payload.navigationUrl),
    [
      'https://example.com/page-two',
      'https://example.com/page-two',
      'https://example.com/page-three',
      'https://example.com/page-three',
    ],
  );
  const laterDwell = reports.at(-1);
  assert.equal(laterDwell.actionType, 'PAGE_DWELL');
  assert.equal(laterDwell.url, 'https://example.com/page-three');
  assert.equal(laterDwell.dwellDeltaMs, 1_000);
  tracker.stop({ discard: true });
});

test('final flush waits for an in-flight SPA navigation report', async () => {
  installBrowserMocks();
  const reports = [];
  let href = 'https://example.com/race-old';
  let now = 0;
  let resolveNavigation;
  const navigationPersistence = new Promise((resolve) => {
    resolveNavigation = resolve;
  });
  const tracker = createPageTracker({
    onReport: (payload) => {
      reports.push(payload);
      if (payload.actionType === 'SPA_NAVIGATION') return navigationPersistence;
      return Promise.resolve({ response: { status: 'ok' }, error: null });
    },
    getLocation: () => href,
    isVisible: () => true,
    now: () => now,
  });

  tracker.start();
  now = 5_000;
  href = 'https://example.com/race-new';
  pageTrackerRuntime.history.pushState({}, '', '/race-new');
  const final = tracker.flush({
    sessionId: 'navigation-race-session',
    generation: 1,
    flushCorrelationId: 'navigation-race-flush',
  });
  await Promise.resolve();

  try {
    assert.equal(
      reports.filter((payload) => payload.actionType === 'SPA_NAVIGATION').length,
      1,
    );
  } finally {
    resolveNavigation();
    await final.catch(() => {});
    tracker.stop({ discard: true });
  }
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

test('normal dwell retries reuse the failed report receipt before later dwell', async () => {
  installBrowserMocks();
  const reports = [];
  let now = 0;
  let attempts = 0;
  const tracker = createPageTracker({
    onReport: (payload) => {
      reports.push(payload);
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('normal dwell write failed'))
        : Promise.resolve({ response: { status: 'ok' }, error: null });
    },
    getLocation: () => 'https://example.com/normal-retry',
    isVisible: () => true,
    now: () => now,
  });

  tracker.start();
  now = 5_000;
  await assert.rejects(tracker.report('PAGE_DWELL'), /normal dwell write failed/);
  now = 6_000;
  await tracker.report('PAGE_DWELL');

  assert.equal(reports.length, 3);
  assert.equal(reports[0].reportId, reports[1].reportId);
  assert.notEqual(reports[1].reportId, reports[2].reportId);
  assert.equal(reports[0].dwellDeltaMs, 5_000);
  assert.equal(reports[1].dwellDeltaMs, 5_000);
  assert.equal(reports[2].dwellDeltaMs, 1_000);
  tracker.stop({ discard: true });
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

  assert.equal(reports.length, 3);
  assert.equal(reports[0].reportId, reports[1].reportId);
  assert.notEqual(reports[1].reportId, reports[2].reportId);
  assert.equal(reports[0].dwellDeltaMs, 5_000);
  assert.equal(reports[1].dwellDeltaMs, 5_000);
  assert.equal(reports[2].dwellDeltaMs, 1_000);
  tracker.stop({ discard: true });
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
