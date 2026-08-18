// page-tracker.js — Per-page dwell time and SPA navigation tracking

(function exposePageTracker(root) {
  const DWELL_REPORT_INTERVAL_MS = 30_000;

  function accumulateDwell({ activeMs = 0, lastTick, isVisible, now }) {
    if (isVisible && lastTick != null) {
      return {
        activeMs: activeMs + Math.max(0, now - lastTick),
        lastTick: now,
      };
    }
    return { activeMs, lastTick: now };
  }

  function shouldReportSpaNavigation(fromUrl, toUrl) {
    if (!fromUrl || !toUrl || fromUrl === toUrl) return false;
    try {
      const from = new URL(fromUrl);
      const to = new URL(toUrl);
      return from.origin === to.origin;
    } catch {
      return false;
    }
  }

  function createPageTracker({
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
    let pageGeneration = 0;
    let currentUrl = getLocation();
    let intervalId = null;
    let started = false;
    let idle = false;
    let flushPromise = null;
    let reportTail = Promise.resolve();
    let reportQueuePending = false;
    let reportQueueVersion = 0;
    const cleanups = [];

    const isActive = () => isVisible() && !idle;

    function snapshot(urlOverride = null) {
      const state = accumulateDwell({
        activeMs,
        lastTick,
        isVisible: isActive(),
        now: now(),
      });
      activeMs = state.activeMs;
      lastTick = state.lastTick;
      return {
        url: urlOverride || getLocation(),
        pageTitle: getTitle(),
        dwellMs: activeMs,
      };
    }

    function createReportJob(actionType, extra = {}, urlOverride = null) {
      const data = snapshot(urlOverride);
      return {
        data,
        extra,
        actionType,
        reportGeneration: pageGeneration,
      };
    }

    function reportResultError(result) {
      if (!result || typeof result !== 'object') return null;
      if ('error' in result && result.error) {
        return result.error instanceof Error ? result.error : new Error(String(result.error));
      }
      const response = 'response' in result ? result.response : result;
      if ('response' in result && !response) {
        return new Error('Report persistence was not acknowledged.');
      }
      if (response?.status === 'error') {
        return new Error(response.message || 'Report persistence failed.');
      }
      return null;
    }

    function sendReport(job) {
      const dwellDeltaMs = Math.max(0, job.data.dwellMs - lastReportedActiveMs);
      const payload = {
        actionType: job.actionType,
        url: job.data.url,
        pageTitle: job.data.pageTitle,
        dwellMs: job.data.dwellMs,
        dwellDeltaMs,
        ...job.extra,
      };
      const result = onReport(payload);
      const completeReport = (value) => {
        const error = reportResultError(value);
        if (error) throw error;
        if (job.reportGeneration === pageGeneration) {
          lastReportedActiveMs = Math.max(lastReportedActiveMs, job.data.dwellMs);
        }
        return value;
      };
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then(completeReport);
      }
      return completeReport(result);
    }

    function finishReportQueue(version) {
      if (version !== reportQueueVersion) return;
      reportQueuePending = false;
      reportTail = Promise.resolve();
    }

    function report(actionType, extra = {}, urlOverride = null) {
      const job = createReportJob(actionType, extra, urlOverride);
      if (reportQueuePending) {
        const version = ++reportQueueVersion;
        const queued = reportTail.catch(() => {}).then(() => sendReport(job));
        reportTail = queued;
        queued.then(
          () => finishReportQueue(version),
          () => finishReportQueue(version),
        );
        return queued;
      }

      const result = sendReport(job);
      if (result && typeof result.then === 'function') {
        const version = ++reportQueueVersion;
        reportQueuePending = true;
        reportTail = Promise.resolve(result);
        result.then(
          () => finishReportQueue(version),
          () => finishReportQueue(version),
        );
      }
      return result;
    }

    function flush(extra = {}) {
      if (!started) return Promise.resolve({ flushed: false });
      if (flushPromise) return flushPromise;
      try {
        flushPromise = Promise.resolve(report('PAGE_DWELL', extra))
          .then(() => ({ flushed: true }))
          .finally(() => {
            flushPromise = null;
          });
        return flushPromise;
      } catch (error) {
        return Promise.reject(error);
      }
    }

    function resetForUrl(nextUrl) {
      activeMs = 0;
      lastTick = now();
      lastReportedActiveMs = 0;
      pageGeneration += 1;
      currentUrl = nextUrl;
    }

    function handleSpaNavigation(nextUrl) {
      if (!shouldReportSpaNavigation(currentUrl, nextUrl)) return;
      report('SPA_NAVIGATION', { previousUrl: currentUrl, navigationUrl: nextUrl }, currentUrl);
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
      const visible = isVisible();
      if (visible) {
        // A hidden interval is never active time.
        lastTick = now();
        return;
      }
      const state = accumulateDwell({
        activeMs,
        lastTick,
        isVisible: true,
        now: now(),
      });
      activeMs = state.activeMs;
      lastTick = now();
      if (!visible) {
        report('PAGE_DWELL');
      }
    }

    function onBeforeUnload() {
      report('PAGE_DWELL');
    }

    function onPopState() {
      handleSpaNavigation(getLocation());
    }

    function setIdle(nextIdle) {
      const normalized = Boolean(nextIdle);
      if (idle === normalized) return;
      if (normalized) {
        const state = accumulateDwell({
          activeMs,
          lastTick,
          isVisible: isVisible(),
          now: now(),
        });
        activeMs = state.activeMs;
        lastTick = now();
        idle = true;
        report('PAGE_DWELL');
      } else {
        idle = false;
        lastTick = now();
      }
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

    return { start, stop, report, snapshot, setIdle, flush };
  }

  function getNamespace() {
    if (!('IntentLock' in root)) {
      if (!Object.isExtensible(root)) {
        throw new Error('global object must be extensible to create IntentLock');
      }
      Object.defineProperty(root, 'IntentLock', {
        configurable: true,
        enumerable: true,
        value: {},
        writable: true,
      });
    }

    if (root.IntentLock === null || typeof root.IntentLock !== 'object' || Array.isArray(root.IntentLock)) {
      throw new Error('IntentLock global must be an object');
    }
    return root.IntentLock;
  }

  function exposeApi(property, api) {
    const namespace = getNamespace();
    if (property in namespace) {
      throw new Error(`IntentLock.${property} is already defined`);
    }
    if (!Object.isExtensible(namespace)) {
      throw new Error('IntentLock global must be extensible');
    }
    Object.defineProperty(namespace, property, {
      configurable: false,
      enumerable: true,
      value: api,
      writable: false,
    });
  }

  exposeApi('pageTracker', {
    DWELL_REPORT_INTERVAL_MS,
    accumulateDwell,
    shouldReportSpaNavigation,
    createPageTracker,
  });
}(globalThis));
