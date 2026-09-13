// content.js — Page-level tracking and intervention overlay host

const { createPageTracker } = globalThis.IntentLock.pageTracker;
const { createInterventionOverlay } = globalThis.IntentLock.interventionOverlay;

let pageTracker = null;
let overlay = null;
let trackingActive = false;
let pendingIntervention = null;
let privacyRevision = 0;

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      resolve({ response, error: error ? new Error(error.message) : null });
    });
  });
}

function sendContentEvent(payload) {
  chrome.runtime.sendMessage({
    type: 'CONTENT_EVENT',
    payload,
  }, () => {
    void chrome.runtime.lastError;
  });
}

function ensureTracker() {
  if (pageTracker) return pageTracker;
  pageTracker = createPageTracker({
    onReport: (payload) => sendContentEvent(payload),
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
  const revision = privacyRevision;
  chrome.storage.local.get(['activeSession', 'trackingEnabled', 'privacyMutationState'], (result) => {
    if (revision !== privacyRevision || result.privacyMutationState?.deleting) return;
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
      if (revision !== privacyRevision) return;
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
  const sessionChanged = changes.activeSession && (
    changes.activeSession.oldValue?.id !== changes.activeSession.newValue?.id ||
    changes.activeSession.oldValue?.isActive !== changes.activeSession.newValue?.isActive
  );
  if (changes.privacyMutationState || sessionChanged || changes.trackingEnabled) privacyRevision++;
  if (changes.privacyMutationState?.newValue?.deleting) {
    stopTracking();
    if (overlay) overlay.hide();
    pendingIntervention = null;
    return;
  }
  if (changes.trackingEnabled && changes.trackingEnabled.newValue === false) {
    stopTracking();
    if (overlay) overlay.hide();
    pendingIntervention = null;
  }
  if (changes.trackingEnabled?.newValue === true) {
    const revision = privacyRevision;
    chrome.storage.local.get(['activeSession', 'privacyMutationState'], (result) => {
      if (revision !== privacyRevision || result.privacyMutationState?.deleting) return;
      if (result.activeSession?.isActive) startTracking();
    });
  } else if (changes.activeSession?.newValue?.isActive && changes.trackingEnabled?.newValue !== false) {
    startTracking();
  } else if (changes.activeSession && !changes.activeSession.newValue?.isActive) {
    stopTracking();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'SHOW_INTERVENTION') {
    const revision = privacyRevision;
    chrome.storage.local.get(['activeSession', 'trackingEnabled', 'privacyMutationState'], (result) => {
      if (revision !== privacyRevision || result.privacyMutationState?.deleting) {
        sendResponse({ shown: false, reason: 'data_deleted' });
        return;
      }
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
        intent: message.intent,
        state: pendingIntervention,
      });
      sendResponse({ shown: true });
    });
    return true;
  }

  if (message.type === 'HIDE_INTERVENTION' || message.type === 'DATA_DELETION_STARTED' || message.type === 'DATA_DELETED') {
    privacyRevision++;
    stopTracking();
    if (overlay) overlay.hide();
    pendingIntervention = null;
    sendResponse({ hidden: true });
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
