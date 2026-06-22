// background.js
import { evaluateHeuristicDrift, DRIFT_CONFIDENCE_THRESHOLD } from './drift.js';
import { checkDriftLLM } from './llm.js';
import { clearDriftCache } from './drift-cache.js';
import { logError, ERROR_TYPES } from './error-log.js';

let currentSession = null;
let timeBudgetAlarmName = 'intentlock-budget-alarm';
let trackingEnabled = true;
let customDistractionSites = [
  'twitter.com', 'x.com', 'facebook.com', 'reddit.com',
  'instagram.com', 'youtube.com', 'netflix.com', 'tiktok.com'
];
let sessionTabGroupId = null;

const OVERRIDE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const overrideCooldowns = new Map(); // domain -> cooldown expiry timestamp
let configPromise = null;

function createHistoryEntry(session) {
  const events = Array.isArray(session.events) ? session.events : [];
  return {
    id: session.id,
    intent: session.intent,
    startTime: session.startTime,
    endTime: session.endTime,
    timeBudget: session.timeBudget,
    driftCount: events.filter(e => e.actionType === 'OVERRIDE').length,
    totalEvents: events.length
  };
}

// Idle tracking
let lastIdleTime = 0;
let isCurrentlyIdle = false;
chrome.idle.setDetectionInterval(180); // 3 minutes

chrome.idle.onStateChanged.addListener((newState) => {
  const isIdle = (newState === 'idle' || newState === 'locked');
  chrome.storage.local.set({
    isCurrentlyIdle: isIdle,
    lastIdleTime: isIdle ? Date.now() : 0
  }, () => {
    isCurrentlyIdle = isIdle;
    lastIdleTime = isIdle ? Date.now() : 0;
  });
});

// Helper for trackable URLs
function isTrackableUrl(url) {
  if (!url) return false;
  const ignoredSchemes = ['chrome://', 'chrome-extension://', 'chrome-search://', 'about:', 'file:'];
  return !ignoredSchemes.some(scheme => url.startsWith(scheme));
}

// Helper to extract bare hostname from a URL
function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

// Centralized Session Ending Logic
function endActiveSession(reflection = null, callback = null) {
  chrome.storage.local.get(['activeSession', 'sessionHistory'], (result) => {
    const session = result.activeSession;
    if (session && session.isActive) {
      session.isActive = false;
      session.endTime = Date.now();
      if (reflection) {
        session.events = Array.isArray(session.events) ? session.events : [];
        session.events.push({
          timestamp: Date.now(),
          actionType: 'OVERRIDE',
          reflection: reflection
        });
      }

      const history = result.sessionHistory || [];
      history.push(createHistoryEntry(session));
      if (history.length > 100) history.shift();

      chrome.storage.local.set({ sessionHistory: history }, () => {
        chrome.storage.local.remove(['activeSession', 'interventionState', 'overrideCooldowns'], () => {
          ungroupTabs();
          currentSession = null;
          overrideCooldowns.clear();
          chrome.alarms.clear(timeBudgetAlarmName);
          if (callback) callback(session);
        });
      });
    } else {
      if (callback) callback(null);
    }
  });
}

// ── Keyboard shortcut ──────────────────────────────────────────────────

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-session') {
    chrome.storage.local.get(['activeSession'], (result) => {
      const session = result.activeSession;
      if (session && session.isActive) {
        endActiveSession(null, () => {
          chrome.runtime.sendMessage({ type: 'SESSION_CLEARED' });
        });
      } else {
        chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html') });
      }
    });
  }
});

// ── Message handling ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handledMessages = [
    'SESSION_STARTED', 'OVERRIDE_INTERVENTION', 'GET_SESSION',
    'CONFIG_UPDATED', 'SESSION_CLEARED', 'END_ACTIVE_SESSION', 'LOG_ERROR',
    'CONTENT_EVENT', 'OVERLAY_OVERRIDE', 'OVERLAY_DISMISS'
  ];
  if (!message || typeof message !== 'object' || !handledMessages.includes(message.type)) {
    return false;
  }

  loadConfig().then(() => {
    if (message.type === 'SESSION_STARTED') {
      handleSessionStart(message.session);
      sendResponse({ status: 'ok' });
    } else if (message.type === 'OVERRIDE_INTERVENTION') {
      handleOverride(message.sessionData);
      sendResponse({ status: 'ok' });
    } else if (message.type === 'GET_SESSION') {
      // Return the latest from storage if in-memory is null
      if (currentSession) {
        sendResponse({ session: currentSession });
      } else {
        chrome.storage.local.get(['activeSession'], (result) => {
          sendResponse({ session: result.activeSession || null });
        });
      }
    } else if (message.type === 'CONFIG_UPDATED') {
      reloadConfig()
        .then(() => sendResponse({ status: 'ok' }))
        .catch((err) => {
          console.error('CONFIG_UPDATED reload failed:', err);
          sendResponse({ status: 'error', message: err?.message || 'reload failed' });
        });
    } else if (message.type === 'SESSION_CLEARED') {
      ungroupTabs();
      currentSession = null;
      clearDriftCache();
      overrideCooldowns.clear();
      chrome.storage.local.remove(['overrideCooldowns']);
      chrome.alarms.clear(timeBudgetAlarmName);
      reloadConfig().then(() => {
        sendResponse({ status: 'ok' });
      });
    } else if (message.type === 'END_ACTIVE_SESSION') {
      endActiveSession(message.reflection, (endedSession) => {
        sendResponse({ status: 'ok', session: endedSession });
      });
    } else if (message.type === 'LOG_ERROR') {
      logError(message.payload || {}).then(() => {
        sendResponse({ status: 'ok' });
      });
    } else if (message.type === 'CONTENT_EVENT') {
      handleContentEvent(message.payload, sender.tab?.id);
      sendResponse({ status: 'ok' });
    } else if (message.type === 'OVERLAY_OVERRIDE') {
      handleOverlayOverride(message.payload, sender.tab?.id);
      sendResponse({ status: 'ok' });
    } else if (message.type === 'OVERLAY_DISMISS') {
      chrome.storage.local.remove(['interventionState']);
      if (sender.tab?.id) {
        chrome.tabs.sendMessage(sender.tab.id, { type: 'HIDE_INTERVENTION' }, () => {
          void chrome.runtime.lastError;
        });
      }
      sendResponse({ status: 'ok' });
    }
  });
  return true; // Keep channel open for async response
});

// ── Config loading ─────────────────────────────────────────────────────

function loadConfig() {
  if (configPromise) return configPromise;
  configPromise = new Promise((resolve) => {
    chrome.storage.local.get([
      'activeSession', 'trackingEnabled', 'customDistractionSites', 
      'sessionTabGroupId', 'isCurrentlyIdle', 'lastIdleTime',
      'overrideCooldowns'
    ], (result) => {
      const data = result || {};
      if (data.activeSession && data.activeSession.isActive) {
        currentSession = data.activeSession;

        // Restore time budget alarm if session has a time budget
        if (currentSession.timeBudget) {
          const elapsedMinutes = (Date.now() - currentSession.startTime) / 60000;
          const remainingMinutes = currentSession.timeBudget - elapsedMinutes;
          if (remainingMinutes > 0) {
            chrome.alarms.create(timeBudgetAlarmName, { 
              when: currentSession.startTime + (currentSession.timeBudget * 60000) 
            });
          } else {
            triggerIntervention("Time budget exceeded. Are you still working on your intent?");
          }
        }
      } else {
        currentSession = null;
      }
      if (data.trackingEnabled !== undefined) {
        trackingEnabled = data.trackingEnabled;
      } else {
        trackingEnabled = true;
      }
      if (data.customDistractionSites) {
        customDistractionSites = data.customDistractionSites;
      } else {
        customDistractionSites = [
          'twitter.com', 'x.com', 'facebook.com', 'reddit.com',
          'instagram.com', 'youtube.com', 'netflix.com', 'tiktok.com'
        ];
      }
      if (data.sessionTabGroupId !== undefined) {
        sessionTabGroupId = data.sessionTabGroupId;
      } else {
        sessionTabGroupId = null;
      }
      if (data.isCurrentlyIdle !== undefined) {
        isCurrentlyIdle = data.isCurrentlyIdle;
      } else {
        isCurrentlyIdle = false;
      }
      if (data.lastIdleTime !== undefined) {
        lastIdleTime = data.lastIdleTime;
      } else {
        lastIdleTime = 0;
      }
      if (Array.isArray(data.overrideCooldowns)) {
        overrideCooldowns.clear();
        data.overrideCooldowns.forEach((entry) => {
          if (Array.isArray(entry) && entry.length === 2) {
            overrideCooldowns.set(entry[0], entry[1]);
          }
        });
      } else {
        overrideCooldowns.clear();
      }
      resolve();
    });
  });
  return configPromise;
}

function reloadConfig() {
  configPromise = null;
  return loadConfig();
}
loadConfig();

function migrateLlmStorage() {
  if (typeof chrome === 'undefined' || !chrome.storage?.session || !chrome.storage?.local) {
    return;
  }

  chrome.storage.local.get(['openaiApiKey', 'llmProviderConfig'], (localRes) => {
    chrome.storage.session.get(['openaiApiKey', 'llmApiKey'], (sessionRes) => {
      const legacyKey = sessionRes?.openaiApiKey || localRes?.openaiApiKey;
      const sessionUpdates = {};
      const sessionRemovals = [];
      const localRemovals = [];

      if (legacyKey && !sessionRes?.llmApiKey) {
        sessionUpdates.llmApiKey = legacyKey;
      }
      if (sessionRes?.openaiApiKey) {
        sessionRemovals.push('openaiApiKey');
      }
      if (localRes?.openaiApiKey) {
        localRemovals.push('openaiApiKey');
      }

      const applySessionMigration = () => {
        if (!localRes?.llmProviderConfig) {
          chrome.storage.local.set({
            llmProviderConfig: {
              providerId: 'openai',
              model: 'gpt-4o-mini',
              baseUrl: 'https://api.openai.com/v1/chat/completions',
              customLabel: '',
              authType: 'bearer',
              apiStyle: 'openai',
            },
          });
        }
        if (localRemovals.length > 0) {
          chrome.storage.local.remove(localRemovals);
        }
        if (legacyKey) {
          console.log('LLM API key migrated to secure session storage.');
        }
      };

      if (Object.keys(sessionUpdates).length > 0) {
        chrome.storage.session.set(sessionUpdates, () => {
          if (sessionRemovals.length > 0) {
            chrome.storage.session.remove(sessionRemovals, applySessionMigration);
          } else {
            applySessionMigration();
          }
        });
      } else {
        applySessionMigration();
      }
    });
  });
}
migrateLlmStorage();

// ── Session start ──────────────────────────────────────────────────────

function handleSessionStart(session) {
  currentSession = session;
  clearDriftCache();
  overrideCooldowns.clear(); // clear cooldowns on new session
  chrome.storage.local.remove(['overrideCooldowns']);

  chrome.alarms.clear(timeBudgetAlarmName);

  if (session.timeBudget) {
    chrome.alarms.create(timeBudgetAlarmName, { 
      when: session.startTime + (session.timeBudget * 60000) 
    });
  }

  createTabGroup(session.intent);
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
    await chrome.storage.local.set({ sessionTabGroupId: groupId });
  } catch (e) {
    console.warn("Could not create tab group:", e);
  }
}

async function addTabToGroup(tabId) {
  if (!sessionTabGroupId) return;
  try {
    // Verify the group still exists
    await chrome.tabGroups.get(sessionTabGroupId);
  } catch (e) {
    ungroupTabs(); // Group closed, cleanup state
    return;
  }
  try {
    await chrome.tabs.group({ tabIds: [tabId], groupId: sessionTabGroupId });
  } catch (e) {
    console.warn("Could not group tab (likely closed):", e);
  }
}

function ungroupTabs() {
  sessionTabGroupId = null;
  chrome.storage.local.remove('sessionTabGroupId');
}

// ── Time budget alarm ──────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === timeBudgetAlarmName) {
    loadConfig().then(() => {
      chrome.storage.local.get(['activeSession'], (result) => {
        const session = result.activeSession;
        if (session && session.isActive) {
          triggerIntervention("Time budget exceeded. Are you still working on your intent?");
        }
      });
    });
  }
});

// ── Tab monitoring ─────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && isTrackableUrl(tab.url)) {
    loadConfig().then(() => {
      chrome.storage.local.get(['activeSession'], (result) => {
        const session = result.activeSession;
        if (session && session.isActive) {
          logEvent('PAGE_LOAD', tab.url);
          addTabToGroup(tabId);
          evaluateDrift(tab.url, tabId);
        }
      });
    });
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  loadConfig().then(() => {
    chrome.storage.local.get(['trackingEnabled', 'activeSession', 'isCurrentlyIdle', 'lastIdleTime'], (result) => {
      if (result.trackingEnabled === false) return;
      const session = result.activeSession;
      if (session && session.isActive) {
        chrome.tabs.get(activeInfo.tabId, (tab) => {
          if (chrome.runtime.lastError) return;
          if (tab && isTrackableUrl(tab.url)) {
            logEvent('TAB_SWITCH', tab.url);

            const isCurrentlyIdleVal = result.isCurrentlyIdle || false;
            const lastIdleTimeVal = result.lastIdleTime || 0;
            if (!isCurrentlyIdleVal && lastIdleTimeVal > 0 && (Date.now() - lastIdleTimeVal < 10000)) {
              chrome.storage.local.set({ lastIdleTime: 0 }, () => {
                triggerIntervention("You were idle and immediately switched context. Are you still aligned?", activeInfo.tabId);
              });
              return;
            }

            evaluateDrift(tab.url, activeInfo.tabId);
          }
        });
      }
    });
  });
});

// ── Event logging ──────────────────────────────────────────────────────

function logEvent(actionType, url, extras = {}) {
  chrome.storage.local.get(['activeSession', 'trackingEnabled'], (result) => {
    if (result.trackingEnabled === false) return;
    const session = result.activeSession;
    if (!session || !session.isActive) return;

    const event = {
      timestamp: Date.now(),
      url,
      actionType,
      ...extras,
    };
    session.events = Array.isArray(session.events) ? session.events : [];
    session.events.push(event);

    if (session.events.length > 50) {
      session.events.shift();
    }
    chrome.storage.local.set({ activeSession: session });
    currentSession = session;
  });
}

function handleContentEvent(payload, tabId) {
  if (!payload?.url || !payload?.actionType) return;

  const extras = {};
  if (payload.pageTitle) extras.pageTitle = payload.pageTitle;
  if (typeof payload.dwellMs === 'number') extras.dwellMs = payload.dwellMs;
  if (payload.previousUrl) extras.previousUrl = payload.previousUrl;

  logEvent(payload.actionType, payload.url, extras);

  if (payload.actionType === 'SPA_NAVIGATION') {
    evaluateDrift(payload.url, tabId);
  }
}

function handleOverlayOverride(payload, tabId) {
  chrome.storage.local.get(['activeSession', 'interventionState'], (result) => {
    const session = result.activeSession;
    if (!session || !session.isActive) return;

    const originalUrl = payload?.url || result.interventionState?.originalUrl || null;
    session.events = Array.isArray(session.events) ? session.events : [];
    session.events.push({
      timestamp: Date.now(),
      actionType: 'OVERRIDE',
      url: originalUrl,
      reflection: payload?.reflection || '',
      pageTitle: payload?.pageTitle || null,
      source: 'overlay',
    });

    chrome.storage.local.set({ activeSession: session }, () => {
      handleOverride(session);
      chrome.storage.local.remove(['interventionState']);
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: 'HIDE_INTERVENTION' }, () => {
          void chrome.runtime.lastError;
        });
      }
    });
  });
}

// ── Drift evaluation ───────────────────────────────────────────────────

let lastEvaluatedUrl = null;
let lastEvaluatedTime = 0;
const DRIFT_DEBOUNCE_MS = 5000;

function evaluateDrift(url, tabId) {
  chrome.storage.local.get(['activeSession', 'customDistractionSites'], (result) => {
    const session = result.activeSession;
    if (!session || !session.isActive) return;

    const now = Date.now();
    if (url === lastEvaluatedUrl && (now - lastEvaluatedTime) < DRIFT_DEBOUNCE_MS) {
      return;
    }
    lastEvaluatedUrl = url;
    lastEvaluatedTime = now;

    // Check per-domain override cooldown
    const evaluatedDomain = extractDomain(url);
    if (evaluatedDomain) {
      let hasCooldown = false;
      let mapChanged = false;
      const expiredDomains = [];
      for (const [cooldownDomain, expiresAt] of overrideCooldowns.entries()) {
        if (now < expiresAt) {
          if (evaluatedDomain === cooldownDomain || 
              evaluatedDomain.endsWith(`.${cooldownDomain}`) || 
              cooldownDomain.endsWith(`.${evaluatedDomain}`)) {
            hasCooldown = true;
          }
        } else {
          expiredDomains.push(cooldownDomain);
          mapChanged = true;
        }
      }
      if (expiredDomains.length > 0) {
        expiredDomains.forEach(domain => overrideCooldowns.delete(domain));
      }
      if (mapChanged) {
        chrome.storage.local.set({ overrideCooldowns: Array.from(overrideCooldowns.entries()) });
      }
      if (hasCooldown) {
        return; // Still in cooldown — skip intervention
      }
    }

    try {
      new URL(url);
    } catch (e) {
      console.warn("Could not parse URL:", url);
      return;
    }

    const customDistSites = result.customDistractionSites || customDistractionSites;
    const heuristic = evaluateHeuristicDrift({
      intent: session.intent,
      url,
      events: session.events,
      distractionSites: customDistSites
    });

    if (heuristic.shouldIntervene) {
      const reason = heuristic.reason === 'known_distraction'
        ? 'You seem to be drifting to a known distraction site. Why?'
        : 'Your recent browsing no longer matches your declared intent. Why?';
      triggerIntervention(reason, tabId);
      return;
    }

    checkDriftLLM(session.intent, url, session.events).then(res => {
      if (!res.isAligned && res.confidence >= DRIFT_CONFIDENCE_THRESHOLD) {
        chrome.storage.local.get(['activeSession', 'overrideCooldowns'], (storageResult) => {
          const current = storageResult.activeSession;
          if (current && current.isActive && current.id === session.id) {
            // Check if domain is currently on cooldown
            const evaluatedDomain = extractDomain(url);
            if (evaluatedDomain) {
              const cooldowns = new Map(storageResult.overrideCooldowns || []);
              const now = Date.now();
              let hasCooldown = false;
              for (const [cooldownDomain, expiresAt] of cooldowns.entries()) {
                if (now < expiresAt) {
                  if (evaluatedDomain === cooldownDomain || 
                      evaluatedDomain.endsWith(`.${cooldownDomain}`) || 
                      cooldownDomain.endsWith(`.${evaluatedDomain}`)) {
                    hasCooldown = true;
                    break;
                  }
                }
              }
              if (hasCooldown) return; // Skip intervention due to active cooldown
            }

            // Verify the tab is still on the evaluated URL
            if (tabId) {
              chrome.tabs.get(tabId, (tab) => {
                if (chrome.runtime.lastError || !tab) return;
                if (tab.url === url) {
                  triggerIntervention(`The AI has detected drift (Confidence: ${Math.round(res.confidence * 100)}%)`, tabId);
                }
              });
            } else {
              triggerIntervention(`The AI has detected drift (Confidence: ${Math.round(res.confidence * 100)}%)`, tabId);
            }
          }
        });
      }
    });
  });
}

// ── Intervention ───────────────────────────────────────────────────────

function triggerIntervention(reason, tabId = null) {
  const showTabReplacement = (targetTabId, originalUrl) => {
    chrome.storage.local.set({
      interventionState: { reason, timestamp: Date.now(), originalTabId: targetTabId, originalUrl }
    }, () => {
      if (targetTabId) {
        chrome.tabs.update(targetTabId, { url: chrome.runtime.getURL('intervention.html') });
      } else {
        chrome.tabs.create({ url: chrome.runtime.getURL('intervention.html') });
      }
    });
  };

  const tryOverlayThenFallback = (targetTabId, originalUrl, intent) => {
    chrome.storage.local.set({
      interventionState: {
        reason,
        timestamp: Date.now(),
        originalTabId: targetTabId,
        originalUrl,
        mode: 'overlay',
      },
    }, () => {
      if (!targetTabId) {
        showTabReplacement(null, originalUrl);
        return;
      }

      chrome.tabs.sendMessage(targetTabId, {
        type: 'SHOW_INTERVENTION',
        reason,
        intent,
      }, (response) => {
        if (chrome.runtime.lastError || !response?.shown) {
          showTabReplacement(targetTabId, originalUrl);
        }
      });
    });
  };

  const captureAndShow = (targetTabId) => {
    chrome.storage.local.get(['activeSession'], (result) => {
      const intent = result.activeSession?.intent || '';
      chrome.tabs.get(targetTabId, (tab) => {
        if (chrome.runtime.lastError) {
          tryOverlayThenFallback(null, null, intent);
        } else {
          tryOverlayThenFallback(targetTabId, tab.url || null, intent);
        }
      });
    });
  };

  if (tabId) {
    captureAndShow(tabId);
  } else {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs.find(tab => (
        tab.id &&
        tab.url &&
        !tab.url.startsWith('chrome://') &&
        !tab.url.startsWith('chrome-extension://')
      ));

      if (activeTab) {
        captureAndShow(activeTab.id);
      } else {
        chrome.storage.local.get(['activeSession'], (result) => {
          tryOverlayThenFallback(null, null, result.activeSession?.intent || '');
        });
      }
    });
  }
}

function handleOverride(sessionData) {
  if (sessionData) {
    currentSession = sessionData;
    chrome.storage.local.set({ activeSession: currentSession });

    // Set per-domain override cooldown from the most recent override event
    const events = Array.isArray(sessionData?.events) ? sessionData.events : [];
    const lastOverride = events
      .filter(e => e.actionType === 'OVERRIDE' && e.url)
      .at(-1);
    if (lastOverride && lastOverride.url) {
      const domain = extractDomain(lastOverride.url);
      if (domain) {
        overrideCooldowns.set(domain, Date.now() + OVERRIDE_COOLDOWN_MS);
        chrome.storage.local.set({ overrideCooldowns: Array.from(overrideCooldowns.entries()) });
      }
    }
  }
}

export function getInMemoryState() {
  return {
    currentSession,
    trackingEnabled,
    customDistractionSites,
    sessionTabGroupId,
    isCurrentlyIdle,
    lastIdleTime,
    overrideCooldowns
  };
}

export { reloadConfig };

