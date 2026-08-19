// content.js — Page-level tracking and intervention overlay host

const { createPageTracker } = globalThis.IntentLock.pageTracker;
const { createInterventionOverlay } = globalThis.IntentLock.interventionOverlay;

let pageTracker = null;
let overlay = null;
let trackingActive = false;
let pendingIntervention = null;
let lastFlushRequestId = null;
let lastFlushPromise = null;
let trackerSessionKey = null;
let trackerToken = null;
let dataDeletionInProgress = false;
let activeDeletionGeneration = null;
let trackingSyncEpoch = 0;

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      resolve({ response, error: error ? new Error(error.message) : null });
    });
  });
}

function sendContentEvent(payload, requirePersistence = false) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: 'CONTENT_EVENT',
      payload,
    }, (response) => {
      const error = chrome.runtime.lastError;
      const acknowledgementMatches = response?.sessionId === payload.sessionId &&
        response?.generation === payload.generation &&
        response?.requestId === payload.flushRequestId;
      if (requirePersistence && (
        error ||
        response?.status !== 'ok' ||
        response.persisted !== true ||
        !acknowledgementMatches
      )) {
        reject(error || new Error(response?.message || 'Content event persistence was not acknowledged.'));
        return;
      }
      resolve({ response, error: error ? new Error(error.message) : null });
    });
  });
}

function flushFinalDwell(sessionId, generation, requestId) {
  if (requestId && requestId === lastFlushRequestId && lastFlushPromise) {
    return lastFlushPromise;
  }

  if (!trackingActive || !pageTracker?.flush) {
    return Promise.resolve({
      status: 'error',
      flushed: false,
      persisted: false,
      sessionId,
      generation,
      requestId,
      message: 'Page tracking is not active.',
    });
  }

  const flushPromise = Promise.resolve(pageTracker.flush({
    sessionId,
    generation,
    flushCorrelationId: requestId,
  }))
    .then((result) => ({
      status: 'ok',
      flushed: true,
      persisted: true,
      sessionId,
      generation,
      requestId,
      receiptId: result?.receiptId || null,
    }))
    .catch((error) => ({
      status: 'error',
      flushed: false,
      persisted: false,
      sessionId,
      generation,
      requestId,
      message: error?.message || 'Final dwell persistence failed.',
    }));
  if (requestId) {
    lastFlushRequestId = requestId;
    lastFlushPromise = flushPromise;
    // Only coalesce concurrent flushes. Settled-request deduplication belongs
    // to the background session receipt so later dwell can be reported.
    const clearInFlight = () => {
      if (lastFlushPromise === flushPromise) {
        lastFlushRequestId = null;
        lastFlushPromise = null;
      }
    };
    flushPromise.then(clearInFlight, clearInFlight);
  }
  return flushPromise;
}

function ensureTracker(sessionToken = trackerToken) {
  if (pageTracker) return pageTracker;
  let tracker;
  tracker = createPageTracker({
    onReport: (payload) => {
      if (tracker !== pageTracker || sessionToken !== trackerToken) {
        return Promise.reject(new Error('Tracker session is stale.'));
      }
      const scopedPayload = {
        ...payload,
        ...(sessionToken?.sessionId && !payload.sessionId ? { sessionId: sessionToken.sessionId } : {}),
        ...(Number.isInteger(sessionToken?.generation) && !Number.isInteger(payload.generation)
          ? { generation: sessionToken.generation }
          : {}),
      };
      if (typeof scopedPayload.flushCorrelationId === 'string') {
        const { flushCorrelationId, reportId, ...eventPayload } = scopedPayload;
        return sendContentEvent({
          ...eventPayload,
          flushRequestId: reportId || flushCorrelationId,
        }, true);
      }
      return sendContentEvent(scopedPayload, Boolean(scopedPayload.flushRequestId));
    },
  });
  pageTracker = tracker;
  return pageTracker;
}

function showTransitionError(message) {
  if (overlay) overlay.setError(message);
}

function ensureOverlay() {
  if (!overlay) {
    overlay = createInterventionOverlay({
      onOverride: async ({ reflection, markRelated, state }) => {
        const result = await sendRuntimeMessage({
          type: 'INTERVENTION_TRANSITION',
          transition: 'override',
          sessionId: state?.sessionId,
          nonce: state?.nonce,
          reflection,
          markRelated,
        });
        if (result.response?.ok) {
          pendingIntervention = null;
          overlay.hide();
        } else {
          showTransitionError(result.response?.error || result.error?.message || 'Unable to continue.');
        }
      },
      onCloseTab: async (state) => {
        const result = await sendRuntimeMessage({
          type: 'INTERVENTION_TRANSITION',
          transition: 'close-tab',
          sessionId: state?.sessionId,
          nonce: state?.nonce,
        });
        if (result.response?.ok) {
          pendingIntervention = null;
          overlay.hide();
        } else {
          showTransitionError(result.response?.error || result.error?.message || 'Unable to close this lock.');
        }
      },
      onEndSession: async (state) => {
        const result = await sendRuntimeMessage({
          type: 'INTERVENTION_TRANSITION',
          transition: 'end-session',
          sessionId: state?.sessionId,
          nonce: state?.nonce,
        });
        if (result.response?.ok) {
          pendingIntervention = null;
          overlay.hide();
        } else {
          showTransitionError(result.response?.error || result.error?.message || 'Unable to end the session.');
        }
      },
    });
  }
  return overlay;
}

function getTrackerSessionKey(session) {
  if (!session?.id) return null;
  const generation = Number.isInteger(session.generation) ? session.generation : 'legacy';
  return `${session.id}:${generation}`;
}

function startTracking(session, expectedEpoch = trackingSyncEpoch) {
  if (dataDeletionInProgress || expectedEpoch !== trackingSyncEpoch) return false;
  const nextSessionKey = getTrackerSessionKey(session);
  if (trackingActive && trackerSessionKey === nextSessionKey) return;
  if (pageTracker) stopTracking({ discard: true, reportFinal: false });
  if (dataDeletionInProgress || expectedEpoch !== trackingSyncEpoch) return false;
  trackerSessionKey = nextSessionKey;
  trackerToken = { sessionId: session.id, generation: session.generation };
  trackingActive = true;
  ensureTracker(trackerToken).start();
  return true;
}

function stopTracking({ discard = false, reportFinal = true } = {}) {
  if (!trackingActive && !pageTracker) return;
  const tracker = pageTracker;
  trackingActive = false;
  if (discard) {
    pageTracker = null;
    trackerSessionKey = null;
    trackerToken = null;
    lastFlushRequestId = null;
    lastFlushPromise = null;
  }
  if (tracker) tracker.stop(discard ? { discard: true, reportFinal: false } : { reportFinal });
  if (!discard) {
    pageTracker = null;
    trackerSessionKey = null;
    trackerToken = null;
    lastFlushRequestId = null;
    lastFlushPromise = null;
  }
}

function syncSessionState() {
  if (dataDeletionInProgress) {
    stopTracking({ discard: true, reportFinal: false });
    return;
  }
  const syncEpoch = trackingSyncEpoch;
  chrome.storage.local.get(['activeSession', 'trackingEnabled'], (result) => {
    if (dataDeletionInProgress || syncEpoch !== trackingSyncEpoch) {
      stopTracking({ discard: true, reportFinal: false });
      return;
    }
    if (result.activeSession?.isActive && result.trackingEnabled !== false) {
      startTracking(result.activeSession, syncEpoch);
    } else {
      stopTracking({ discard: true, reportFinal: false });
    }

    if (result.trackingEnabled === false) {
      if (overlay) overlay.hide();
      pendingIntervention = null;
      return;
    }

    sendRuntimeMessage({ type: 'GET_INTERVENTION_STATE' }).then(({ response }) => {
      if (dataDeletionInProgress || syncEpoch !== trackingSyncEpoch) return;
      if (response?.ok && response.state) {
        pendingIntervention = response.state;
        ensureOverlay().show({
          reason: response.state.reason,
          intent: response.state.intent || '',
          state: response.state,
        });
      }
    });
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (dataDeletionInProgress) return;
  if (changes.trackingEnabled && changes.trackingEnabled.newValue === false) {
    trackingSyncEpoch += 1;
    stopTracking({ discard: true, reportFinal: false });
    if (overlay) overlay.hide();
    pendingIntervention = null;
    return;
  }
  if (changes.trackingEnabled?.newValue === true || changes.activeSession) {
    syncSessionState();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'DATA_DELETION_STARTED') {
    const generation = Number.isInteger(message.generation) ? message.generation : null;
    if (generation === null && activeDeletionGeneration !== null) {
      sendResponse?.({ status: 'ignored' });
      return true;
    }
    if (generation !== null && activeDeletionGeneration !== null && generation < activeDeletionGeneration) {
      sendResponse?.({ status: 'ignored' });
      return true;
    }
    trackingSyncEpoch += 1;
    dataDeletionInProgress = true;
    activeDeletionGeneration = generation;
    stopTracking({ discard: true, reportFinal: false });
    if (overlay) overlay.hide();
    pendingIntervention = null;
    sendResponse?.({ status: 'ok' });
    return true;
  }

  if (message.type === 'DATA_DELETED' || message.type === 'DATA_DELETION_FAILED') {
    const generation = Number.isInteger(message.generation) ? message.generation : null;
    if (
      (generation !== null && activeDeletionGeneration !== generation)
      || (generation === null && activeDeletionGeneration !== null)
      || (generation !== null && activeDeletionGeneration === null)
    ) {
      sendResponse?.({ status: 'ignored' });
      return true;
    }
    trackingSyncEpoch += 1;
    dataDeletionInProgress = false;
    activeDeletionGeneration = null;
    stopTracking({ discard: true, reportFinal: false });
    if (message.type === 'DATA_DELETED' && overlay) overlay.hide();
    pendingIntervention = null;
    if (message.type === 'DATA_DELETION_FAILED') syncSessionState();
    sendResponse?.({ status: 'ok' });
    return true;
  }

  if (message.type === 'SHOW_INTERVENTION') {
    chrome.storage.local.get(['activeSession', 'trackingEnabled'], (result) => {
      if (result.trackingEnabled === false || !result.activeSession?.isActive) {
        sendResponse({ shown: false, reason: 'tracking_disabled' });
        return;
      }
      pendingIntervention = message.state || pendingIntervention || {
        sessionId: message.sessionId,
        nonce: message.nonce,
        reason: message.reason,
      };
      ensureOverlay().show({
        reason: message.reason,
        intent: message.intent ?? pendingIntervention.intent ?? '',
        state: pendingIntervention,
      });
      sendResponse({ shown: true });
    });
    return true;
  }

  if (message.type === 'HIDE_INTERVENTION') {
    if (overlay) overlay.hide();
    pendingIntervention = null;
    sendResponse({ hidden: true });
    return true;
  }

  if (message.type === 'FLUSH_DWELL') {
    flushFinalDwell(message.sessionId, message.generation, message.requestId).then(sendResponse, () => {
      sendResponse({
        status: 'error',
        flushed: false,
        persisted: false,
        sessionId: message.sessionId,
        generation: message.generation,
        requestId: message.requestId,
      });
    });
    return true;
  }

  if (message.type === 'STOP_TRACKING') {
    stopTracking();
    sendResponse({ status: 'ok' });
    return true;
  }

  if (message.type === 'IDLE_STATE') {
    if (pageTracker) pageTracker.setIdle(Boolean(message.idle));
    sendResponse({ status: 'ok' });
    return true;
  }

  return false;
});

syncSessionState();
