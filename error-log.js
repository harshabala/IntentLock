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
  isStorageDeletionActive,
  writeStorageSet,
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

const DIAGNOSTIC_ENTRY_KEYS = new Set(['id', 'timestamp', 'type', 'source', 'message', 'details']);
const DIAGNOSTIC_DETAIL_KEYS = new Set([
  'code',
  'status',
  'httpStatus',
  'providerId',
  'model',
  'action',
  'operation',
  'category',
  'phase',
  'retryAfterMs',
  'apiKey',
  'access_token',
  'nested',
]);
const DIAGNOSTIC_DETAIL_CONTAINERS = new Set(['nested']);
const PRIVATE_DIAGNOSTIC_KEY_RE = /^(body|bodyText|response|responseBody|prompt|url|uri|request|raw|content|text|providerMessage)$/i;

function sanitizeDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  const safe = {};
  Object.entries(details).forEach(([key, value]) => {
    if (!DIAGNOSTIC_DETAIL_KEYS.has(key) || PRIVATE_DIAGNOSTIC_KEY_RE.test(key)) return;
    if (value && typeof value === 'object') {
      if (DIAGNOSTIC_DETAIL_CONTAINERS.has(key)) safe[key] = sanitizeDetails(value);
      return;
    }
    if (['string', 'number', 'boolean'].includes(typeof value) || value === null) {
      safe[key] = value;
    }
  });
  return redactSecrets(safe);
}

function sanitizeDiagnosticEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const safe = {};
  DIAGNOSTIC_ENTRY_KEYS.forEach((key) => {
    if (key === 'message') {
      if (typeof entry.message === 'string') safe.message = redactSecrets(entry.message);
    } else if (key === 'details') {
      safe.details = sanitizeDetails(entry.details);
    } else if (entry[key] !== undefined && ['string', 'number'].includes(typeof entry[key])) {
      safe[key] = entry[key];
    }
  });
  return safe;
}

export function logError({ type = ERROR_TYPES.RUNTIME, message, details = null, source = 'unknown' }) {
  if (!message) return Promise.resolve(null);
  if (isStorageDeletionActive()) return Promise.resolve(null);

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
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(['errorLog'], async (result) => {
        try {
          const log = pruneByRetention(
            Array.isArray(result?.errorLog) ? result.errorLog : [],
            { retentionMs: ERROR_LOG_RETENTION_MS, maxEntries: MAX_LOG_ENTRIES, newestFirst: true },
          ).map(sanitizeDiagnosticEntry).filter(Boolean);
          log.unshift(entry);
          if (log.length > MAX_LOG_ENTRIES) log.length = MAX_LOG_ENTRIES;
          const saved = await writeStorageSet({ errorLog: log }, chrome.storage.local, generation, { silent: true });
          resolve(saved ? entry : null);
        } catch (error) {
          reject(error);
        }
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
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(['errorLog'], async (result) => {
        try {
          const log = pruneByRetention(
            Array.isArray(result?.errorLog) ? result.errorLog : [],
            { retentionMs: ERROR_LOG_RETENTION_MS, maxEntries: MAX_LOG_ENTRIES, newestFirst: true },
          ).map(sanitizeDiagnosticEntry).filter(Boolean);
          const saved = await writeStorageSet({ errorLog: log }, chrome.storage.local, generation, { silent: true });
          resolve(saved ? log : []);
        } catch (error) {
          reject(error);
        }
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
    return writeStorageSet({ errorLog: [] }, chrome.storage.local, generation, { silent: true });
  });
}
