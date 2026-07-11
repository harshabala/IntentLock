// page-tracker.js — Per-page dwell time and SPA navigation tracking

export const DWELL_REPORT_INTERVAL_MS = 30_000;

export function accumulateDwell({ activeMs = 0, lastTick, isVisible, now }) {
  if (isVisible && lastTick != null) {
    return {
      activeMs: activeMs + Math.max(0, now - lastTick),
      lastTick: now,
    };
  }
  return { activeMs, lastTick: now };
}

export function shouldReportSpaNavigation(fromUrl, toUrl) {
  if (!fromUrl || !toUrl || fromUrl === toUrl) return false;
  try {
    const from = new URL(fromUrl);
    const to = new URL(toUrl);
    return from.origin === to.origin;
  } catch {
    return false;
  }
}

export function createPageTracker({
  onReport,
  getLocation = () => globalThis.location?.href || '',
  getTitle = () => globalThis.document?.title || '',
  isVisible = () => !globalThis.document?.hidden,
  now = () => Date.now(),
  reportIntervalMs = DWELL_REPORT_INTERVAL_MS,
} = {}) {
  if (typeof onReport !== 'function') {
    throw new Error('createPageTracker requires onReport callback');
  }

  let activeMs = 0;
  let lastTick = now();
  let lastReportedActiveMs = 0;
  let currentUrl = getLocation();
  let intervalId = null;
  let started = false;
  const cleanups = [];

  function snapshot() {
    const state = accumulateDwell({
      activeMs,
      lastTick,
      isVisible: isVisible(),
      now: now(),
    });
    activeMs = state.activeMs;
    lastTick = state.lastTick;
    return {
      url: getLocation(),
      pageTitle: getTitle(),
      dwellMs: activeMs,
    };
  }

  function report(actionType, extra = {}) {
    const data = snapshot();
    const dwellDeltaMs = Math.max(0, data.dwellMs - lastReportedActiveMs);
    lastReportedActiveMs = data.dwellMs;
    onReport({
      actionType,
      url: data.url,
      pageTitle: data.pageTitle,
      dwellMs: data.dwellMs,
      dwellDeltaMs,
      ...extra,
    });
  }

  function resetForUrl(nextUrl) {
    activeMs = 0;
    lastTick = now();
    lastReportedActiveMs = 0;
    currentUrl = nextUrl;
  }

  function handleSpaNavigation(nextUrl) {
    if (!shouldReportSpaNavigation(currentUrl, nextUrl)) return;
    report('SPA_NAVIGATION', { previousUrl: currentUrl });
    resetForUrl(nextUrl);
  }

  function patchHistoryMethod(methodName) {
    const historyRef = globalThis.history;
    if (!historyRef || typeof historyRef[methodName] !== 'function') return;

    const original = historyRef[methodName];
    historyRef[methodName] = function patchedHistoryMethod(...args) {
      const result = original.apply(this, args);
      handleSpaNavigation(getLocation());
      return result;
    };
    cleanups.push(() => {
      historyRef[methodName] = original;
    });
  }

  function onVisibilityChange() {
    const state = accumulateDwell({
      activeMs,
      lastTick,
      isVisible: isVisible(),
      now: now(),
    });
    activeMs = state.activeMs;
    lastTick = state.lastTick;
    if (!isVisible()) {
      report('PAGE_DWELL');
    }
  }

  function onBeforeUnload() {
    report('PAGE_DWELL');
  }

  function onPopState() {
    handleSpaNavigation(getLocation());
  }

  function start() {
    if (started) return;
    started = true;
    currentUrl = getLocation();
    lastTick = now();

    patchHistoryMethod('pushState');
    patchHistoryMethod('replaceState');

    const doc = globalThis.document;
    const win = globalThis.window;
    if (doc?.addEventListener) {
      doc.addEventListener('visibilitychange', onVisibilityChange);
      cleanups.push(() => doc.removeEventListener('visibilitychange', onVisibilityChange));
    }
    if (win?.addEventListener) {
      win.addEventListener('beforeunload', onBeforeUnload);
      win.addEventListener('popstate', onPopState);
      cleanups.push(() => win.removeEventListener('beforeunload', onBeforeUnload));
      cleanups.push(() => win.removeEventListener('popstate', onPopState));
    }

    intervalId = globalThis.setInterval(() => report('PAGE_DWELL'), reportIntervalMs);
    cleanups.push(() => {
      if (intervalId) globalThis.clearInterval(intervalId);
      intervalId = null;
    });
  }

  function stop() {
    if (!started) return;
    report('PAGE_DWELL');
    started = false;
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      cleanup();
    }
  }

  return { start, stop, report, snapshot };
}