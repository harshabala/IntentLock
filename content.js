// content.js — Page-level tracking and intervention overlay host

const { createPageTracker } = globalThis.IntentLock.pageTracker;
const { createInterventionOverlay } = globalThis.IntentLock.interventionOverlay;

let pageTracker = null;
let overlay = null;
let trackingActive = false;
let pendingIntervention = null;
let lastFlushRequestId = null;
let lastFlushPromise = null;

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
    flushRequestId: requestId,
  }))
    .then(() => ({
      status: 'ok',
      flushed: true,
      persisted: true,
      sessionId,
      generation,
      requestId,
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

function ensureTracker() {
  if (pageTracker) return pageTracker;
  pageTracker = createPageTracker({
    onReport: (payload) => sendContentEvent(payload, Boolean(payload.flushRequestId)),
  });
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

function startTracking() {
  if (trackingActive) return;
  trackingActive = true;
  ensureTracker().start();
}

function stopTracking() {
  if (!trackingActive) return;
  trackingActive = false;
  if (pageTracker) pageTracker.stop();
}

function syncSessionState() {
  chrome.storage.local.get(['activeSession', 'trackingEnabled'], (result) => {
    if (result.activeSession?.isActive && result.trackingEnabled !== false) {
      startTracking();
    } else {
      stopTracking();
    }

    if (result.trackingEnabled === false) {
      if (overlay) overlay.hide();
      pendingIntervention = null;
      return;
    }

    sendRuntimeMessage({ type: 'GET_INTERVENTION_STATE' }).then(({ response }) => {
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
  if (changes.trackingEnabled && changes.trackingEnabled.newValue === false) {
    stopTracking();
    if (overlay) overlay.hide();
    pendingIntervention = null;
    return;
  }
  if (changes.trackingEnabled?.newValue === true || changes.activeSession) {
    syncSessionState();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
