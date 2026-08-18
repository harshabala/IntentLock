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
    let reportQueueEpoch = 0;
    let reportSequence = 0;
    let pendingFinalFlushJob = null;
    let pendingNormalReportJob = null;
    let pendingNavigationJobs = [];
    let pendingNavigationRetryPromise = null;
    let queuedReportsCanRebase = true;
    const cleanups = [];

    function createReportId() {
      reportSequence += 1;
      return `report-${Date.now().toString(36)}-${reportSequence.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

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
        reportQueueEpoch,
        reportId: createReportId(),
        isFinalFlush: typeof extra?.flushCorrelationId === 'string',
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
      if (job.inFlightPromise) return job.inFlightPromise;
      if (job.reportGeneration !== pageGeneration) {
        return Promise.reject(new Error('Report is stale.'));
      }
      const dwellDeltaMs = Math.max(0, job.data.dwellMs - lastReportedActiveMs);
      const payload = {
        actionType: job.actionType,
        url: job.data.url,
        pageTitle: job.data.pageTitle,
        dwellMs: job.data.dwellMs,
        dwellDeltaMs,
        ...job.extra,
      };
      payload.reportId = job.reportId;
      const handleFailure = (error) => {
        if (job.isFinalFlush) {
          pendingFinalFlushJob = job;
        } else if (job.actionType === 'PAGE_DWELL') {
          pendingNormalReportJob = job;
        }
        throw error;
      };
      const result = onReport(payload);
      const completeReport = (value) => {
        const error = reportResultError(value);
        if (error) throw error;
        if (job.reportGeneration === pageGeneration) {
          lastReportedActiveMs = Math.max(lastReportedActiveMs, job.data.dwellMs);
        }
        if (pendingFinalFlushJob === job) pendingFinalFlushJob = null;
        if (pendingNormalReportJob === job) pendingNormalReportJob = null;
        return value;
      };
      const settleReport = (value) => {
        try {
          return completeReport(value);
        } catch (error) {
          return handleFailure(error);
        }
      };
      if (result && typeof result.then === 'function') {
        const reportPromise = Promise.resolve(result).then(settleReport, handleFailure);
        job.inFlightPromise = reportPromise;
        reportPromise.then(
          () => {
            if (job.inFlightPromise === reportPromise) job.inFlightPromise = null;
          },
          () => {
            if (job.inFlightPromise === reportPromise) job.inFlightPromise = null;
          },
        );
        return reportPromise;
      }
      return settleReport(result);
    }

    function finishReportQueue(version) {
      if (version !== reportQueueVersion) return;
      reportQueuePending = false;
      reportTail = Promise.resolve();
    }

    function completeNavigation(pending) {
      if (pendingNavigationJobs[0] !== pending) return false;
      const projectedActiveMs = accumulateDwell({
        activeMs,
        lastTick,
        isVisible: isActive(),
        now: now(),
      }).activeMs;
      const carriedActiveMs = Math.max(0, projectedActiveMs - pending.job.data.dwellMs);
      pendingNavigationJobs.shift();
      resetForUrl(pending.nextUrl, carriedActiveMs);
      return true;
    }

    function retryPendingNormalReport() {
      if (pendingNormalReportJob && pendingNormalReportJob.reportGeneration !== pageGeneration) {
        pendingNormalReportJob = null;
      }
      return pendingNormalReportJob
        ? Promise.resolve(sendReport(pendingNormalReportJob))
        : Promise.resolve();
    }

    function retryPendingNavigation() {
      if (pendingNavigationRetryPromise) return pendingNavigationRetryPromise;
      let retryPromise;
      retryPromise = (async () => {
        let lastResult;
        let rebased = false;
        while (pendingNavigationJobs.length > 0) {
          const pending = pendingNavigationJobs[0];
          if (!pending.job) {
            pending.job = createReportJob(
              'SPA_NAVIGATION',
              { previousUrl: currentUrl, navigationUrl: pending.nextUrl },
              currentUrl,
            );
          }
          const inFlight = pending.inFlightPromise;
          if (inFlight) {
            pending.inFlightPromise = null;
            try {
              const result = await inFlight;
              await retryPendingNormalReport();
              if (completeNavigation(pending)) {
                lastResult = result;
                rebased = true;
              }
              continue;
            } catch {
              // Retry the exact navigation payload below after its initial write fails.
            }
          }
          await retryPendingNormalReport();
          const result = await sendReport(pending.job);
          if (!completeNavigation(pending)) continue;
          lastResult = result;
          rebased = true;
        }
        return { result: lastResult, rebased };
      })().finally(() => {
        if (pendingNavigationRetryPromise === retryPromise) {
          pendingNavigationRetryPromise = null;
        }
      });
      pendingNavigationRetryPromise = retryPromise;
      return retryPromise;
    }

    function rebaseQueuedReport(job) {
      if (job.reportGeneration === pageGeneration) return job;
      if (
        !started ||
        !queuedReportsCanRebase ||
        job.reportQueueEpoch !== reportQueueEpoch
      ) return null;
      return createReportJob(job.actionType, job.extra);
    }

    function sendQueuedReport(job) {
      if (pendingFinalFlushJob && pendingFinalFlushJob.reportGeneration !== pageGeneration) {
        pendingFinalFlushJob = null;
      }
      let prerequisite = null;
      if (job.isFinalFlush) {
        if (pendingNormalReportJob && pendingNormalReportJob !== job) {
          prerequisite = Promise.resolve(sendReport(pendingNormalReportJob));
        }
        return prerequisite ? prerequisite.then(() => sendReport(job)) : sendReport(job);
      }
      if (pendingNormalReportJob && pendingNormalReportJob.reportGeneration !== pageGeneration) {
        pendingNormalReportJob = null;
      }
      if (pendingFinalFlushJob) {
        prerequisite = Promise.resolve(sendReport(pendingFinalFlushJob));
      }
      if (pendingNormalReportJob && pendingNormalReportJob !== job) {
        prerequisite = (prerequisite || Promise.resolve()).then(() => sendReport(pendingNormalReportJob));
      }
      if (pendingNavigationJobs.length > 0 && pendingNavigationJobs[0].job !== job) {
        prerequisite = (prerequisite || Promise.resolve()).then(() => retryPendingNavigation())
          .then(({ result }) => result);
      }
      const sendCurrentJob = () => {
        return sendReport(rebaseQueuedReport(job) || job);
      };
      return prerequisite ? prerequisite.then(sendCurrentJob) : sendCurrentJob();
    }

    function enqueueReportJob(job) {
      if (reportQueuePending) {
        const version = ++reportQueueVersion;
        const queued = reportTail.catch(() => {}).then(() => sendQueuedReport(job));
        reportTail = queued;
        queued.then(
          () => finishReportQueue(version),
          () => finishReportQueue(version),
        );
        return queued;
      }

      const result = sendQueuedReport(job);
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

    function report(actionType, extra = {}, urlOverride = null, jobOverride = null) {
      const job = jobOverride || createReportJob(actionType, extra, urlOverride);
      if (jobOverride) return enqueueReportJob(job);
      if (pendingFinalFlushJob && pendingFinalFlushJob.reportGeneration !== pageGeneration) {
        pendingFinalFlushJob = null;
      }
      return enqueueReportJob(job);
    }

    function flush(extra = {}) {
      if (!started) return Promise.resolve({ flushed: false });
      if (flushPromise) return flushPromise;
      if (
        pendingFinalFlushJob &&
        (
          pendingFinalFlushJob.reportGeneration !== pageGeneration ||
          pendingFinalFlushJob.extra?.sessionId !== extra.sessionId ||
          pendingFinalFlushJob.extra?.generation !== extra.generation
        )
      ) {
        pendingFinalFlushJob = null;
      }
      const retryJob = pendingFinalFlushJob &&
        pendingFinalFlushJob.reportGeneration === pageGeneration &&
        pendingFinalFlushJob.extra?.sessionId === extra.sessionId &&
        pendingFinalFlushJob.extra?.generation === extra.generation
        ? pendingFinalFlushJob
        : null;
      const projectedActiveMs = () => accumulateDwell({
        activeMs,
        lastTick,
        isVisible: isActive(),
        now: now(),
      }).activeMs;
      const reportReceiptId = (result) => result?.response?.requestId || result?.receiptId || null;
      try {
        const retryNavigation = () => retryPendingNavigation().then(({ result }) => result);
        const sendFinal = () => report(
          'PAGE_DWELL',
          retryJob ? retryJob.extra : extra,
          null,
          retryJob,
        );
        const initialReport = retryJob || pendingNavigationJobs.length === 0
          ? sendFinal()
          : Promise.resolve(retryNavigation()).then(sendFinal);
        flushPromise = Promise.resolve(initialReport)
          .then((result) => retryJob
            ? Promise.resolve(retryNavigation()).then(() => result)
            : result)
          .then((result) => {
            const finalResult = {
              flushed: true,
              receiptId: reportReceiptId(result),
            };
            if (!retryJob || projectedActiveMs() <= lastReportedActiveMs) return finalResult;
            return Promise.resolve(report('PAGE_DWELL', extra))
              .then((laterResult) => ({
                ...finalResult,
                receiptId: reportReceiptId(laterResult),
              }));
          })
          .finally(() => {
            flushPromise = null;
          });
        return flushPromise;
      } catch (error) {
        return Promise.reject(error);
      }
    }

    function resetForUrl(nextUrl, carriedActiveMs = 0) {
      activeMs = Math.max(0, carriedActiveMs);
      lastTick = now();
      lastReportedActiveMs = 0;
      pageGeneration += 1;
      pendingNormalReportJob = null;
      queuedReportsCanRebase = true;
      currentUrl = nextUrl;
    }

    function handleSpaNavigation(nextUrl) {
      if (!shouldReportSpaNavigation(currentUrl, nextUrl)) return;
      if (pendingNavigationJobs.length > 0) {
        pendingNavigationJobs.push({ job: null, nextUrl });
        return;
      }
      const job = createReportJob(
        'SPA_NAVIGATION',
        { previousUrl: currentUrl, navigationUrl: nextUrl },
        currentUrl,
      );
      const pending = { job, nextUrl };
      pendingNavigationJobs.push(pending);
      const result = enqueueReportJob(job);
      if (result && typeof result.then === 'function') {
        pending.inFlightPromise = result;
      }
      const complete = () => {
        if (completeNavigation(pending) && pendingNavigationJobs.length > 0) {
          void retryPendingNavigation().catch(() => {});
        }
      };
      if (result && typeof result.then === 'function') {
        result.then(complete, () => {});
      } else {
        complete();
      }
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

    function stop({ discard = false } = {}) {
      if (!started) return;
      if (discard) {
        pageGeneration += 1;
        reportQueueEpoch += 1;
        queuedReportsCanRebase = false;
        activeMs = 0;
        lastReportedActiveMs = 0;
        lastTick = now();
        pendingFinalFlushJob = null;
        pendingNormalReportJob = null;
        pendingNavigationJobs = [];
        pendingNavigationRetryPromise = null;
        reportQueueVersion += 1;
        reportQueuePending = false;
        reportTail = Promise.resolve();
        flushPromise = null;
      } else {
        report('PAGE_DWELL');
      }
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
