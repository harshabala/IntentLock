// background.js
import { DRIFT_CONFIDENCE_THRESHOLD } from './drift.js';
import {
  evaluatePolicyDrift,
  buildDefaultPolicy,
  migrateLegacyDistractionSites,
  isUrlAligned,
} from './heuristic-policy.js';
import { checkDriftLLM } from './llm.js';
import { clearDriftCache } from './drift-cache.js';
import { logError, registerErrorLogAuthority } from './error-log.js';
import { getEffectiveDistractionSites, DEFAULT_DISTRACTION_SITES } from './distraction-sites.js';
import { clearLlmBackoff, getQuotaBackoffUntil, registerBackoffCallback, setQuotaBackoff } from './llm-backoff.js';
import {
  applyDwellDelta,
  computeOnIntentRatio,
  createSessionMetrics,
  ensureMetrics,
  qualifiesForActivation,
  topDomains,
} from './session-metrics.js';
import {
  sanitizeSessionHistory,
  sanitizeUrl,
  SESSION_RETENTION_MS,
  MAX_SESSION_HISTORY,
} from './privacy-utils.js';
import {
  initializeStorageAuthority,
  deleteStorageData,
  assertStorageEpoch,
  assertStorageCommit,
  runStorageMutation,
  getStorageGeneration,
  isStorageDeletionActive,
} from './storage-queue.js';
import { applyStorageCommand, isExtensionPage, migrateKeys } from './storage-authority.js';

registerBackoffCallback((until) => {
  const generation = getStorageGeneration();
  void enqueueSessionMutation(() => {
    if (generation !== getStorageGeneration() || isStorageDeletionActive()) return;
    return storageSet({ llmBackoffUntil: until });
  });
});

let currentSession = null;
let timeBudgetAlarmName = 'intentlock-budget-alarm';
let trackingEnabled = true;
let customDistractionSites = [...DEFAULT_DISTRACTION_SITES];
let sessionTabGroupId = null;
let heuristicPolicy = null;
/** @type {Record<string, { count: number, lastMarkedAt: number }>} */
let relatedDomainMarks = {};

const OVERRIDE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const overrideCooldowns = new Map(); // domain -> cooldown expiry timestamp
const contentEventBuckets = new Map();
const CONTENT_EVENT_WINDOW_MS = 60_000;
const MAX_CONTENT_EVENTS_PER_WINDOW = 120;
let configPromise = null;

const INTERVENTION_STATE_KEY = 'interventionStates';
const COMPLETED_TRANSITION_KEY = 'completedInterventionTransitions';
const MAX_COMPLETED_TRANSITIONS = 100;

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

function storageSet(values) {
  assertStorageCommit();
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function storageRemove(keys) {
  assertStorageCommit();
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function enqueueSessionMutation(operation, epoch = getStorageGeneration()) {
  const pending = runStorageMutation(operation, epoch);
  // Event listeners may intentionally ignore results; request handlers still
  // receive the original rejection and must not announce success.
  pending.catch(() => {});
  return pending;
}

function interventionKey(sessionId, tabId) {
  return `${sessionId}:${tabId ?? 'fallback'}`;
}

function cloneInterventionStates(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...value };
}

function stateTabIds(state) {
  return [state?.originalTabId, state?.fallbackTabId].filter((id) => Number.isInteger(id));
}

function stateOwnsTab(state, tabId) {
  if (!state || !Number.isInteger(tabId)) return false;
  if (state.mode === 'fallback' && Number.isInteger(state.fallbackTabId)) {
    return state.fallbackTabId === tabId;
  }
  if (state.mode === 'pending' && Number.isInteger(state.fallbackTabId)) {
    return state.fallbackTabId === tabId || state.originalTabId === tabId;
  }
  return state.originalTabId === tabId;
}

function stateForTab(states, tabId, sessionId = null, nonce = null) {
  return Object.values(states).find((state) => (
    state &&
    (!sessionId || state.sessionId === sessionId) &&
    (!nonce || state.nonce === nonce) &&
    stateTabIds(state).includes(tabId)
  )) || null;
}

function createNonce() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      resolve({ response, error: error ? new Error(error.message) : null });
    });
  });
}

function getTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(tab || null);
    });
  });
}

function queryTabs(queryInfo) {
  return new Promise((resolve) => chrome.tabs.query(queryInfo, (tabs) => resolve(tabs || [])));
}

function updateTab(tabId, updateProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, updateProperties, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab || null);
    });
  });
}

function removeTab(tabId) {
  return new Promise((resolve, reject) => {
    if (typeof chrome.tabs.remove !== 'function') {
      reject(new Error('Chrome tabs.remove is unavailable.'));
      return;
    }
    chrome.tabs.remove(tabId, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function createTab(createProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(createProperties, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab || null);
    });
  });
}

async function persistInterventionStates(states) {
  const entries = Object.keys(states);
  if (entries.length === 0) {
    await storageRemove(INTERVENTION_STATE_KEY);
  } else {
    await storageSet({ [INTERVENTION_STATE_KEY]: states });
  }
}

function transitionKey(sessionId, nonce, transition) {
  return `${sessionId}:${nonce}:${transition}`;
}

function rememberCompletedTransition(completed, key, tabId, closeTab = false) {
  const next = {
    ...completed,
    [key]: { tabId, closeTab, completedAt: Date.now() },
  };
  const keys = Object.keys(next);
  if (keys.length > MAX_COMPLETED_TRANSITIONS) {
    keys
      .sort((a, b) => (next[a].completedAt || 0) - (next[b].completedAt || 0))
      .slice(0, keys.length - MAX_COMPLETED_TRANSITIONS)
      .forEach((oldKey) => delete next[oldKey]);
  }
  return next;
}

function relatedHostnamesList() {
  return Object.keys(relatedDomainMarks || {});
}

function createHistoryEntry(session) {
  const events = Array.isArray(session.events) ? session.events : [];
  const metrics = ensureMetrics(session);
  const overrides = events
    .filter(e => e.actionType === 'OVERRIDE')
    .map(e => ({
      timestamp: e.timestamp || 0,
      hostname: e.hostname || extractDomain(e.url) || null,
      reflection: e.reflection || null,
    }));
  return {
    id: session.id,
    intent: session.intent,
    startTime: session.startTime,
    endTime: session.endTime,
    timeBudget: session.timeBudget,
    driftCount: overrides.length,
    totalEvents: events.length,
    overrides,
    activeMs: metrics.activeMs || 0,
    alignedActiveMs: metrics.alignedActiveMs || 0,
    onIntentRatio: computeOnIntentRatio(metrics),
    interventionCount: metrics.interventionCount || 0,
    overrideCount: metrics.overrideCount || overrides.length,
    topDomains: topDomains(metrics, 5),
    reportViewed: false,
  };
}

// Idle tracking
let lastIdleTime = 0;
let isCurrentlyIdle = false;
chrome.idle.setDetectionInterval(180); // 3 minutes

function broadcastIdleState(isIdle) {
  const epoch = getStorageGeneration();
  if (typeof chrome.tabs?.query === 'function') {
    chrome.tabs.query({}, (tabs) => {
      (tabs || []).forEach((tab) => {
        if (epoch !== getStorageGeneration() || isStorageDeletionActive()) return;
        if (!Number.isInteger(tab.id)) return;
        chrome.tabs.sendMessage?.(tab.id, { type: 'IDLE_STATE', idle: isIdle }, () => {
          void chrome.runtime.lastError;
        });
      });
    });
  }
}

chrome.idle.onStateChanged.addListener((newState) => {
  const epoch = getStorageGeneration();
  const isIdle = (newState === 'idle' || newState === 'locked');
  chrome.storage.local.get(['trackingEnabled'], (result) => {
    if (epoch !== getStorageGeneration() || isStorageDeletionActive()) return;
    if (result.trackingEnabled === false) {
      isCurrentlyIdle = false;
      lastIdleTime = 0;
      void enqueueSessionMutation(() => storageRemove(['isCurrentlyIdle', 'lastIdleTime']));
      broadcastIdleState(false);
      return;
    }

    const idleTimestamp = isIdle ? Date.now() : 0;
    isCurrentlyIdle = isIdle;
    lastIdleTime = idleTimestamp;
    void enqueueSessionMutation(async () => {
      const latest = await storageGet(['trackingEnabled']);
      if (latest.trackingEnabled === false) return;
      await storageSet({
        isCurrentlyIdle: isIdle,
        lastIdleTime: idleTimestamp,
      });
    });
    broadcastIdleState(isIdle);
  });
});

// Helper for trackable URLs
function isTrackableUrl(url) {
  return sanitizeUrl(url) != null;
}

// Helper to extract bare hostname from a URL
function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function openSessionReportTab() {
  chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html?report=last') });
}

function handleReportViewed(sessionId, sendResponse) {
  const operation = enqueueSessionMutation(async () => {
    const result = await storageGet(['sessionHistory', 'activationState']);
    const history = sanitizeSessionHistory(result.sessionHistory || [], {
      retentionMs: SESSION_RETENTION_MS,
      maxEntries: MAX_SESSION_HISTORY,
    });
    let updated = false;
    let activationState = result.activationState || { activatedAt: null, sessionId: null };

    for (const entry of history) {
      if (entry.id === sessionId) {
        entry.reportViewed = true;
        updated = true;
        if (qualifiesForActivation(entry) && !activationState.activatedAt) {
          activationState = { activatedAt: Date.now(), sessionId: entry.id };
        }
        break;
      }
    }

    if (!updated) {
      return { status: 'ok', found: false };
    }

    await storageSet({ sessionHistory: history, activationState });
    return { status: 'ok', found: true, activationState };
  });
  operation.then((response) => sendResponse?.(response), () => {
    sendResponse?.({ status: 'error', message: 'Unable to update the session report.' });
  });
}

// Centralized Session Ending Logic
async function finalizeActiveSession(reflection = null, expectedSessionId = null) {
    const result = await storageGet(['activeSession', 'sessionHistory']);
    const session = result.activeSession;
    if (!session || !session.isActive || (expectedSessionId && session.id !== expectedSessionId)) return null;

    session.isActive = false;
    session.endTime = Date.now();
    ensureMetrics(session);
    if (reflection) {
      session.events = Array.isArray(session.events) ? session.events : [];
      session.events.push({
        timestamp: Date.now(),
        actionType: 'OVERRIDE',
        reflection,
      });
      session.metrics.overrideCount = (session.metrics.overrideCount || 0) + 1;
    }

    const entry = createHistoryEntry(session);
    const history = sanitizeSessionHistory([
      ...(Array.isArray(result.sessionHistory) ? result.sessionHistory : []),
      entry,
    ], { retentionMs: SESSION_RETENTION_MS, maxEntries: MAX_SESSION_HISTORY });

    session.onIntentRatio = entry.onIntentRatio;
    session.activeMs = entry.activeMs;
    session.alignedActiveMs = entry.alignedActiveMs;
    session.interventionCount = entry.interventionCount;
    session.overrideCount = entry.overrideCount;
    session.topDomains = entry.topDomains;

    await storageSet({ sessionHistory: history });
    await storageRemove(['activeSession', INTERVENTION_STATE_KEY, 'interventionState', 'overrideCooldowns', 'relatedDomainMarks', 'sessionTabGroupId']);
    hideInterventionsFromTabs();
    ungroupTabs();
    currentSession = null;
    overrideCooldowns.clear();
    relatedDomainMarks = {};
    chrome.alarms.clear(timeBudgetAlarmName);
    return session;
}

function endActiveSession(reflection = null, callback = null, expectedSessionId = null, epoch = getStorageGeneration()) {
  const operation = enqueueSessionMutation(() => finalizeActiveSession(reflection, expectedSessionId), epoch);
  if (callback) operation.then(callback, error => callback(null, error));
  return operation;
}

async function getInterventionStateForTab(tabId, epoch = getStorageGeneration()) {
  if (!Number.isInteger(tabId)) return null;
  const result = await storageGet(['activeSession', INTERVENTION_STATE_KEY, 'trackingEnabled']);
  assertStorageEpoch(epoch);
  if (result.trackingEnabled === false) return null;
  if (!result.activeSession?.isActive) return null;
  return stateForTab(
    cloneInterventionStates(result[INTERVENTION_STATE_KEY]),
    tabId,
    result.activeSession.id,
  );
}

function findStateEntry(states, state) {
  return Object.entries(states).find(([, candidate]) => candidate === state)?.[0] || null;
}

async function handleInterventionTransition(message, sender) {
  const tabId = Number.isInteger(sender?.tab?.id) ? sender.tab.id : message.tabId;
  if (!Number.isInteger(tabId)) {
    return { ok: false, error: 'Intervention transitions require a tab.' };
  }

  return enqueueSessionMutation(async () => {
    const result = await storageGet([
      'activeSession',
      INTERVENTION_STATE_KEY,
      'relatedDomainMarks',
      COMPLETED_TRANSITION_KEY,
      'trackingEnabled',
    ]);
    const session = result.activeSession;
    const states = cloneInterventionStates(result[INTERVENTION_STATE_KEY]);
    const completed = cloneInterventionStates(result[COMPLETED_TRANSITION_KEY]);
    if (result.trackingEnabled === false) {
      return { ok: false, error: 'Tracking is disabled.' };
    }
    const transition = message.transition;
    const completedKey = transitionKey(message.sessionId, message.nonce, transition);
    if (!session?.isActive && completed[completedKey]?.tabId === tabId) {
      return { ok: true, transition, idempotent: true, closeTab: Boolean(completed[completedKey].closeTab) };
    }
    const state = stateForTab(states, tabId, message.sessionId, message.nonce);
    if (!session?.isActive || !state || session.id !== message.sessionId || !stateOwnsTab(state, tabId)) {
      return { ok: false, error: 'This intervention is stale or belongs to another tab.' };
    }

    const stateEntry = findStateEntry(states, state);
    if (!stateEntry) return { ok: false, error: 'This intervention is no longer pending.' };

    if (!['override', 'mark-related', 'end-session', 'close-tab'].includes(transition)) {
      return { ok: false, error: 'Unsupported intervention transition.' };
    }

    const reflection = typeof message.reflection === 'string' ? message.reflection.trim().slice(0, 2000) : '';
    if ((transition === 'override' || transition === 'mark-related') && !reflection) {
      return { ok: false, error: 'A reflection is required to continue.' };
    }

    if (transition === 'end-session') {
      const endedSession = await finalizeActiveSession(null, state.sessionId);
      if (!endedSession) return { ok: false, error: 'The session has already ended.' };
      const nextCompleted = rememberCompletedTransition(
        completed,
        completedKey,
        tabId,
        state.mode === 'fallback',
      );
      await storageSet({ [COMPLETED_TRANSITION_KEY]: nextCompleted });
      return {
        ok: true,
        transition,
        session: endedSession,
        closeTab: state.mode === 'fallback',
      };
    }

    if (transition === 'close-tab') {
      try {
        await removeTab(tabId);
      } catch (error) {
        return { ok: false, error: error.message || 'Unable to close the locked tab.' };
      }
      delete states[stateEntry];
      await persistInterventionStates(states);
      return { ok: true, transition, closeTab: true };
    }

    delete states[stateEntry];

    ensureMetrics(session);
    const originalUrl = state.originalUrl || null;
    session.metrics.overrideCount = (session.metrics.overrideCount || 0) + 1;
    session.events = Array.isArray(session.events) ? session.events : [];
    session.events.push({
      timestamp: Date.now(),
      actionType: 'OVERRIDE',
      url: originalUrl,
      hostname: extractDomain(originalUrl),
      reflection: reflection || null,
      source: 'intervention',
    });

    const values = { activeSession: session };
    if (message.markRelated || transition === 'mark-related') {
      const host = extractDomain(originalUrl);
      if (host) {
        const marks = { ...(result.relatedDomainMarks || relatedDomainMarks || {}) };
        const previous = marks[host] || { count: 0, lastMarkedAt: 0 };
        marks[host] = { count: (previous.count || 0) + 1, lastMarkedAt: Date.now() };
        const keys = Object.keys(marks);
        if (keys.length > 200) {
          keys
            .sort((a, b) => (marks[a].lastMarkedAt || 0) - (marks[b].lastMarkedAt || 0))
            .slice(0, keys.length - 200)
            .forEach((key) => delete marks[key]);
        }
        relatedDomainMarks = marks;
        values.relatedDomainMarks = marks;
      }
    }

    const domain = extractDomain(originalUrl);
    if (domain) {
      overrideCooldowns.set(domain, Date.now() + OVERRIDE_COOLDOWN_MS);
      values.overrideCooldowns = Array.from(overrideCooldowns.entries());
    }

    await storageSet(values);
    await persistInterventionStates(states);
    currentSession = session;
    return { ok: true, transition, session, state };
  });
}

function fencePrivateState() {
  hideInterventionsFromTabs();
  currentSession = null;
  trackingEnabled = false;
  customDistractionSites = [...DEFAULT_DISTRACTION_SITES];
  sessionTabGroupId = null;
  heuristicPolicy = null;
  isCurrentlyIdle = false;
  lastIdleTime = 0;
  relatedDomainMarks = {};
  overrideCooldowns.clear();
  contentEventBuckets.clear();
  clearDriftCache();
  clearLlmBackoff();
  lastEvaluatedUrl = null;
  lastEvaluatedTime = 0;
  chrome.alarms.clear(timeBudgetAlarmName);
  configPromise = null;
}

function handleSessionCleared(sendResponse) {
  chrome.runtime.sendMessage?.({ type: 'DATA_DELETION_STARTED' }, () => { void chrome.runtime.lastError; });
  deleteStorageData(fencePrivateState).then(async () => {
    fencePrivateState();
    authorityReady = Promise.resolve();
    await reloadConfig();
    chrome.runtime.sendMessage?.({ type: 'DATA_DELETED', epoch: getStorageGeneration() }, () => { void chrome.runtime.lastError; });
    sendResponse({ status: 'ok' });
  }, error => {
    sendResponse({ status: 'error', message: error.message || 'Unable to delete IntentLock data.' });
  });
}

// ── Keyboard shortcut ──────────────────────────────────────────────────

chrome.commands.onCommand.addListener((command) => {
  const epoch = getStorageGeneration();
  if (command === 'toggle-session') {
    chrome.storage.local.get(['activeSession'], (result) => {
      if (epoch !== getStorageGeneration() || isStorageDeletionActive()) return;
      const session = result.activeSession;
      if (session && session.isActive) {
        endActiveSession(null, (ended, error) => {
          if (ended && !error) openSessionReportTab();
        }, session.id, epoch);
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
    'CONFIG_UPDATED', 'SESSION_CLEARED', 'DELETE_ALL_DATA', 'END_ACTIVE_SESSION', 'LOG_ERROR',
    'CONTENT_EVENT', 'GET_INTERVENTION_STATE', 'INTERVENTION_TRANSITION',
    'TEST_INTERVENTION', 'REPORT_VIEWED', 'STORAGE_MUTATION'
  ];
  if (!message || typeof message !== 'object' || !handledMessages.includes(message.type)) {
    return false;
  }

  const page = isExtensionPage(sender);
  const contentMessages = ['CONTENT_EVENT', 'GET_INTERVENTION_STATE', 'INTERVENTION_TRANSITION', 'LOG_ERROR'];
  if ((sender?.id && sender.id !== chrome.runtime.id) || (!page && !(sender?.tab && contentMessages.includes(message.type)))) {
    sendResponse({ status: 'error', message: 'This operation requires an extension page.' });
    return false;
  }
  // Capture on receipt, before config reads or other callbacks. Page payloads
  // carry their original epoch; classic content events are bound on receipt.
  const epoch = message.epoch === undefined ? getStorageGeneration() : message.epoch;
  if (['STORAGE_MUTATION', 'SESSION_STARTED', 'END_ACTIVE_SESSION', 'SESSION_CLEARED', 'OVERRIDE_INTERVENTION'].includes(message.type) && !Number.isSafeInteger(message.epoch)) {
    sendResponse({ status: 'error', message: 'A mutation epoch is required.' });
    return false;
  }

  if (message.type === 'DELETE_ALL_DATA') {
    handleSessionCleared(sendResponse);
    return true;
  }

  authorityReady.then(() => {
    assertStorageEpoch(epoch);
    return loadConfig();
  }).then(() => {
    assertStorageEpoch(epoch);
    if (message.type === 'STORAGE_MUTATION') {
      applyStorageCommand(message.command, message.payload, epoch).then(
        value => sendResponse({ status: 'ok', value }),
        error => sendResponse({ status: 'error', message: error.message }),
      );
    } else if (message.type === 'SESSION_STARTED') {
      handleSessionStart(message.session, epoch).then(() => {
        sendResponse({ status: 'ok' });
      }, (error) => {
        sendResponse({ status: 'error', message: error.message || 'Unable to start the session.' });
      });
    } else if (message.type === 'OVERRIDE_INTERVENTION') {
      handleOverride(message.sessionData, epoch).then(() => {
        sendResponse({ status: 'ok' });
      }, (error) => {
        sendResponse({ status: 'error', message: error.message || 'Unable to apply the override.' });
      });
    } else if (message.type === 'GET_SESSION') {
      // Return the latest from storage if in-memory is null
      if (currentSession) {
        sendResponse({ session: currentSession });
      } else {
        chrome.storage.local.get(['activeSession'], (result) => {
          if (epoch !== getStorageGeneration() || isStorageDeletionActive()) {
            sendResponse({ status: 'error', session: null, message: 'Data changed while reading the session.' });
            return;
          }
          sendResponse({ session: result.activeSession || null });
        });
      }
    } else if (message.type === 'GET_INTERVENTION_STATE') {
      const requestedTabId = Number.isInteger(sender.tab?.id) ? sender.tab.id : message.tabId;
      getInterventionStateForTab(requestedTabId, epoch).then((state) => {
        assertStorageEpoch(epoch);
        sendResponse({ ok: true, state });
      }).catch((error) => {
        sendResponse({ ok: false, error: error.message || 'Unable to read intervention state.' });
      });
    } else if (message.type === 'CONFIG_UPDATED') {
      reloadConfig()
        .then(() => sendResponse({ status: 'ok' }))
        .catch((err) => {
          console.error('CONFIG_UPDATED reload failed:', err);
          sendResponse({ status: 'error', message: err?.message || 'reload failed' });
        });
    } else if (message.type === 'SESSION_CLEARED') {
      enqueueSessionMutation(async () => {
        ungroupTabs();
        currentSession = null;
        clearDriftCache();
        clearLlmBackoff();
        overrideCooldowns.clear();
        await storageRemove([
          INTERVENTION_STATE_KEY,
          'interventionState',
          'overrideCooldowns',
          COMPLETED_TRANSITION_KEY,
          'sessionTabGroupId',
        ]);
        configPromise = null;
        await loadConfig();
        return { status: 'ok' };
      }).then(sendResponse, () => {
        sendResponse({ status: 'error', message: 'Unable to clear the completed session state.' });
      });
    } else if (message.type === 'END_ACTIVE_SESSION') {
      endActiveSession(message.reflection, (endedSession, error) => {
        sendResponse(error ? { status: 'error', message: error.message } : { status: 'ok', session: endedSession });
      }, message.sessionId || null, epoch);
    } else if (message.type === 'REPORT_VIEWED') {
      handleReportViewed(message.sessionId, sendResponse);
    } else if (message.type === 'LOG_ERROR') {
      logError(message.payload || {}).then(() => {
        sendResponse({ status: 'ok' });
      });
    } else if (message.type === 'CONTENT_EVENT') {
      handleContentEvent(message.payload, sender.tab?.id);
      sendResponse({ status: 'ok' });
    } else if (message.type === 'INTERVENTION_TRANSITION') {
      handleInterventionTransition(message, sender).then((result) => {
        sendResponse(result);
      }, (error) => {
        sendResponse({ ok: false, error: error.message || 'Intervention transition failed.' });
      });
    } else if (message.type === 'TEST_INTERVENTION') {
      chrome.storage.local.get(['activeSession', 'trackingEnabled'], (result) => {
        if (result.trackingEnabled === false) {
          sendResponse({ ok: false, error: 'Tracking is disabled.' });
          return;
        }
        const session = result.activeSession;
        if (!session?.isActive) {
          sendResponse({ ok: false, error: 'Start a session first (Lock in on the new tab).' });
          return;
        }
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const activeTab = tabs.find((tab) => tab.id && tab.url && isTrackableUrl(tab.url));
          if (!activeTab) {
            sendResponse({ ok: false, error: 'Open a website first, then try the lock.' });
            return;
          }
          triggerIntervention('Test intervention — drift detection is working.', activeTab.id);
          sendResponse({ ok: true });
        });
      });
    }
  }).catch(error => sendResponse({ status: 'error', message: error.message }));
  return true; // Keep channel open for async response
});

// ── Config loading ─────────────────────────────────────────────────────

function loadConfig() {
  if (isStorageDeletionActive()) return Promise.resolve();
  if (configPromise) return configPromise;
  const generation = getStorageGeneration();
  const pending = new Promise((resolve) => {
    chrome.storage.local.get([
      'activeSession', 'trackingEnabled', 'customDistractionSites',
      'sessionTabGroupId', 'isCurrentlyIdle', 'lastIdleTime',
      'overrideCooldowns', 'heuristicPolicy', 'llmBackoffUntil',
      'relatedDomainMarks', 'sessionHistory'
    ], (result) => {
      const data = result || {};
      if (generation !== getStorageGeneration() || isStorageDeletionActive()) {
        if (configPromise === pending) configPromise = null;
        resolve();
        return;
      }
      if (Array.isArray(data.sessionHistory)) {
        void enqueueSessionMutation(async () => {
          if (generation !== getStorageGeneration() || isStorageDeletionActive()) return;
          const latest = await storageGet(['sessionHistory']);
          if (!Array.isArray(latest.sessionHistory)) return;
          return storageSet({
            sessionHistory: sanitizeSessionHistory(latest.sessionHistory, {
              retentionMs: SESSION_RETENTION_MS,
              maxEntries: MAX_SESSION_HISTORY,
            }),
          });
        });
      }
      if (data.activeSession && data.activeSession.isActive) {
        currentSession = data.activeSession;
        ensureMetrics(currentSession);

        // Restore time budget alarm if session has a time budget
        if (currentSession.timeBudget) {
          const elapsedMinutes = (Date.now() - currentSession.startTime) / 60000;
          const remainingMinutes = currentSession.timeBudget - elapsedMinutes;
          if (remainingMinutes > 0) {
            chrome.alarms.create(timeBudgetAlarmName, { 
              when: currentSession.startTime + (currentSession.timeBudget * 60000) 
            });
          } else {
            triggerIntervention("Time budget exceeded.");
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
      customDistractionSites = getEffectiveDistractionSites(data.customDistractionSites);
      if (data.heuristicPolicy && data.heuristicPolicy.version === 1) {
        heuristicPolicy = data.heuristicPolicy;
      } else if (data.customDistractionSites) {
        heuristicPolicy = migrateLegacyDistractionSites(data.customDistractionSites);
        void enqueueSessionMutation(() => {
          if (generation !== getStorageGeneration() || isStorageDeletionActive()) return;
          return storageSet({ heuristicPolicy });
        });
      } else {
        heuristicPolicy = buildDefaultPolicy('deep_work', 'balanced');
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
      if (data.llmBackoffUntil && data.llmBackoffUntil > Date.now()) {
        setQuotaBackoff({ retryAfterMs: data.llmBackoffUntil - Date.now() });
      }
      if (data.relatedDomainMarks && typeof data.relatedDomainMarks === 'object') {
        relatedDomainMarks = data.relatedDomainMarks;
      } else {
        relatedDomainMarks = {};
      }
      resolve();
    });
  });
  configPromise = pending;
  return configPromise;
}

function reloadConfig() {
  configPromise = null;
  return loadConfig();
}

function hideInterventionsFromTabs() {
  chrome.runtime.sendMessage?.({ type: 'HIDE_INTERVENTION' }, () => {
    void chrome.runtime.lastError;
  });
  if (typeof chrome.tabs?.query !== 'function') return;
  chrome.tabs.query({}, (tabs) => {
    (tabs || []).forEach((tab) => {
      if (!Number.isInteger(tab.id)) return;
      chrome.tabs.sendMessage?.(tab.id, { type: 'HIDE_INTERVENTION' }, () => {
        void chrome.runtime.lastError;
      });
    });
  });
}

chrome.storage.onChanged?.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.trackingEnabled) return;
  if (changes.trackingEnabled.newValue === false) {
    trackingEnabled = false;
    isCurrentlyIdle = false;
    lastIdleTime = 0;
    hideInterventionsFromTabs();
    void enqueueSessionMutation(async () => {
      await storageRemove([
        'isCurrentlyIdle',
        'lastIdleTime',
        INTERVENTION_STATE_KEY,
        'interventionState',
      ]);
    });
  } else if (changes.trackingEnabled.newValue !== undefined) {
    trackingEnabled = changes.trackingEnabled.newValue !== false;
    void reloadConfig();
  }
});

// ── Session start ──────────────────────────────────────────────────────

function handleSessionStart(session, epoch = getStorageGeneration()) {
  if (!session || typeof session.intent !== 'string' || !session.intent.trim() || session.intent.length > 4000 ||
      typeof session.id !== 'string' || session.id.length > 200 || !Number.isFinite(session.startTime) || session.isActive !== true ||
      (session.timeBudget != null && (!Number.isFinite(session.timeBudget) || session.timeBudget < 1 || session.timeBudget > 480))) {
    return Promise.reject(new Error('Invalid session fields.'));
  }
  return enqueueSessionMutation(async () => {
    ensureMetrics(session);
    if (!session.metrics || session.metrics.activeMs == null) {
      session.metrics = createSessionMetrics();
    }
    clearDriftCache();
    clearLlmBackoff();
    // A new session must evaluate even a URL checked in the previous session.
    lastEvaluatedUrl = null;
    lastEvaluatedTime = 0;
    await storageRemove(['llmBackoffUntil']);
    overrideCooldowns.clear(); // clear cooldowns on new session
    relatedDomainMarks = {}; // related exceptions belong only to this session
    await storageRemove(['overrideCooldowns', 'relatedDomainMarks']);
    await storageSet({ activeSession: session });
    assertStorageCommit();
    currentSession = session;

    chrome.alarms.clear(timeBudgetAlarmName);

    if (session.timeBudget) {
      chrome.alarms.create(timeBudgetAlarmName, {
        when: session.startTime + (session.timeBudget * 60000)
      });
    }

    await createTabGroup(session.intent);
    return session;
  }, epoch);
}

// ── Tab context grouping ───────────────────────────────────────────────

async function createTabGroup(intent) {
  const generation = getStorageGeneration();
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

    if (generation !== getStorageGeneration() || isStorageDeletionActive()) return;
    sessionTabGroupId = groupId;
    await storageSet({ sessionTabGroupId: groupId });
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
  // The caller owns the mutation, including cleanup of this storage key.
}

// ── Time budget alarm ──────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  const epoch = getStorageGeneration();
  if (alarm.name === timeBudgetAlarmName) {
    loadConfig().then(() => {
      chrome.storage.local.get(['activeSession', 'trackingEnabled'], (result) => {
        if (epoch !== getStorageGeneration() || isStorageDeletionActive()) return;
        if (result.trackingEnabled === false) return;
        const session = result.activeSession;
        if (session && session.isActive) {
          triggerIntervention("Time budget exceeded.");
        }
      });
    });
  }
});

// ── Tab monitoring ─────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const epoch = getStorageGeneration();
  if (changeInfo.status === 'complete' && isTrackableUrl(tab.url)) {
    loadConfig().then(() => {
      chrome.storage.local.get(['activeSession', 'trackingEnabled'], (result) => {
        if (epoch !== getStorageGeneration() || isStorageDeletionActive()) return;
        if (result.trackingEnabled === false) return;
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
  const epoch = getStorageGeneration();
  loadConfig().then(() => {
    chrome.storage.local.get(['trackingEnabled', 'activeSession', 'isCurrentlyIdle', 'lastIdleTime'], (result) => {
      if (epoch !== getStorageGeneration() || isStorageDeletionActive()) return;
      if (result.trackingEnabled === false) return;
      const session = result.activeSession;
      if (session && session.isActive) {
        chrome.tabs.get(activeInfo.tabId, (tab) => {
          if (epoch !== getStorageGeneration() || isStorageDeletionActive()) return;
          if (chrome.runtime.lastError) return;
          if (tab && isTrackableUrl(tab.url)) {
            logEvent('TAB_SWITCH', tab.url);

            const isCurrentlyIdleVal = result.isCurrentlyIdle || false;
            const lastIdleTimeVal = result.lastIdleTime || 0;
            if (!isCurrentlyIdleVal && lastIdleTimeVal > 0 && (Date.now() - lastIdleTimeVal < 10000)) {
              enqueueSessionMutation(() => storageSet({ lastIdleTime: 0 }), epoch).then(() => {
                triggerIntervention("You switched context after being idle.", activeInfo.tabId);
              }).catch(() => {});
              return;
            }

            evaluateDrift(tab.url, activeInfo.tabId);
          }
        });
      }
    });
  });
});

chrome.tabs.onRemoved?.addListener((tabId) => {
  contentEventBuckets.delete(tabId);
  void enqueueSessionMutation(async () => {
    const result = await storageGet([INTERVENTION_STATE_KEY]);
    const states = cloneInterventionStates(result[INTERVENTION_STATE_KEY]);
    let changed = false;
    for (const [key, state] of Object.entries(states)) {
      if (stateOwnsTab(state, tabId)) {
        delete states[key];
        changed = true;
      }
    }
    if (changed) await persistInterventionStates(states);
  });
});

// ── Event logging ──────────────────────────────────────────────────────

function logEvent(actionType, url, extras = {}) {
  return enqueueSessionMutation(async () => {
    const result = await storageGet(['activeSession', 'trackingEnabled']);
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
    await storageSet({ activeSession: session });
    currentSession = session;
  });
}

function handleContentEvent(payload, tabId) {
  if (!Number.isInteger(tabId) || !payload || typeof payload !== 'object') return;
  const allowedActions = new Set(['PAGE_DWELL', 'SPA_NAVIGATION', 'PAGE_LOAD', 'TAB_SWITCH']);
  if (
    typeof payload.url !== 'string' ||
    payload.url.length === 0 ||
    payload.url.length > 2048 ||
    !allowedActions.has(payload.actionType) ||
    (payload.pageTitle !== undefined && (typeof payload.pageTitle !== 'string' || payload.pageTitle.length > 200)) ||
    (payload.previousUrl !== undefined && (typeof payload.previousUrl !== 'string' || payload.previousUrl.length > 2048)) ||
    (payload.navigationUrl !== undefined && (typeof payload.navigationUrl !== 'string' || payload.navigationUrl.length > 2048)) ||
    (payload.dwellMs !== undefined && (!Number.isFinite(payload.dwellMs) || payload.dwellMs < 0 || payload.dwellMs > 86_400_000)) ||
    (payload.dwellDeltaMs !== undefined && (!Number.isFinite(payload.dwellDeltaMs) || payload.dwellDeltaMs < 0 || payload.dwellDeltaMs > 86_400_000))
  ) return;

  const now = Date.now();
  const bucket = contentEventBuckets.get(tabId) || { startedAt: now, count: 0 };
  if (now - bucket.startedAt >= CONTENT_EVENT_WINDOW_MS) {
    bucket.startedAt = now;
    bucket.count = 0;
  }
  if (bucket.count >= MAX_CONTENT_EVENTS_PER_WINDOW) return;
  bucket.count += 1;
  contentEventBuckets.set(tabId, bucket);

  // Page titles can carry private text (mail subjects, document names) and no
  // decision uses them, so they are never persisted.
  const extras = {};
  if (typeof payload.dwellMs === 'number') extras.dwellMs = payload.dwellMs;
  if (typeof payload.dwellDeltaMs === 'number') extras.dwellDeltaMs = payload.dwellDeltaMs;
  if (payload.previousUrl) extras.previousUrl = payload.previousUrl;
  if (payload.navigationUrl) extras.navigationUrl = payload.navigationUrl;

  // Accumulate on-intent metrics from dwell deltas (not reconstructable from capped events)
  if (
    (payload.actionType === 'PAGE_DWELL' || payload.actionType === 'SPA_NAVIGATION') &&
    typeof payload.dwellDeltaMs === 'number' &&
    payload.dwellDeltaMs > 0
  ) {
    enqueueSessionMutation(async () => {
      const result = await storageGet(['activeSession', 'trackingEnabled']);
      if (result.trackingEnabled === false) return;
      const session = result.activeSession;
      if (!session?.isActive) return;
      ensureMetrics(session);
      const metricUrl = payload.actionType === 'SPA_NAVIGATION'
        ? (payload.previousUrl || payload.url)
        : payload.url;
      const hostname = extractDomain(metricUrl);
      const aligned = isUrlAligned(
        session.intent,
        metricUrl,
        session.heuristicPolicy || heuristicPolicy,
        relatedHostnamesList()
      );
      session.metrics = applyDwellDelta(session.metrics, {
        hostname,
        deltaMs: payload.dwellDeltaMs,
        aligned,
      });
      await storageSet({ activeSession: session });
      currentSession = session;
    });
  }

  logEvent(payload.actionType, payload.url, extras);

  if (payload.actionType === 'SPA_NAVIGATION') {
    evaluateDrift(payload.navigationUrl || payload.url, tabId);
  }
}

// ── Drift evaluation ───────────────────────────────────────────────────

let lastEvaluatedUrl = null;
let lastEvaluatedTime = 0;
const DRIFT_DEBOUNCE_MS = 5000;

function evaluateDrift(url, tabId) {
  const epoch = getStorageGeneration();
  chrome.storage.local.get(['activeSession', 'customDistractionSites', 'trackingEnabled'], (result) => {
    if (epoch !== getStorageGeneration() || isStorageDeletionActive()) return;
    if (result.trackingEnabled === false) return;
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
        void enqueueSessionMutation(() => storageSet({ overrideCooldowns: Array.from(overrideCooldowns.entries()) }), epoch);
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

    const activePolicy = session.heuristicPolicy || heuristicPolicy || buildDefaultPolicy('deep_work', 'balanced');
    const policyDrift = evaluatePolicyDrift({
      intent: session.intent,
      url,
      events: session.events,
      policy: activePolicy,
      now: Date.now(),
      relatedHostnames: relatedHostnamesList(),
    });

    if (policyDrift.shouldIntervene) {
      triggerIntervention(policyDrift.reasonLabel || 'Your recent browsing no longer matches your declared intent.', tabId);
      return;
    }
    // Optional AI is a second opinion; it never overrules an explicit allow
    // or a session-related correction.
    if (policyDrift.explicit) return;

    checkDriftLLM(session.intent, url, session.events).then(res => {
      if (epoch !== getStorageGeneration() || isStorageDeletionActive()) return;
      if (!res.isAligned && res.confidence >= DRIFT_CONFIDENCE_THRESHOLD) {
        chrome.storage.local.get(['activeSession', 'overrideCooldowns'], (storageResult) => {
          if (epoch !== getStorageGeneration() || isStorageDeletionActive()) return;
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
                if (epoch !== getStorageGeneration() || isStorageDeletionActive()) return;
                if (chrome.runtime.lastError || !tab) return;
                if (tab.url === url) {
                  triggerIntervention('Your recent browsing no longer matches your declared intent.', tabId);
                }
              });
            } else {
              triggerIntervention('Your recent browsing no longer matches your declared intent.', tabId);
            }
          }
        });
      }
    });
  });
}

// ── Intervention ───────────────────────────────────────────────────────

function shouldRetryInterventionDisplay(state) {
  if (!state) return false;
  if (state.mode === 'pending') return true;
  return state.displayed === false;
}

async function presentIntervention(state, session, states, key) {
  assertStorageCommit();
  const targetTabId = Number.isInteger(state.originalTabId) ? state.originalTabId : null;
  if (targetTabId) {
    const shown = await sendTabMessage(targetTabId, {
      type: 'SHOW_INTERVENTION',
      reason: state.reason,
      intent: session.intent || state.intent || '',
      sessionId: state.sessionId,
      nonce: state.nonce,
      state,
    });
    assertStorageCommit();
    if (!shown.error && shown.response?.shown) {
      state.mode = 'overlay';
      state.displayed = true;
      states[key] = state;
      await persistInterventionStates(states);
      return state;
    }
    if (shown.response?.reason === 'tracking_disabled') {
      delete states[key];
      await persistInterventionStates(states);
      return null;
    }
    try {
      await updateTab(targetTabId, { url: chrome.runtime.getURL('intervention.html') });
    } catch {
      return state;
    }
    state.mode = 'fallback';
    state.displayed = true;
    state.fallbackTabId = targetTabId;
    states[key] = state;
    await persistInterventionStates(states);
    return state;
  }

  if (Number.isInteger(state.fallbackTabId)) {
    try {
      await updateTab(state.fallbackTabId, { url: chrome.runtime.getURL('intervention.html') });
    } catch {
      return state;
    }
    state.mode = 'fallback';
    state.displayed = true;
    states[key] = state;
    await persistInterventionStates(states);
  }
  return state;
}

function triggerIntervention(reason, tabId = null) {
  return enqueueSessionMutation(async () => {
    const result = await storageGet(['activeSession', INTERVENTION_STATE_KEY, 'trackingEnabled']);
    if (result.trackingEnabled === false) return null;
    const session = result.activeSession;
    if (!session?.isActive) return null;

    let targetTab = null;
    if (Number.isInteger(tabId)) {
      targetTab = await getTab(tabId);
    } else {
      const tabs = await queryTabs({ active: true, currentWindow: true });
      targetTab = tabs.find((tab) => (
        Number.isInteger(tab.id) && isTrackableUrl(tab.url)
      )) || null;
    }

    const targetTabId = Number.isInteger(targetTab?.id) ? targetTab.id : null;
    const states = cloneInterventionStates(result[INTERVENTION_STATE_KEY]);
    const existing = stateForTab(states, targetTabId, session.id);
    if (existing) {
      if (!shouldRetryInterventionDisplay(existing)) return existing;
      const key = findStateEntry(states, existing);
      if (!key) return existing;
      existing.intent = existing.intent || session.intent || '';
      return presentIntervention(existing, session, states, key);
    }

    ensureMetrics(session);
    session.metrics.interventionCount = (session.metrics.interventionCount || 0) + 1;

    let fallbackTabId = null;
    if (!targetTabId) {
      // Create a blank tab first so the state is persisted before extension-page code runs.
      const fallbackTab = await createTab({ url: 'about:blank' });
      fallbackTabId = Number.isInteger(fallbackTab?.id) ? fallbackTab.id : null;
    }

    const state = {
      sessionId: session.id,
      nonce: createNonce(),
      reason,
      intent: session.intent || '',
      originalTabId: targetTabId,
      fallbackTabId,
      originalUrl: targetTab?.url || null,
      mode: 'pending',
      displayed: false,
      timestamp: Date.now(),
    };
    const key = interventionKey(session.id, targetTabId ?? fallbackTabId);
    states[key] = state;
    await storageSet({ activeSession: session, [INTERVENTION_STATE_KEY]: states });
    currentSession = session;

    return presentIntervention(state, session, states, key);
  });
}

function handleOverride(sessionData, epoch = getStorageGeneration()) {
  if (!sessionData) return Promise.resolve();
  return enqueueSessionMutation(async () => {
    await storageSet({ activeSession: sessionData });
    assertStorageCommit();
    currentSession = sessionData;

    // Set per-domain override cooldown from the most recent override event
    const events = Array.isArray(sessionData?.events) ? sessionData.events : [];
    const lastOverride = events
      .filter(e => e.actionType === 'OVERRIDE' && e.url)
      .at(-1);
    if (lastOverride && lastOverride.url) {
      const domain = extractDomain(lastOverride.url);
      if (domain) {
        overrideCooldowns.set(domain, Date.now() + OVERRIDE_COOLDOWN_MS);
        await storageSet({ overrideCooldowns: Array.from(overrideCooldowns.entries()) });
      }
    }
  }, epoch);
}

export function getInMemoryState() {
  return {
    currentSession,
    trackingEnabled,
    customDistractionSites,
    heuristicPolicy,
    sessionTabGroupId,
    isCurrentlyIdle,
    lastIdleTime,
    overrideCooldowns
  };
}

export { reloadConfig, loadConfig, createHistoryEntry, triggerIntervention, isTrackableUrl };

// Revival must finish an interrupted deletion before configuration or migration
// can collect, restore an alarm, or write anything personal.
registerErrorLogAuthority(applyStorageCommand);
let authorityReady = initializeStorageAuthority(fencePrivateState);
authorityReady.then(async () => {
  await migrateKeys(getStorageGeneration());
  await loadConfig();
}).catch(() => { fencePrivateState(); });
