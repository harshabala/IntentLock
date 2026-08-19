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
import { logError, ERROR_TYPES } from './error-log.js';
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
  ACTIVE_SESSION_RETENTION_MS,
  sanitizeSessionHistory,
  sanitizeUrl,
  SESSION_RETENTION_MS,
  MAX_SESSION_HISTORY,
} from './privacy-utils.js';
import {
  beginStorageDeletion,
  completeStorageDeletion,
  endStorageDeletion,
  enqueueStorageMutation,
  getStorageMutationGeneration,
  getStorageGeneration,
  isStorageDeletionActive,
  runWithStorageGeneration,
  StorageGenerationError,
  writeDeletionTombstone,
  writeStorageClear,
  writeStorageRemove,
  writeStorageSet,
  waitForStorageDeletionWork,
} from './storage-queue.js';

registerBackoffCallback((until) => {
  const generation = getStorageGeneration();
  void enqueueStorageMutation(() => {
    if (generation !== getStorageGeneration() || isStorageDeletionActive()) return;
    return storageSet({ llmBackoffUntil: until }, generation);
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
let relatedDomainMarksSessionId = null;

const OVERRIDE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const overrideCooldowns = new Map(); // domain -> cooldown expiry timestamp
const contentEventBuckets = new Map();
const CONTENT_EVENT_WINDOW_MS = 60_000;
const MAX_CONTENT_EVENTS_PER_WINDOW = 120;
let configPromise = null;

const INTERVENTION_STATE_KEY = 'interventionStates';
const COMPLETED_TRANSITION_KEY = 'completedInterventionTransitions';
const MAX_COMPLETED_TRANSITIONS = 100;
const SESSION_SCOPED_STORAGE_KEYS = [
  'activeSession',
  'overrideCooldowns',
  'relatedDomainMarks',
  'sessionTabGroupId',
  'isCurrentlyIdle',
  'lastIdleTime',
  INTERVENTION_STATE_KEY,
  'interventionState',
  COMPLETED_TRANSITION_KEY,
  'llmBackoffUntil',
  'pendingSession',
  'pendingDeletion',
  'deletionPending',
  'sessionMetadata',
  'sessionDeletionPending',
  'activeSessionMetadata',
];

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result || {});
    });
  });
}

function storageSet(values, expectedGeneration = getStorageMutationGeneration(), options = {}) {
  return writeStorageSet(values, chrome.storage.local, expectedGeneration, options);
}

function storageRemove(keys, expectedGeneration = getStorageMutationGeneration(), options = {}) {
  return writeStorageRemove(keys, chrome.storage.local, expectedGeneration, options);
}

function storageClear(expectedGeneration = getStorageMutationGeneration()) {
  return storageRemove([
    'activeSession',
    'sessionHistory',
    'trackingEnabled',
    'customDistractionSites',
    'sessionTabGroupId',
    'isCurrentlyIdle',
    'lastIdleTime',
    'overrideCooldowns',
    'interventionStates',
    'interventionState',
    'completedInterventionTransitions',
    'errorLog',
    'activationState',
    'llmProviderConfig',
    'llmApiKey',
    'openaiApiKey',
    'llmBackoffUntil',
    'pendingSession',
    'pendingDeletion',
    'deletionPending',
    'sessionMetadata',
    'sessionDeletionPending',
    'activeSessionMetadata',
    'heuristicPolicy',
    'relatedDomainMarks',
    'theme',
    'hasSeenOnboarding',
  ], expectedGeneration, { mode: 'during-deletion' });
}

function storageSessionClear(expectedGeneration = getStorageMutationGeneration()) {
  if (typeof chrome.storage.session?.clear !== 'function') return Promise.resolve();
  return writeStorageClear(chrome.storage.session, expectedGeneration, { mode: 'during-deletion' });
}

class SessionMutationCancelledError extends Error {
  constructor() {
    super('Session mutation cancelled because storage deletion is in progress.');
    this.name = 'SessionMutationCancelledError';
    this.code = 'SESSION_MUTATION_CANCELLED';
  }
}

class FinalDwellFlushError extends Error {
  constructor(failures) {
    super(`Final dwell flush failed for ${failures.length} tab${failures.length === 1 ? '' : 's'}.`);
    this.name = 'FinalDwellFlushError';
    this.code = 'FINAL_DWELL_FLUSH_FAILED';
    this.failures = failures;
  }
}

function enqueueSessionMutation(operation, expectedGeneration = getStorageGeneration()) {
  return enqueueStorageMutation(() => {
    if (expectedGeneration !== getStorageGeneration() || isStorageDeletionActive()) {
      throw new SessionMutationCancelledError();
    }
    return runWithStorageGeneration(expectedGeneration, operation);
  });
}

function interventionKey(sessionId, tabId) {
  return `${sessionId}:${tabId ?? 'fallback'}`;
}

function cloneInterventionStates(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, state]) => [
    key,
    state && typeof state === 'object'
      ? {
        ...state,
        originalUrl: sanitizeUrl(state.originalUrl),
      }
      : state,
  ]));
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

const FINAL_DWELL_FLUSH_TIMEOUT_MS = 1_000;
const FINAL_DWELL_QUERY_TIMEOUT_MS = 250;
const MAX_FLUSH_RECEIPTS = 200;

function sendTabMessageBounded(tabId, message, timeoutMs = FINAL_DWELL_FLUSH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(result);
    };
    const timeoutId = setTimeout(() => finish({ response: null, error: new Error('Tab flush timed out.') }), timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        const error = chrome.runtime.lastError;
        finish({ response, error: error ? new Error(error.message) : null });
      });
    } catch (error) {
      finish({ response: null, error });
    }
  });
}

async function flushTrackedTabs(sessionId, expectedGeneration) {
  if (!sessionId || expectedGeneration !== getStorageGeneration() || isStorageDeletionActive()) return;
  let tabs;
  try {
    tabs = await queryTabsBounded({}, FINAL_DWELL_QUERY_TIMEOUT_MS);
  } catch (error) {
    throw new FinalDwellFlushError([{
      tabId: null,
      message: error?.message || 'Tab query timed out.',
    }]);
  }
  if (expectedGeneration !== getStorageGeneration() || isStorageDeletionActive()) {
    throw new FinalDwellFlushError([{
      tabId: null,
      message: 'Final dwell session changed while querying tabs.',
    }]);
  }
  const flushTabs = (Array.isArray(tabs) ? tabs : [])
    .filter((tab) => Number.isInteger(tab?.id) && isTrackableUrl(tab.url));
  const flushRequests = flushTabs.map((tab) => ({
    tab,
    requestId: `${sessionId}:${tab.id}:${createNonce()}`,
  }));
  const results = await Promise.all(flushRequests.map(({ tab, requestId }) => {
    return sendTabMessageBounded(tab.id, {
      type: 'FLUSH_DWELL',
      sessionId,
      generation: expectedGeneration,
      requestId,
    });
  }));
  const failures = results.reduce((failed, result, index) => {
    const response = result?.response;
    const { tab, requestId } = flushRequests[index];
    const acknowledged = !result?.error &&
      response?.status === 'ok' &&
      response.persisted === true &&
      response.sessionId === sessionId &&
      response.generation === expectedGeneration &&
      response.requestId === requestId;
    const noReceiver = !response && isMissingContentScriptError(result?.error);
    const inactiveTracker = response?.status === 'error' &&
      /page tracking is not active/i.test(response.message || '');
    if (!acknowledged && !noReceiver && !inactiveTracker) {
      failed.push({
        tabId: tab.id,
        message: result?.error?.message || response?.message || 'Persistence was not acknowledged.',
      });
    }
    return failed;
  }, []);
  if (failures.length > 0) throw new FinalDwellFlushError(failures);
}

async function flushBeforeFinalization(expectedSessionId, expectedGeneration) {
  const result = await storageGet(['activeSession']);
  const session = result.activeSession;
  if (!session?.isActive || (expectedSessionId && session.id !== expectedSessionId)) return;
  await flushTrackedTabs(session.id, expectedGeneration);
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

function queryTabsBounded(queryInfo, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      callback(value);
    };
    timeoutId = setTimeout(() => finish(reject, new Error('Tab query timed out.')), timeoutMs);
    try {
      chrome.tabs.query(queryInfo, (tabs) => {
        if (chrome.runtime.lastError) {
          finish(reject, new Error(chrome.runtime.lastError.message));
          return;
        }
        finish(resolve, tabs || []);
      });
    } catch (error) {
      finish(reject, error);
    }
  });
}

function isMissingContentScriptError(error) {
  return /receiving end does not exist|could not establish connection|no tab with id/i
    .test(error?.message || '');
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
  const sanitizedStates = Object.fromEntries(Object.entries(states).map(([key, state]) => [
    key,
    state && typeof state === 'object'
      ? {
        ...state,
        originalUrl: sanitizeUrl(state.originalUrl),
      }
      : state,
  ]));
  const entries = Object.keys(sanitizedStates);
  if (entries.length === 0) {
    await storageRemove(INTERVENTION_STATE_KEY);
  } else {
    await storageSet({ [INTERVENTION_STATE_KEY]: sanitizedStates });
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
  if (!currentSession?.id || relatedDomainMarksSessionId !== currentSession.id) return [];
  return Object.keys(relatedDomainMarks || {});
}

function readScopedRelatedMarks(value, sessionId) {
  if (!value || typeof value !== 'object' || value.sessionId !== sessionId) return {};
  return value.marks && typeof value.marks === 'object' && !Array.isArray(value.marks)
    ? value.marks
    : {};
}

function createHistoryEntry(session) {
  const events = sanitizeSessionEvents(session).events;
  const metrics = ensureMetrics(session);
  const overrides = events
    .filter(e => e.actionType === 'OVERRIDE' && (!e.url || isTrackableUrl(e.url)))
    .map(e => ({
      timestamp: e.timestamp || 0,
      hostname: e.url ? extractDomain(e.url) : null,
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

function hasSupportedEventUrls(event) {
  if (!event || typeof event !== 'object') return false;
  return ['url', 'previousUrl', 'navigationUrl'].every((key) => (
    event[key] == null || isTrackableUrl(event[key])
  ));
}

function isAbandonedActiveSession(session, now = Date.now()) {
  return Boolean(
    session?.isActive === true
    && Number.isFinite(session.startTime)
    && now - session.startTime > ACTIVE_SESSION_RETENTION_MS,
  );
}

function sanitizeSessionEvents(session) {
  if (!session || typeof session !== 'object') return session;
  if (isAbandonedActiveSession(session)) return null;
  const events = Array.isArray(session.events) ? session.events : [];
  return {
    ...session,
    events: events
      .filter(hasSupportedEventUrls)
      .map((event) => {
        const sanitized = { ...event };
        ['url', 'previousUrl', 'navigationUrl'].forEach((key) => {
          if (sanitized[key] !== undefined) sanitized[key] = sanitizeUrl(sanitized[key]);
        });
        delete sanitized.pageTitle;
        delete sanitized.title;
        return sanitized;
      }),
  };
}

function hasUnsupportedSessionEvents(session) {
  return Array.isArray(session?.events)
    && session.events.some((event) => (
      !hasSupportedEventUrls(event)
      || event.pageTitle !== undefined
      || event.title !== undefined
      || ['url', 'previousUrl', 'navigationUrl'].some((key) => (
        event[key] !== undefined && event[key] !== sanitizeUrl(event[key])
      ))
    ));
}

// Idle tracking
let lastIdleTime = 0;
let isCurrentlyIdle = false;
chrome.idle.setDetectionInterval(180); // 3 minutes

function broadcastIdleState(isIdle) {
  if (typeof chrome.tabs?.query === 'function') {
    chrome.tabs.query({}, (tabs) => {
      (tabs || []).forEach((tab) => {
        if (!Number.isInteger(tab.id)) return;
        chrome.tabs.sendMessage?.(tab.id, { type: 'IDLE_STATE', idle: isIdle }, () => {
          void chrome.runtime.lastError;
        });
      });
    });
  }
}

chrome.idle.onStateChanged.addListener((newState) => {
  const isIdle = (newState === 'idle' || newState === 'locked');
  storageGet(['trackingEnabled']).then((result) => {
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
  }).catch((error) => {
    console.error('Idle state storage read failed:', error);
  });
});

// Helper for trackable URLs
function isTrackableUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// Helper to extract bare hostname from a URL
function extractDomain(url) {
  if (!isTrackableUrl(url)) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function openSessionReportTab() {
  chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html?report=last') });
}

function handleReportViewed(sessionId, sendResponse, expectedGeneration = getStorageGeneration()) {
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
  }, expectedGeneration);
  operation.then((response) => sendResponse?.(response), (error) => {
    sendResponse?.({
      status: 'error',
      ...(error?.code ? { code: error.code } : {}),
      message: error?.message || 'Unable to update the session report.',
    });
  });
}

// Centralized Session Ending Logic
async function finalizeActiveSession(reflection = null, expectedSessionId = null) {
    const result = await storageGet(['activeSession', 'sessionHistory']);
    const session = result.activeSession
      ? {
        ...sanitizeSessionEvents(result.activeSession),
        metrics: result.activeSession.metrics ? { ...result.activeSession.metrics } : undefined,
      }
      : null;
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
    await storageRemove([
      'activeSession',
      INTERVENTION_STATE_KEY,
      'interventionState',
      'overrideCooldowns',
      'relatedDomainMarks',
    ]);
    hideInterventionsFromTabs();
    let cleanupWarning = null;
    try {
      await clearTabGroupState();
    } catch (error) {
      cleanupWarning = error?.message || 'Unable to clear the session tab group.';
    }
    currentSession = null;
    relatedDomainMarks = {};
    relatedDomainMarksSessionId = null;
    clearDriftDebounce();
    overrideCooldowns.clear();
    chrome.alarms.clear(timeBudgetAlarmName);
    if (cleanupWarning) session.cleanupWarning = cleanupWarning;
    return session;
}

function endActiveSession(
  reflection = null,
  callback = null,
  expectedSessionId = null,
  expectedGeneration = getStorageGeneration(),
) {
  const operation = flushBeforeFinalization(expectedSessionId, expectedGeneration)
    .then(() => enqueueSessionMutation(
      () => finalizeActiveSession(reflection, expectedSessionId),
      expectedGeneration,
    ));
  if (callback) operation.then(callback, () => callback(null));
  return operation;
}

async function getInterventionStateForTab(tabId) {
  if (!Number.isInteger(tabId)) return null;
  const result = await storageGet(['activeSession', INTERVENTION_STATE_KEY, 'trackingEnabled']);
  if (result.trackingEnabled === false) return null;
  if (!result.activeSession?.isActive) return null;
  const state = stateForTab(
    cloneInterventionStates(result[INTERVENTION_STATE_KEY]),
    tabId,
    result.activeSession.id,
  );
  if (!state) return null;
  if (state.intent !== undefined) return state;
  return {
    ...state,
    intent: state.intent ?? result.activeSession.intent ?? '',
  };
}

function findStateEntry(states, state) {
  return Object.entries(states).find(([, candidate]) => candidate === state)?.[0] || null;
}

async function handleInterventionTransition(message, sender, expectedGeneration = getStorageGeneration()) {
  const tabId = Number.isInteger(sender?.tab?.id) ? sender.tab.id : message.tabId;
  if (!Number.isInteger(tabId)) {
    return { ok: false, error: 'Intervention transitions require a tab.' };
  }

  if (message.transition === 'end-session') {
    await flushBeforeFinalization(message.sessionId, expectedGeneration);
  }

  return enqueueSessionMutation(async () => {
    const result = await storageGet([
      'activeSession',
      INTERVENTION_STATE_KEY,
      'relatedDomainMarks',
      COMPLETED_TRANSITION_KEY,
      'trackingEnabled',
    ]);
    const session = sanitizeSessionEvents(result.activeSession);
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

    const reflection = typeof message.reflection === 'string' ? message.reflection.trim() : '';
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
        const marks = {
          ...readScopedRelatedMarks(result.relatedDomainMarks, session.id),
          ...(relatedDomainMarksSessionId === session.id ? relatedDomainMarks : {}),
        };
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
        relatedDomainMarksSessionId = session.id;
        values.relatedDomainMarks = { sessionId: session.id, marks };
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
  }, expectedGeneration);
}

function handleSessionCleared(sendResponse) {
  // Advance the generation before entering the queue so already-created
  // logging/finalization operations cannot write after this deletion.
  const generation = beginStorageDeletion();
  writeDeletionTombstone(generation, true).then((started) => {
    if (!started) throw new StorageGenerationError('Unable to establish the deletion barrier.');
    chrome.runtime.sendMessage?.({ type: 'DATA_DELETION_STARTED', generation }, () => {
      void chrome.runtime.lastError;
    });
    hideInterventionsFromTabs();
    enqueueStorageMutation(async () => {
      try {
        await runWithStorageGeneration(generation, async () => {
          await waitForStorageDeletionWork();
          await storageClear(generation);
          await storageSessionClear(generation);
          currentSession = null;
          trackingEnabled = true;
          customDistractionSites = [...DEFAULT_DISTRACTION_SITES];
          sessionTabGroupId = null;
          heuristicPolicy = null;
          isCurrentlyIdle = false;
          lastIdleTime = 0;
          relatedDomainMarks = {};
          relatedDomainMarksSessionId = null;
          overrideCooldowns.clear();
          contentEventBuckets.clear();
          clearDriftCache();
          clearDriftDebounce();
          clearLlmBackoff();
          await clearTabGroupState();
          chrome.alarms.clear(timeBudgetAlarmName);
          configPromise = null;
        });
        if (!await completeStorageDeletion(generation)) {
          throw new StorageGenerationError('Deletion was superseded by a newer storage generation.');
        }
        endStorageDeletion(generation);
        await loadConfig();
        chrome.runtime.sendMessage?.({ type: 'DATA_DELETED', generation }, () => {
          void chrome.runtime.lastError;
        });
        sendResponse({ status: 'ok' });
      } catch (error) {
        await writeDeletionTombstone(generation, false).catch(() => {});
        endStorageDeletion(generation);
        chrome.runtime.sendMessage?.({
          type: 'DATA_DELETION_FAILED',
          generation,
          message: error.message || 'Unable to delete IntentLock data.',
        }, () => {
          void chrome.runtime.lastError;
        });
        sendResponse({ status: 'error', message: error.message || 'Unable to delete IntentLock data.' });
      }
    });
  }).catch((error) => {
    endStorageDeletion(generation);
    chrome.runtime.sendMessage?.({
      type: 'DATA_DELETION_FAILED',
      generation,
      message: error.message || 'Unable to delete IntentLock data.',
    }, () => {
      void chrome.runtime.lastError;
    });
    sendResponse({ status: 'error', message: error.message || 'Unable to delete IntentLock data.' });
  });
}

// ── Keyboard shortcut ──────────────────────────────────────────────────

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-session') {
    storageGet(['activeSession']).then((result) => {
      const session = result.activeSession;
      if (session && session.isActive) {
        endActiveSession(null, () => {
          chrome.runtime.sendMessage({ type: 'SESSION_CLEARED' });
          openSessionReportTab();
        });
      } else {
        chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html') });
      }
    }).catch((error) => {
      console.error('Toggle session storage read failed:', error);
    });
  }
});

// ── Message handling ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handledMessages = [
    'SESSION_STARTED', 'OVERRIDE_INTERVENTION', 'GET_SESSION',
    'CONFIG_UPDATED', 'SESSION_CLEARED', 'DELETE_ALL_DATA', 'END_ACTIVE_SESSION', 'LOG_ERROR',
    'CONTENT_EVENT', 'GET_INTERVENTION_STATE', 'INTERVENTION_TRANSITION',
    'TEST_INTERVENTION', 'REPORT_VIEWED', 'UPDATE_SESSION_INTENT', 'EDIT_INTENT', 'UPDATE_INTENT'
  ];
  if (!message || typeof message !== 'object' || !handledMessages.includes(message.type)) {
    return false;
  }

  if (message.type === 'DELETE_ALL_DATA') {
    handleSessionCleared(sendResponse);
    return true;
  }

  const requestGeneration = getStorageGeneration();
  loadConfig().then(() => {
    if (message.type === 'SESSION_STARTED') {
      handleSessionStart(message.session, requestGeneration).then(() => {
        sendResponse({ status: 'ok' });
      }, (error) => {
        sendResponse({
          status: 'error',
          ...(error?.code ? { code: error.code } : {}),
          message: error.message || 'Unable to start the session.',
        });
      });
    } else if (['UPDATE_SESSION_INTENT', 'EDIT_INTENT', 'UPDATE_INTENT'].includes(message.type)) {
      updateSessionIntent(message.intent, message.sessionId, requestGeneration).then((session) => {
        sendResponse({ status: 'ok', session });
      }, (error) => {
        sendResponse({
          status: 'error',
          ...(error?.code ? { code: error.code } : {}),
          message: error.message || 'Unable to update the session intent.',
        });
      });
    } else if (message.type === 'OVERRIDE_INTERVENTION') {
      handleOverride(message.sessionData, requestGeneration).then(() => {
        sendResponse({ status: 'ok' });
      }, (error) => {
        sendResponse({
          status: 'error',
          ...(error?.code ? { code: error.code } : {}),
          message: error.message || 'Unable to apply the override.',
        });
      });
    } else if (message.type === 'GET_SESSION') {
      // Return the latest from storage if in-memory is null
      if (currentSession) {
        sendResponse({ session: currentSession });
      } else {
        storageGet(['activeSession']).then((result) => {
          sendResponse({ session: result.activeSession || null });
        }, (error) => {
          sendResponse({ status: 'error', message: error.message || 'Unable to read the active session.' });
        });
      }
    } else if (message.type === 'GET_INTERVENTION_STATE') {
      const requestedTabId = Number.isInteger(sender.tab?.id) ? sender.tab.id : message.tabId;
      getInterventionStateForTab(requestedTabId).then((state) => {
        sendResponse({ ok: true, state });
      }, (error) => {
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
        await clearTabGroupState();
        currentSession = null;
        clearDriftCache();
        clearDriftDebounce();
        clearLlmBackoff();
        overrideCooldowns.clear();
        await storageRemove([
          INTERVENTION_STATE_KEY,
          'interventionState',
          'overrideCooldowns',
          COMPLETED_TRANSITION_KEY,
          'relatedDomainMarks',
          'llmBackoffUntil',
        ]);
        configPromise = null;
        relatedDomainMarks = {};
        relatedDomainMarksSessionId = null;
        await loadConfig();
        return { status: 'ok' };
      }, requestGeneration).then(sendResponse, (error) => {
        sendResponse({
          status: 'error',
          ...(error?.code ? { code: error.code } : {}),
          message: error?.message || 'Unable to clear the completed session state.',
        });
      });
    } else if (message.type === 'END_ACTIVE_SESSION') {
      endActiveSession(
        message.reflection,
        null,
        message.sessionId || null,
        requestGeneration,
      ).then(async (endedSession) => {
        if (!endedSession) {
          if (!message.sessionId && Number.isInteger(sender?.tab?.id)) {
            const latest = await storageGet([COMPLETED_TRANSITION_KEY]);
            const alreadyFinalized = Object.values(cloneInterventionStates(latest[COMPLETED_TRANSITION_KEY]))
              .some((transition) => transition?.tabId === sender.tab.id);
            if (alreadyFinalized) {
              sendResponse({ status: 'ok', session: null, idempotent: true });
              return;
            }
          }
          sendResponse({ status: 'error', message: 'There is no matching active session to end.' });
          return;
        }
        sendResponse({ status: 'ok', session: endedSession });
      }, (error) => {
        sendResponse({
          status: 'error',
          ...(error?.code ? { code: error.code } : {}),
          message: error.message || 'Unable to end the active session.',
        });
      });
    } else if (message.type === 'REPORT_VIEWED') {
      handleReportViewed(message.sessionId, sendResponse, requestGeneration);
    } else if (message.type === 'LOG_ERROR') {
      logError(message.payload || {}).then(() => {
        sendResponse({ status: 'ok' });
      });
    } else if (message.type === 'CONTENT_EVENT') {
      Promise.resolve(handleContentEvent(message.payload, sender.tab?.id, requestGeneration))
        .then((result) => {
          if (result?.flushAck) {
            sendResponse({
              status: result.flushAck.persisted ? 'ok' : 'error',
              ...result.flushAck,
            });
            return;
          }
          sendResponse({ status: 'ok' });
        }, (error) => {
          sendResponse({ status: 'error', message: error?.message || 'Content event persistence failed.' });
        });
    } else if (message.type === 'INTERVENTION_TRANSITION') {
      handleInterventionTransition(message, sender, requestGeneration).then((result) => {
        sendResponse(result);
      }, (error) => {
        sendResponse({
          ok: false,
          ...(error?.code ? { code: error.code } : {}),
          error: error.message || 'Intervention transition failed.',
        });
      });
    } else if (message.type === 'TEST_INTERVENTION') {
      storageGet(['activeSession', 'trackingEnabled']).then((result) => {
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
          triggerIntervention(
            'Test intervention — drift detection is working.',
            activeTab?.id || null,
            requestGeneration,
          );
          sendResponse({ ok: true });
        });
      }, (error) => {
        sendResponse({ ok: false, error: error.message || 'Unable to read the active session.' });
      });
    }
  }).catch((error) => {
    sendResponse({
      status: 'error',
      ...(error?.code ? { code: error.code } : {}),
      message: error?.message || 'Unable to load session state.',
    });
  });
  return true; // Keep channel open for async response
});

// ── Config loading ─────────────────────────────────────────────────────

function loadConfig() {
  if (configPromise) return configPromise;
  const generation = getStorageGeneration();
  const pendingConfigPromise = new Promise((resolve, reject) => {
    chrome.storage.local.get([
      'activeSession', 'trackingEnabled', 'customDistractionSites',
      'sessionTabGroupId', 'isCurrentlyIdle', 'lastIdleTime',
      'overrideCooldowns', 'heuristicPolicy', 'llmBackoffUntil',
      'relatedDomainMarks', 'sessionHistory'
    ], (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const data = result || {};
      if (generation !== getStorageGeneration() || isStorageDeletionActive()) {
        resolve();
        return;
      }
      if (Array.isArray(data.sessionHistory)) {
        void enqueueStorageMutation(() => {
          if (generation !== getStorageGeneration() || isStorageDeletionActive()) return;
          return storageSet({
            sessionHistory: sanitizeSessionHistory(data.sessionHistory, {
              retentionMs: SESSION_RETENTION_MS,
              maxEntries: MAX_SESSION_HISTORY,
            }),
          }, generation);
        });
      }
      let activeSessionPersistence = null;
      if (data.activeSession && data.activeSession.isActive) {
        currentSession = sanitizeSessionEvents(data.activeSession);
        if (!currentSession) {
          activeSessionPersistence = enqueueStorageMutation(() => {
            if (generation !== getStorageGeneration() || isStorageDeletionActive()) return;
            return storageRemove(SESSION_SCOPED_STORAGE_KEYS, generation);
          });
        } else {
          ensureMetrics(currentSession);
        }
        if (currentSession && hasUnsupportedSessionEvents(data.activeSession)) {
          activeSessionPersistence = enqueueStorageMutation(() => {
            if (generation !== getStorageGeneration() || isStorageDeletionActive()) return;
            return storageSet({ activeSession: currentSession }, generation);
          });
        }

        // Restore time budget alarm if session has a time budget
        if (currentSession?.timeBudget) {
          const elapsedMinutes = (Date.now() - currentSession.startTime) / 60000;
          const remainingMinutes = currentSession.timeBudget - elapsedMinutes;
          if (remainingMinutes > 0) {
            chrome.alarms.create(timeBudgetAlarmName, { 
              when: currentSession.startTime + (currentSession.timeBudget * 60000) 
            });
          } else {
            void triggerIntervention("Time budget exceeded. Are you still working on your intent?").catch(() => {});
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
        void enqueueStorageMutation(() => {
          if (generation !== getStorageGeneration() || isStorageDeletionActive()) return;
          return storageSet({ heuristicPolicy }, generation);
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
      if (currentSession?.id && data.relatedDomainMarks?.sessionId === currentSession.id) {
        relatedDomainMarks = readScopedRelatedMarks(data.relatedDomainMarks, currentSession.id);
        relatedDomainMarksSessionId = currentSession.id;
      } else {
        relatedDomainMarks = {};
        relatedDomainMarksSessionId = null;
      }
      if (activeSessionPersistence) {
        activeSessionPersistence.then(() => resolve(), () => resolve());
      } else {
        resolve();
      }
    });
  });
  const trackedConfigPromise = pendingConfigPromise.catch((error) => {
    if (configPromise === trackedConfigPromise) configPromise = null;
    throw error;
  });
  configPromise = trackedConfigPromise;
  return trackedConfigPromise;
}

function reloadConfig() {
  configPromise = null;
  return loadConfig();
}
loadConfig().catch((error) => {
  console.error('Initial config load failed:', error);
});

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
    void reloadConfig().catch((error) => {
      console.error('Tracking config reload failed:', error);
    });
  }
});

function storageAreaGet(area, keys) {
  if (!area?.get) return Promise.resolve({});
  return new Promise((resolve, reject) => {
    area.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result || {});
    });
  });
}

export async function migrateLlmStorage() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;

  const generation = getStorageGeneration();
  const migrationStillCurrent = () => (
    generation === getStorageGeneration() && !isStorageDeletionActive()
  );
  const localRes = await storageAreaGet(chrome.storage.local, ['llmApiKey', 'openaiApiKey']);
  if (!migrationStillCurrent()) return;

  const session = chrome.storage.session;
  const sessionRes = await storageAreaGet(session, ['openaiApiKey', 'llmApiKey']);
  if (!migrationStillCurrent()) return;

  const localRemovals = ['llmApiKey', 'openaiApiKey']
    .filter((key) => localRes?.[key] !== undefined);
  const sessionRemovals = sessionRes?.openaiApiKey !== undefined ? ['openaiApiKey'] : [];
  const existingSessionKey = sessionRes?.llmApiKey || null;
  const legacyKey = existingSessionKey
    || sessionRes?.openaiApiKey
    || localRes?.llmApiKey
    || localRes?.openaiApiKey;

  if (session?.set && legacyKey && !existingSessionKey) {
    await writeStorageSet({ llmApiKey: legacyKey }, session, generation);
  }
  if (session?.remove && sessionRemovals.length > 0) {
    await writeStorageRemove(sessionRemovals, session, generation);
  }
  // Local aliases are always removed, including when session storage is not
  // available. Without a session area the key remains memory-only/absent.
  if (localRemovals.length > 0) {
    await storageRemove(localRemovals, generation);
  }
}
void migrateLlmStorage().catch((error) => {
  console.warn('LLM key migration failed:', error);
});

// ── Session start ──────────────────────────────────────────────────────

function handleSessionStart(session, expectedGeneration = getStorageGeneration()) {
  return enqueueSessionMutation(async () => {
    if (!session || typeof session !== 'object' || !session.id) {
      throw new Error('A valid session is required.');
    }
    if (session.isActive !== true) {
      overrideCooldowns.clear();
      await storageRemove(['overrideCooldowns']);
      throw new Error('A valid active session is required.');
    }
    const latest = await storageGet(['activeSession', 'trackingEnabled']);
    if (latest.trackingEnabled === false) {
      throw new Error('Tracking is disabled.');
    }
    if (sanitizeSessionEvents(latest.activeSession)?.isActive) {
      throw new Error('An active session already exists.');
    }
    const nextSession = {
      ...sanitizeSessionEvents(session),
      generation: expectedGeneration,
    };
    ensureMetrics(nextSession);
    if (!nextSession.metrics || nextSession.metrics.activeMs == null) {
      nextSession.metrics = createSessionMetrics();
    }
    clearDriftCache();
    clearDriftDebounce();
    clearLlmBackoff();
    await storageRemove(['llmBackoffUntil']);
    overrideCooldowns.clear(); // clear cooldowns on new session
    await storageRemove(['overrideCooldowns']);
    relatedDomainMarks = {};
    relatedDomainMarksSessionId = nextSession.id;
    await storageRemove(['relatedDomainMarks']);
    await storageSet({ activeSession: nextSession });
    currentSession = nextSession;

    chrome.alarms.clear(timeBudgetAlarmName);

    if (nextSession.timeBudget) {
      chrome.alarms.create(timeBudgetAlarmName, {
        when: nextSession.startTime + (nextSession.timeBudget * 60000)
      });
    }

    await createTabGroup(nextSession.intent);
    return nextSession;
  }, expectedGeneration);
}

function updateSessionIntent(intent, expectedSessionId, expectedGeneration = getStorageGeneration()) {
  return enqueueSessionMutation(async () => {
    const nextIntent = typeof intent === 'string' ? intent.trim() : '';
    if (!nextIntent || nextIntent.length > 250) {
      throw new Error('Intent must be between 1 and 250 characters.');
    }
    const latest = await storageGet(['activeSession', 'trackingEnabled']);
    const session = sanitizeSessionEvents(latest.activeSession);
    if (latest.trackingEnabled === false) {
      throw new Error('Tracking is disabled.');
    }
    if (!session?.isActive || !expectedSessionId || session.id !== expectedSessionId) {
      throw new Error('The active session is stale or no longer exists.');
    }
    const updatedSession = {
      ...session,
      intent: nextIntent,
    };
    await storageSet({ activeSession: updatedSession });
    currentSession = updatedSession;
    return updatedSession;
  }, expectedGeneration);
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
    void ungroupTabs().catch(() => {}); // Group closed, cleanup state
    return;
  }
  try {
    await chrome.tabs.group({ tabIds: [tabId], groupId: sessionTabGroupId });
  } catch (e) {
    console.warn("Could not group tab (likely closed):", e);
  }
}

async function clearTabGroupState() {
  sessionTabGroupId = null;
  await storageRemove(
    'sessionTabGroupId',
    getStorageMutationGeneration(),
    isStorageDeletionActive() ? { mode: 'during-deletion' } : {},
  );
}

function ungroupTabs() {
  return enqueueSessionMutation(() => clearTabGroupState());
}

// ── Time budget alarm ──────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === timeBudgetAlarmName) {
    loadConfig().then(() => {
      storageGet(['activeSession', 'trackingEnabled']).then((result) => {
        if (result.trackingEnabled === false) return;
        const session = result.activeSession;
        if (session && session.isActive) {
          void triggerIntervention("Time budget exceeded. Are you still working on your intent?").catch(() => {});
        }
      }).catch((error) => {
        console.error('Alarm storage read failed:', error);
      });
    }).catch((error) => {
      console.error('Alarm config load failed:', error);
    });
  }
});

// ── Tab monitoring ─────────────────────────────────────────────────────

function hasMeaningfulIdleSignal(session, destinationUrl, now = Date.now()) {
  const recentEvents = (Array.isArray(session?.events) ? session.events : [])
    .filter((event) => Number.isFinite(event?.timestamp) && now - event.timestamp <= 2 * 60 * 1000);
  const policy = heuristicPolicy || buildDefaultPolicy('deep_work', 'balanced');
  return recentEvents.some((event) => {
    if (!event?.url || !['PAGE_LOAD', 'SPA_NAVIGATION', 'PAGE_DWELL', 'TAB_SWITCH'].includes(event.actionType)) {
      return false;
    }
    const dwellMs = typeof event.dwellDeltaMs === 'number'
      ? event.dwellDeltaMs
      : (typeof event.dwellMs === 'number' ? event.dwellMs : 0);
    if (event.url === destinationUrl) return event.actionType === 'PAGE_DWELL' && dwellMs > 0;
    return !isUrlAligned(session.intent, event.url, policy, relatedHostnamesList());
  });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && isTrackableUrl(tab.url)) {
    loadConfig().then(() => {
      storageGet(['activeSession', 'trackingEnabled']).then((result) => {
        if (result.trackingEnabled === false) return;
        const session = result.activeSession;
        if (session && session.isActive) {
          void logEvent('PAGE_LOAD', tab.url).catch(() => {});
          addTabToGroup(tabId);
          evaluateDrift(tab.url, tabId);
        }
      }).catch((error) => {
        console.error('Tab update storage read failed:', error);
      });
    }).catch((error) => {
      console.error('Tab update config load failed:', error);
    });
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  loadConfig().then(() => {
    storageGet(['trackingEnabled', 'activeSession', 'isCurrentlyIdle', 'lastIdleTime']).then((result) => {
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
              const policy = heuristicPolicy || buildDefaultPolicy('deep_work', 'balanced');
              const destinationAligned = isUrlAligned(
                session.intent,
                tab.url,
                policy,
                relatedHostnamesList(),
              );
              const meaningfulSignal = hasMeaningfulIdleSignal(session, tab.url);
              void enqueueSessionMutation(async () => {
                const latest = await storageGet(['trackingEnabled']);
                if (latest.trackingEnabled === false) return false;
                await storageSet({ lastIdleTime: 0 });
                return true;
              }).then((reset) => {
                if (reset && !destinationAligned && meaningfulSignal) {
                  void triggerIntervention("You were idle and immediately switched context. Are you still aligned?", activeInfo.tabId).catch(() => {});
                }
              }, () => {});
              return;
            }

            evaluateDrift(tab.url, activeInfo.tabId);
          }
        });
      }
    }).catch((error) => {
      console.error('Tab activation storage read failed:', error);
    });
  }).catch((error) => {
    console.error('Tab activation config load failed:', error);
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

function logEvent(
  actionType,
  url,
  extras = {},
  expectedGeneration = getStorageGeneration(),
  expectedSessionId = null,
  flushReceiptKey = null,
) {
  return enqueueSessionMutation(async () => {
    if (!isTrackableUrl(url)) return;
    const result = await storageGet(['activeSession', 'trackingEnabled']);
    if (result.trackingEnabled === false) {
      if (expectedSessionId) throw new Error('Content event tracking is disabled.');
      return;
    }
    const session = sanitizeSessionEvents(result.activeSession);
    if (!session || !session.isActive) {
      if (expectedSessionId) throw new Error('Content event session is no longer active.');
      return;
    }
    if (expectedSessionId && session.id !== expectedSessionId) {
      throw new Error('Content event belongs to a different session.');
    }
    if (flushReceiptKey && getFlushReceipt(session, flushReceiptKey)?.eventApplied) {
      return;
    }

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
    if (flushReceiptKey) markFlushReceipt(session, flushReceiptKey, 'eventApplied');
    const persistedSession = sanitizeSessionEvents(session);
    await storageSet({ activeSession: persistedSession });
    currentSession = persistedSession;
  }, expectedGeneration);
}

function flushReceiptKey(metadata, tabId) {
  return `${metadata.requestId}:${tabId}`;
}

function getFlushReceipt(session, key) {
  const receipt = session?.flushDwellReceipts?.[key];
  return receipt && typeof receipt === 'object' ? receipt : null;
}

function markFlushReceipt(session, key, part) {
  const receipts = session.flushDwellReceipts && typeof session.flushDwellReceipts === 'object'
    && !Array.isArray(session.flushDwellReceipts)
    ? { ...session.flushDwellReceipts }
    : {};
  receipts[key] = {
    ...receipts[key],
    [part]: true,
    updatedAt: Date.now(),
  };
  const keys = Object.keys(receipts);
  if (keys.length > MAX_FLUSH_RECEIPTS) {
    keys
      .sort((a, b) => (receipts[a].updatedAt || 0) - (receipts[b].updatedAt || 0))
      .slice(0, keys.length - MAX_FLUSH_RECEIPTS)
      .forEach((receiptKey) => delete receipts[receiptKey]);
  }
  session.flushDwellReceipts = receipts;
}

function getSessionContext(payload) {
  const fields = ['sessionId', 'generation'];
  if (!fields.some(field => payload?.[field] !== undefined)) return null;
  if (
    typeof payload?.sessionId !== 'string' ||
    payload.sessionId.length === 0 ||
    payload.sessionId.length > 200 ||
    (payload.generation !== undefined && !Number.isInteger(payload.generation))
  ) {
    return { invalid: true };
  }
  return {
    sessionId: payload.sessionId,
    generation: Number.isInteger(payload.generation) ? payload.generation : null,
  };
}

function getFlushMetadata(payload) {
  if (payload?.flushRequestId === undefined) return null;
  const context = getSessionContext(payload);
  if (
    !context ||
    context.invalid ||
    payload?.actionType !== 'PAGE_DWELL' ||
    !Number.isInteger(context?.generation) ||
    typeof payload.flushRequestId !== 'string' ||
    payload.flushRequestId.length === 0 ||
    payload.flushRequestId.length > 300
  ) {
    return { invalid: true };
  }
  return {
    sessionId: context.sessionId,
    generation: context.generation,
    requestId: payload.flushRequestId,
  };
}

function getNormalReportMetadata(payload) {
  if (payload?.reportId === undefined) return null;
  const context = getSessionContext(payload);
  if (
    !context ||
    context.invalid ||
    payload?.flushRequestId !== undefined ||
    typeof payload.reportId !== 'string' ||
    payload.reportId.length === 0 ||
    payload.reportId.length > 300
  ) {
    return { invalid: true };
  }
  return {
    sessionId: context.sessionId,
    generation: context.generation,
    requestId: payload.reportId,
  };
}

function flushEventResult(metadata, persisted, message = '') {
  return {
    flushAck: {
      persisted,
      ...(metadata?.sessionId ? { sessionId: metadata.sessionId } : {}),
      ...(Number.isInteger(metadata?.generation) ? { generation: metadata.generation } : {}),
      ...(metadata?.requestId ? { requestId: metadata.requestId } : {}),
      ...(message ? { message } : {}),
    },
  };
}

function handleContentEvent(payload, tabId, expectedGeneration = getStorageGeneration()) {
  const sessionContext = getSessionContext(payload);
  const flushMetadata = getFlushMetadata(payload);
  const normalReportMetadata = getNormalReportMetadata(payload);
  const reportMetadata = flushMetadata || normalReportMetadata;
  const rejectContentEvent = (message) => Promise.resolve(
    reportMetadata ? flushEventResult(reportMetadata, false, message) : undefined,
  );
  if (sessionContext?.invalid || flushMetadata?.invalid || normalReportMetadata?.invalid) {
    return rejectContentEvent('Invalid final dwell metadata.');
  }
  if (!Number.isInteger(tabId) || !payload || typeof payload !== 'object') {
    return rejectContentEvent('Invalid content event.');
  }
  const allowedActions = new Set(['PAGE_DWELL', 'SPA_NAVIGATION', 'PAGE_LOAD', 'TAB_SWITCH']);
  if (
    typeof payload.url !== 'string' ||
    payload.url.length === 0 ||
    payload.url.length > 2048 ||
    !isTrackableUrl(payload.url) ||
    !allowedActions.has(payload.actionType) ||
    (payload.pageTitle !== undefined && (typeof payload.pageTitle !== 'string' || payload.pageTitle.length > 200)) ||
    (payload.previousUrl !== undefined && (typeof payload.previousUrl !== 'string' || payload.previousUrl.length > 2048 || !isTrackableUrl(payload.previousUrl))) ||
    (payload.navigationUrl !== undefined && (typeof payload.navigationUrl !== 'string' || payload.navigationUrl.length > 2048 || !isTrackableUrl(payload.navigationUrl))) ||
    (payload.dwellMs !== undefined && (!Number.isFinite(payload.dwellMs) || payload.dwellMs < 0 || payload.dwellMs > 86_400_000)) ||
    (payload.dwellDeltaMs !== undefined && (!Number.isFinite(payload.dwellDeltaMs) || payload.dwellDeltaMs < 0 || payload.dwellDeltaMs > 86_400_000))
  ) return rejectContentEvent('Invalid content event.');

  if (
    sessionContext && (
      (Number.isInteger(sessionContext.generation) && sessionContext.generation !== expectedGeneration) ||
      (sessionContext.generation !== null && !Number.isInteger(sessionContext.generation)) ||
      expectedGeneration !== getStorageGeneration() ||
      isStorageDeletionActive()
    )
  ) {
    return rejectContentEvent('Final dwell session is stale.');
  }

  const now = Date.now();
  const bucket = contentEventBuckets.get(tabId) || { startedAt: now, count: 0 };
  if (now - bucket.startedAt >= CONTENT_EVENT_WINDOW_MS) {
    bucket.startedAt = now;
    bucket.count = 0;
  }
  if (bucket.count >= MAX_CONTENT_EVENTS_PER_WINDOW) {
    return rejectContentEvent('Content event rate limit exceeded.');
  }
  bucket.count += 1;
  contentEventBuckets.set(tabId, bucket);

  const extras = {};
  if (payload.pageTitle) extras.pageTitle = payload.pageTitle;
  if (typeof payload.dwellMs === 'number') extras.dwellMs = payload.dwellMs;
  if (typeof payload.dwellDeltaMs === 'number') extras.dwellDeltaMs = payload.dwellDeltaMs;
  if (payload.previousUrl) extras.previousUrl = payload.previousUrl;
  if (payload.navigationUrl) extras.navigationUrl = payload.navigationUrl;
  if (flushMetadata) {
    extras.sessionId = flushMetadata.sessionId;
    extras.generation = flushMetadata.generation;
    extras.flushRequestId = flushMetadata.requestId;
  }
  const receiptKey = reportMetadata ? flushReceiptKey(reportMetadata, tabId) : null;

  // Accumulate on-intent metrics from dwell deltas (not reconstructable from capped events)
  let metricWrite = Promise.resolve();
  if (
    (payload.actionType === 'PAGE_DWELL' || payload.actionType === 'SPA_NAVIGATION') &&
    typeof payload.dwellDeltaMs === 'number' &&
    payload.dwellDeltaMs > 0
  ) {
    metricWrite = enqueueSessionMutation(async () => {
      const result = await storageGet(['activeSession', 'trackingEnabled']);
      if (result.trackingEnabled === false) {
        if (flushMetadata) throw new Error('Final dwell tracking is disabled.');
        return;
      }
      const session = sanitizeSessionEvents(result.activeSession);
      if (!session?.isActive) {
        if (flushMetadata) throw new Error('Final dwell session is no longer active.');
        return;
      }
      if (flushMetadata && session.id !== flushMetadata.sessionId) {
        throw new Error('Final dwell event belongs to a different session.');
      }
      if (sessionContext && session.id !== sessionContext.sessionId) {
        if (flushMetadata) throw new Error('Dwell event belongs to a different session.');
        return;
      }
      if (receiptKey && getFlushReceipt(session, receiptKey)?.metricsApplied) return;
      ensureMetrics(session);
      const metricUrl = payload.actionType === 'SPA_NAVIGATION'
        ? (payload.previousUrl || payload.url)
        : payload.url;
      const hostname = extractDomain(metricUrl);
      const aligned = isUrlAligned(
        session.intent,
        metricUrl,
        heuristicPolicy,
        relatedHostnamesList()
      );
      session.metrics = applyDwellDelta(session.metrics, {
        hostname,
        deltaMs: payload.dwellDeltaMs,
        aligned,
      });
      if (receiptKey) markFlushReceipt(session, receiptKey, 'metricsApplied');
      await storageSet({ activeSession: session });
      currentSession = session;
    }, expectedGeneration);
    if (!flushMetadata) {
      metricWrite = metricWrite.catch((error) => {
        if (error?.code === 'SESSION_MUTATION_CANCELLED') return;
        throw error;
      });
    }
  }

  let eventWrite = logEvent(
    payload.actionType,
    payload.url,
    extras,
    expectedGeneration,
    sessionContext?.sessionId || null,
    receiptKey,
  );
  if (!flushMetadata) {
    eventWrite = eventWrite.catch((error) => {
      if (error?.code === 'SESSION_MUTATION_CANCELLED') return;
      throw error;
    });
  }

  return Promise.allSettled([metricWrite, eventWrite]).then((results) => {
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
    if (flushMetadata) return flushEventResult(flushMetadata, true);
    if (payload.actionType === 'PAGE_DWELL' || payload.actionType === 'SPA_NAVIGATION') {
      evaluateDrift(
        payload.actionType === 'SPA_NAVIGATION' ? (payload.navigationUrl || payload.url) : payload.url,
        tabId,
        expectedGeneration,
        { skipLlm: payload.actionType === 'PAGE_DWELL', transientEvent: payload },
      );
    }
  });
}

// ── Drift evaluation ───────────────────────────────────────────────────

const DRIFT_DEBOUNCE_MS = 5000;
export const MAX_DRIFT_DEBOUNCE_ENTRIES = 512;
const driftDebounce = new Map();

function clearDriftDebounce() {
  driftDebounce.clear();
}

function rememberDriftEvaluation(key, timestamp) {
  driftDebounce.delete(key);
  driftDebounce.set(key, timestamp);
  while (driftDebounce.size > MAX_DRIFT_DEBOUNCE_ENTRIES) {
    driftDebounce.delete(driftDebounce.keys().next().value);
  }
}

export function getDriftDebounceSize() {
  return driftDebounce.size;
}

function evaluateDrift(
  url,
  tabId,
  expectedGeneration = getStorageGeneration(),
  { skipLlm = false, transientEvent = null } = {},
) {
  if (!isTrackableUrl(url)) return;
  chrome.storage.local.get(['activeSession', 'customDistractionSites', 'trackingEnabled'], (result) => {
    if (expectedGeneration !== getStorageGeneration() || isStorageDeletionActive()) return;
    if (chrome.runtime.lastError) return;
    if (result.trackingEnabled === false) return;
    const session = sanitizeSessionEvents(result.activeSession);
    if (!session || !session.isActive) return;

    const now = Date.now();
    const debounceKey = `${session.id}:${Number.isInteger(tabId) ? tabId : 'fallback'}:${url}`;
    const lastEvaluatedTime = driftDebounce.get(debounceKey) || 0;
    if ((now - lastEvaluatedTime) < DRIFT_DEBOUNCE_MS) {
      return;
    }
    rememberDriftEvaluation(debounceKey, now);

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
        void enqueueSessionMutation(async () => {
          await storageSet({ overrideCooldowns: Array.from(overrideCooldowns.entries()) });
        }, expectedGeneration).catch(() => {});
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

    const activePolicy = heuristicPolicy || buildDefaultPolicy('deep_work', 'balanced');
    const evaluationEvents = transientEvent
      ? [
        ...(Array.isArray(session.events) ? session.events : []),
        {
          ...transientEvent,
          timestamp: Number.isFinite(transientEvent.timestamp) ? transientEvent.timestamp : now,
        },
      ]
      : session.events;
    const policyDrift = evaluatePolicyDrift({
      intent: session.intent,
      url,
      events: evaluationEvents,
      policy: activePolicy,
      now: Date.now(),
      relatedHostnames: relatedHostnamesList(),
    });

    if (policyDrift.shouldIntervene) {
      void triggerIntervention(
        policyDrift.reasonLabel || 'Your recent browsing no longer matches your declared intent.',
        tabId,
        expectedGeneration,
      ).catch(() => {});
      return;
    }

    if (skipLlm) return;

    checkDriftLLM(session.intent, url, session.events).then(res => {
      if (expectedGeneration !== getStorageGeneration() || isStorageDeletionActive()) return;
      if (!res.isAligned && res.confidence >= DRIFT_CONFIDENCE_THRESHOLD) {
        chrome.storage.local.get(['activeSession', 'overrideCooldowns'], (storageResult) => {
          if (expectedGeneration !== getStorageGeneration() || isStorageDeletionActive()) return;
          if (chrome.runtime.lastError) return;
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
                  void triggerIntervention(
                    'Your recent browsing no longer matches your declared intent.',
                    tabId,
                    expectedGeneration,
                  ).catch(() => {});
                }
              });
            } else {
              void triggerIntervention(
                'Your recent browsing no longer matches your declared intent.',
                tabId,
                expectedGeneration,
              ).catch(() => {});
            }
          }
        });
      }
    }).catch(() => {});
  });
}

// ── Intervention ───────────────────────────────────────────────────────

function triggerIntervention(reason, tabId = null, expectedGeneration = getStorageGeneration()) {
  return enqueueSessionMutation(async () => {
    const result = await storageGet(['activeSession', INTERVENTION_STATE_KEY, 'trackingEnabled']);
    if (result.trackingEnabled === false) return null;
    const session = sanitizeSessionEvents(result.activeSession);
    if (!session?.isActive) return null;

    let targetTab = null;
    if (Number.isInteger(tabId)) {
      targetTab = await getTab(tabId);
      if (targetTab?.url && !isTrackableUrl(targetTab.url)) return null;
    } else {
      const tabs = await queryTabs({ active: true, currentWindow: true });
      targetTab = tabs.find((tab) => (
        Number.isInteger(tab.id) && isTrackableUrl(tab.url)
      )) || null;
    }

    const targetTabId = Number.isInteger(targetTab?.id) ? targetTab.id : null;
    const existing = stateForTab(
      cloneInterventionStates(result[INTERVENTION_STATE_KEY]),
      targetTabId,
      session.id,
    );
    if (existing) return existing;

    ensureMetrics(session);
    session.metrics.interventionCount = (session.metrics.interventionCount || 0) + 1;

    let fallbackTabId = null;
    if (!Number.isInteger(targetTabId)) {
      // Create a blank tab first so the state is persisted before extension-page code runs.
      const fallbackTab = await createTab({ url: 'about:blank' });
      fallbackTabId = Number.isInteger(fallbackTab?.id) ? fallbackTab.id : null;
    }

    const state = {
      sessionId: session.id,
      nonce: createNonce(),
      reason,
      originalTabId: targetTabId,
      fallbackTabId,
      originalUrl: sanitizeUrl(targetTab?.url),
      intent: session.intent || '',
      mode: 'pending',
      timestamp: Date.now(),
    };
    const states = cloneInterventionStates(result[INTERVENTION_STATE_KEY]);
    const key = interventionKey(session.id, targetTabId ?? fallbackTabId);
    states[key] = state;
    await storageSet({ activeSession: session, [INTERVENTION_STATE_KEY]: states });
    currentSession = session;

    if (targetTabId) {
      const shown = await sendTabMessage(targetTabId, {
        type: 'SHOW_INTERVENTION',
        reason,
        intent: session.intent || '',
        sessionId: state.sessionId,
        nonce: state.nonce,
        state,
      });
      if (!shown.error && shown.response?.shown) {
        state.mode = 'overlay';
        states[key] = state;
        await persistInterventionStates(states);
        return state;
      }
      if (shown.response?.reason === 'tracking_disabled') {
        delete states[key];
        await persistInterventionStates(states);
        return null;
      }
      state.mode = 'fallback';
      state.fallbackTabId = targetTabId;
      states[key] = state;
      await persistInterventionStates(states);
      await updateTab(targetTabId, { url: chrome.runtime.getURL('intervention.html') });
      return state;
    }

    state.mode = 'fallback';
    states[key] = state;
    await persistInterventionStates(states);
    if (fallbackTabId) {
      await updateTab(fallbackTabId, { url: chrome.runtime.getURL('intervention.html') });
    }
    return state;
  }, expectedGeneration);
}

function handleOverride(sessionData, expectedGeneration = getStorageGeneration()) {
  if (!sessionData) return Promise.resolve();
  return enqueueSessionMutation(async () => {
    const updatedSession = sanitizeSessionEvents({
      ...sessionData,
      events: Array.isArray(sessionData.events)
        ? sessionData.events.filter(hasSupportedEventUrls)
        : [],
    });
    await storageSet({ activeSession: updatedSession });
    currentSession = updatedSession;

    // Set per-domain override cooldown from the most recent override event
    const events = Array.isArray(currentSession?.events) ? currentSession.events : [];
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
  }, expectedGeneration);
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

export { reloadConfig, createHistoryEntry, triggerIntervention };
