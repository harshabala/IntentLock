// content.js — Page-level tracking and intervention overlay host

import { createPageTracker } from './page-tracker.js';
import { createInterventionOverlay } from './intervention-overlay.js';

let pageTracker = null;
let overlay = null;
let trackingActive = false;

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

function ensureOverlay() {
  if (!overlay) {
    overlay = createInterventionOverlay({
      onOverride: (reflection) => {
        chrome.runtime.sendMessage({
          type: 'OVERLAY_OVERRIDE',
          payload: {
            reflection,
            url: window.location.href,
            pageTitle: document.title,
          },
        }, () => {
          void chrome.runtime.lastError;
        });
      },
      onDismiss: () => {
        chrome.runtime.sendMessage({ type: 'OVERLAY_DISMISS' }, () => {
          void chrome.runtime.lastError;
        });
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
  chrome.storage.local.get(['activeSession'], (result) => {
    if (result.activeSession?.isActive) {
      startTracking();
    } else {
      stopTracking();
    }
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.activeSession) return;
  if (changes.activeSession.newValue?.isActive) {
    startTracking();
  } else {
    stopTracking();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'SHOW_INTERVENTION') {
    ensureOverlay().show({
      reason: message.reason,
      intent: message.intent,
    });
    sendResponse({ shown: true });
    return true;
  }

  if (message.type === 'HIDE_INTERVENTION') {
    if (overlay) overlay.hide();
    sendResponse({ hidden: true });
    return true;
  }

  if (message.type === 'STOP_TRACKING') {
    stopTracking();
    sendResponse({ status: 'ok' });
    return true;
  }

  return false;
});

syncSessionState();