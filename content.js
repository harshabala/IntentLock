// content.js
// Placeholder for V2 features (per-page active time tracking, interaction signals).
// Currently the background service worker handles all monitoring via chrome.tabs and chrome.idle.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'STOP_TRACKING') {
    // Future: stop any page-level monitoring
    sendResponse({ status: 'ok' });
  }
});
