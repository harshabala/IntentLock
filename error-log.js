// error-log.js — Local diagnostic log for user-visible errors

import {
  ERROR_LOG_RETENTION_MS,
  MAX_ERROR_LOG_ENTRIES,
  pruneByRetention,
  redactSecrets,
} from './privacy-utils.js';
import {
  enqueueStorageMutation,
  getStorageGeneration,
  isPersistedStorageWriteAllowed,
  isStorageDeletionActive,
} from './storage-queue.js';
import { endStorageDeletion } from './storage-queue.js';

export const ERROR_TYPES = {
  API: 'api',
  CONFIG: 'config',
  UI: 'ui',
  STORAGE: 'storage',
  VALIDATION: 'validation',
  RUNTIME: 'runtime',
};

export const MAX_LOG_ENTRIES = MAX_ERROR_LOG_ENTRIES;

if (typeof chrome !== 'undefined') {
  chrome.runtime?.onMessage?.addListener?.((message) => {
    if (message?.type === 'DATA_DELETED' || message?.type === 'DATA_DELETION_FAILED') {
      endStorageDeletion(message.generation);
    }
  });
}

export function classifyApiError(status, bodyText = '', providerId = 'unknown') {
  const body = typeof bodyText === 'string' ? bodyText : '';
  const lower = body.toLowerCase();

  let code = 'api_error';
  let message = `API request failed (${status || 'network error'}).`;

  if (status === 401 || lower.includes('invalid api key') || lower.includes('incorrect api key')) {
    code = 'invalid_api_key';
    message = 'API key is invalid or unauthorized. Check your key in Settings.';
  } else if (status === 403) {
    code = 'forbidden';
    message = 'API access forbidden. Your key may lack permission for this model or endpoint.';
  } else if (status === 429 || lower.includes('quota') || lower.includes('rate limit') || lower.includes('resource_exhausted')) {
    code = 'quota_exceeded';
    message = 'API quota or rate limit exceeded. Usage may be full — try again later or check your provider billing.';
  } else if (status === 404 || lower.includes('not found')) {
    code = 'not_found';
    message = 'API endpoint or model not found. Check model name and endpoint in Advanced settings.';
  } else if (status === 400) {
    code = 'bad_request';
    message = 'API rejected the request. Configuration may be incorrect.';
  } else if (!status || status === 0) {
    code = 'network_error';
    message = 'Could not reach the API. Check your network or local server (Ollama/LM Studio).';
  }

  return {
    code,
    message,
    status: status || null,
    providerId,
    providerMessage: null,
  };
}

export function formatErrorLogForExport(entries = []) {
  const recentEntries = pruneByRetention(
    Array.isArray(entries) ? entries : [],
    { retentionMs: ERROR_LOG_RETENTION_MS, maxEntries: MAX_LOG_ENTRIES, newestFirst: true },
  ).map(sanitizeDiagnosticEntry).filter(Boolean);
  const lines = [
    'IntentLock Diagnostic Log',
    `Exported: ${new Date().toISOString()}`,
    `Entries: ${recentEntries.length}`,
    '',
  ];

  recentEntries.forEach((entry, index) => {
    lines.push(`--- Entry ${index + 1} ---`);
    lines.push(`Time: ${new Date(entry.timestamp).toISOString()}`);
    lines.push(`Type: ${entry.type}`);
    lines.push(`Source: ${entry.source || 'unknown'}`);
    lines.push(`Message: ${entry.message}`);
    if (entry.details && Object.keys(entry.details).length > 0) {
      lines.push(`Details: ${JSON.stringify(entry.details, null, 2)}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}

const PRIVATE_DIAGNOSTIC_KEY_RE = /^(body|bodyText|response|responseBody|prompt|url|uri|request|raw|content|text|providerMessage)$/i;

function sanitizeDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  const safe = {};
  Object.entries(details).forEach(([key, value]) => {
    if (PRIVATE_DIAGNOSTIC_KEY_RE.test(key)) return;
    safe[key] = value && typeof value === 'object'
      ? sanitizeDetails(value)
      : value;
  });
  return redactSecrets(safe);
}

function sanitizeDiagnosticEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    ...entry,
    message: redactSecrets(entry.message || ''),
    details: sanitizeDetails(entry.details),
  };
}

export function logError({ type = ERROR_TYPES.RUNTIME, message, details = null, source = 'unknown' }) {
  if (!message) return Promise.resolve(null);

  const generation = getStorageGeneration();

  const entry = sanitizeDiagnosticEntry({
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    type,
    message: redactSecrets(message),
    details: sanitizeDetails(details),
    source,
  });

  console.error(`[IntentLock:${type}] ${entry.message}`, entry.details || '');

  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return Promise.resolve(entry);
  }

  return enqueueStorageMutation(() => {
    if (generation !== getStorageGeneration() || isStorageDeletionActive()) return null;
    return isPersistedStorageWriteAllowed(generation).then((allowed) => {
      if (!allowed) return null;
      return new Promise((resolve) => {
        chrome.storage.local.get(['errorLog'], (result) => {
          const log = pruneByRetention(
            Array.isArray(result?.errorLog) ? result.errorLog : [],
            { retentionMs: ERROR_LOG_RETENTION_MS, maxEntries: MAX_LOG_ENTRIES, newestFirst: true },
          );
          log.unshift(entry);
          if (log.length > MAX_LOG_ENTRIES) log.length = MAX_LOG_ENTRIES;
          void isPersistedStorageWriteAllowed(generation).then((stillAllowed) => {
            if (!stillAllowed) {
              resolve(null);
              return;
            }
            chrome.storage.local.set({ errorLog: log }, () => resolve(entry));
          });
        });
      });
    });
  });
}

export function getErrorLog() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return Promise.resolve([]);
  }
  const generation = getStorageGeneration();
  return enqueueStorageMutation(() => {
    if (generation !== getStorageGeneration() || isStorageDeletionActive()) return [];
    return isPersistedStorageWriteAllowed(generation).then((allowed) => {
      if (!allowed) return [];
      return new Promise((resolve) => {
        chrome.storage.local.get(['errorLog'], (result) => {
          const log = pruneByRetention(
            Array.isArray(result?.errorLog) ? result.errorLog : [],
            { retentionMs: ERROR_LOG_RETENTION_MS, maxEntries: MAX_LOG_ENTRIES, newestFirst: true },
          ).map(sanitizeDiagnosticEntry).filter(Boolean);
          void isPersistedStorageWriteAllowed(generation).then((stillAllowed) => {
            if (!stillAllowed) {
              resolve([]);
              return;
            }
            chrome.storage.local.set({ errorLog: log }, () => resolve(log));
          });
        });
      });
    });
  });
}

export function clearErrorLog() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return Promise.resolve();
  }
  const generation = getStorageGeneration();
  return enqueueStorageMutation(() => {
    if (generation !== getStorageGeneration() || isStorageDeletionActive()) return;
    return isPersistedStorageWriteAllowed(generation).then((allowed) => {
      if (!allowed) return;
      return new Promise((resolve) => {
        chrome.storage.local.set({ errorLog: [] }, () => resolve());
      });
    });
  });
}
