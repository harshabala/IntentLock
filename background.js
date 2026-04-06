// background.js
import { checkDriftLLM } from './llm.js';

let currentSession = null;
let timeBudgetAlarmName = 'intentlock-budget-alarm';
let trackingEnabled = true;
let customDistractionSites = [
  'twitter.com', 'x.com', 'facebook.com', 'reddit.com',
  'instagram.com', 'youtube.com', 'netflix.com', 'tiktok.com'
];
let sessionTabGroupId = null;

// Idle tracking
let lastIdleTime = 0;
let isCurrentlyIdle = false;
chrome.idle.setDetectionInterval(180); // 3 minutes

chrome.idle.onStateChanged.addListener((newState) => {
  if (newState === 'idle' || newState === 'locked') {
    isCurrentlyIdle = true;
    lastIdleTime = Date.now();
  } else if (newState === 'active') {
    isCurrentlyIdle = false;
  }
});

// ── Keyboard shortcut ──────────────────────────────────────────────────

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-session') {
    if (currentSession && currentSession.isActive) {
      // End the session
      currentSession.isActive = false;
      currentSession.endTime = Date.now();

      chrome.storage.local.get(['sessionHistory'], (histResult) => {
        const history = histResult.sessionHistory || [];
        history.push({
          id: currentSession.id,
          intent: currentSession.intent,
          startTime: currentSession.startTime,
          endTime: currentSession.endTime,
          timeBudget: currentSession.timeBudget,
          driftCount: currentSession.events.filter(e => e.actionType === 'OVERRIDE').length,
          totalEvents: currentSession.events.length,
          events: currentSession.events
        });
        if (history.length > 100) history.shift();

        chrome.storage.local.set({
          activeSession: currentSession,
          sessionHistory: history
        }, () => {
          ungroupTabs();
          currentSession = null;
          chrome.alarms.clear(timeBudgetAlarmName);
        });
      });
    } else {
      // Open new tab to declare intent
      chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html') });
    }
  }
});

// ── Message handling ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SESSION_STARTED') {
    handleSessionStart(message.session);
    sendResponse({ status: 'ok' });
  } else if (message.type === 'OVERRIDE_INTERVENTION') {
    handleOverride(message.sessionData);
    sendResponse({ status: 'ok' });
  } else if (message.type === 'GET_SESSION') {
    sendResponse({ session: currentSession });
  } else if (message.type === 'CONFIG_UPDATED') {
    loadConfig();
    sendResponse({ status: 'ok' });
  } else if (message.type === 'SESSION_CLEARED') {
    ungroupTabs();
    currentSession = null;
    chrome.alarms.clear(timeBudgetAlarmName);
    sendResponse({ status: 'ok' });
  }
  return true;
});

// ── Config loading ─────────────────────────────────────────────────────

function loadConfig() {
  chrome.storage.local.get([
    'activeSession', 'trackingEnabled', 'customDistractionSites'
  ], (result) => {
    if (result.activeSession && result.activeSession.isActive) {
      currentSession = result.activeSession;
      console.log("Restored session from storage:", currentSession);
    }
    if (result.trackingEnabled !== undefined) {
      trackingEnabled = result.trackingEnabled;
    }
    if (result.customDistractionSites) {
      customDistractionSites = result.customDistractionSites;
    }
  });
}
loadConfig();

// ── Session start ──────────────────────────────────────────────────────

function handleSessionStart(session) {
  currentSession = session;

  chrome.alarms.clear(timeBudgetAlarmName);

  if (session.timeBudget) {
    chrome.alarms.create(timeBudgetAlarmName, { delayInMinutes: session.timeBudget });
  }

  // Create tab group for this session
  createTabGroup(session.intent);

  console.log("Session started:", currentSession);
}

// ── Tab context grouping ───────────────────────────────────────────────

async function createTabGroup(intent) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) return;

    const groupId = await chrome.tabs.group({ tabIds: [tabs[0].id] });
    const groupTitle = intent.length > 24 ? intent.slice(0, 24) + '...' : intent;

    await chrome.tabGroups.update(groupId, {
      title: groupTitle,
      collapsed: false,
      color: 'grey'
    });

    sessionTabGroupId = groupId;
  } catch (e) {
    console.warn("Could not create tab group:", e);
  }
}

async function addTabToGroup(tabId) {
  if (!sessionTabGroupId) return;
  try {
    // Verify the group still exists
    await chrome.tabGroups.get(sessionTabGroupId);
    await chrome.tabs.group({ tabIds: [tabId], groupId: sessionTabGroupId });
  } catch (e) {
    // Group may have been closed
    sessionTabGroupId = null;
  }
}

function ungroupTabs() {
  sessionTabGroupId = null;
}

// ── Time budget alarm ──────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === timeBudgetAlarmName && currentSession && currentSession.isActive) {
    console.log("Time budget exceeded!");
    triggerIntervention("Time budget exceeded. Are you still working on your intent?");
  }
});

// ── Tab monitoring ─────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      return;
    }

    if (currentSession && currentSession.isActive) {
      logEvent('PAGE_LOAD', tab.url);
      addTabToGroup(tabId);
      evaluateDrift(tab.url, tabId);
    }
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (!trackingEnabled) return;
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    if (tab && tab.url && currentSession && currentSession.isActive && !tab.url.startsWith('chrome')) {
      logEvent('TAB_SWITCH', tab.url);

      if (!isCurrentlyIdle && lastIdleTime > 0 && (Date.now() - lastIdleTime < 10000)) {
        lastIdleTime = 0;
        triggerIntervention("You were idle and immediately switched context. Are you still aligned?", activeInfo.tabId);
        return;
      }

      evaluateDrift(tab.url, activeInfo.tabId);
    }
  });
});

// ── Event logging ──────────────────────────────────────────────────────

function logEvent(actionType, url) {
  if (!currentSession || !trackingEnabled) return;
  const event = { timestamp: Date.now(), url: url, actionType: actionType };
  currentSession.events.push(event);

  if (currentSession.events.length > 50) {
    currentSession.events.shift();
  }
  chrome.storage.local.set({ activeSession: currentSession });
}

// ── Drift evaluation ───────────────────────────────────────────────────

let lastEvaluatedUrl = null;
let lastEvaluatedTime = 0;
const DRIFT_DEBOUNCE_MS = 5000;

function evaluateDrift(url, tabId) {
  const now = Date.now();
  if (url === lastEvaluatedUrl && (now - lastEvaluatedTime) < DRIFT_DEBOUNCE_MS) {
    return;
  }
  lastEvaluatedUrl = url;
  lastEvaluatedTime = now;

  const intentWords = currentSession.intent.toLowerCase().split(' ').filter(w => w.length > 3);

  let domain;
  try {
    domain = new URL(url).hostname;
  } catch (e) {
    console.warn("Could not parse URL:", url);
    return;
  }

  console.log(`Evaluating drift for ${domain}...`);

  let isDistraction = customDistractionSites.some(site => domain.includes(site));

  // If intent specifically mentions the site, it's not a distraction
  if (isDistraction && intentWords.some(word => domain.includes(word))) {
    isDistraction = false;
  }

  if (isDistraction) {
    triggerIntervention("You seem to be drifting to a known distraction site. Why?", tabId);
    return;
  }

  checkDriftLLM(currentSession.intent, url, currentSession.events).then(result => {
    if (!result.isAligned) {
      triggerIntervention(`The AI has detected drift (Confidence: ${Math.round(result.confidence * 100)}%)`, tabId);
    } else {
      console.log("LLM thinks user is aligned.");
    }
  });
}

// ── Intervention ───────────────────────────────────────────────────────

function triggerIntervention(reason, tabId = null) {
  console.log("TRIGGERING INTERVENTION:", reason);

  const storeAndShow = (originalUrl) => {
    chrome.storage.local.set({
      interventionState: { reason, timestamp: Date.now(), originalTabId: tabId, originalUrl }
    }, () => {
      if (tabId) {
        chrome.tabs.update(tabId, { url: chrome.runtime.getURL('intervention.html') });
      } else {
        chrome.tabs.create({ url: chrome.runtime.getURL('intervention.html') });
      }
    });
  };

  if (tabId) {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        storeAndShow(null);
      } else {
        storeAndShow(tab.url || null);
      }
    });
  } else {
    storeAndShow(null);
  }
}

function handleOverride(sessionData) {
  console.log("User overrode intervention.");
}
