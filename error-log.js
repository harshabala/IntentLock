// error-log.js — Local diagnostic log for user-visible errors

import {
  ERROR_LOG_RETENTION_MS,
  MAX_ERROR_LOG_ENTRIES,
  pruneByRetention,
  redactSecrets,
} from './privacy-utils.js';
import { getStorageGeneration, assertStorageEpoch } from './storage-queue.js';
import { captureStorageEpoch, mutateStorage } from './storage-client.js';

let localAuthority = null;
export function registerErrorLogAuthority(authority) { localAuthority = authority; }
function dispatch(command, payload = {}, epoch) {
  return localAuthority ? localAuthority(command, payload, epoch ?? getStorageGeneration()) : mutateStorage(command, payload, epoch ?? captureStorageEpoch());
}

export const ERROR_TYPES = {
  API: 'api',
  CONFIG: 'config',
  UI: 'ui',
  STORAGE: 'storage',
  VALIDATION: 'validation',
  RUNTIME: 'runtime',
};

export const MAX_LOG_ENTRIES = MAX_ERROR_LOG_ENTRIES;

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

  let providerMessage = null;
  try {
    const parsed = JSON.parse(body);
    providerMessage = parsed?.error?.message
      || parsed?.error?.message
      || parsed?.message
      || parsed?.[0]?.error?.message
      || null;
  } catch {
    if (body.length > 0 && body.length < 500) {
      providerMessage = body.trim();
    }
  }

  if (providerMessage) {
    providerMessage = redactSecrets(providerMessage);
    message = `${message} Provider says: ${providerMessage}`;
  }

  return {
    code,
    message,
    status: status || null,
    providerId,
    providerMessage,
  };
}

export function formatErrorLogForExport(entries = []) {
  const recentEntries = pruneByRetention(
    Array.isArray(entries) ? entries : [],
    { retentionMs: ERROR_LOG_RETENTION_MS, maxEntries: MAX_LOG_ENTRIES, newestFirst: true },
  ).map((entry) => redactSecrets(entry));
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

function sanitizeDetails(details) {
  if (!details || typeof details !== 'object') return {};
  return redactSecrets(details);
}

export function captureErrorEpoch() {
  const token = localAuthority ? getStorageGeneration() : captureStorageEpoch();
  // Some async operations exit before logging. Rejected page initialization
  // must not become an unhandled rejection in those paths.
  if (token?.catch) token.catch(() => {});
  return token;
}

export async function isErrorEpochCurrent(token) {
  try {
    const epoch = await token;
    if (localAuthority) assertStorageEpoch(epoch);
    else if (epoch !== await captureStorageEpoch()) return false;
    return true;
  } catch { return false; }
}

export async function logError({ type = ERROR_TYPES.RUNTIME, message, details = null, source = 'unknown' }, token = captureErrorEpoch()) {
  if (!message) return Promise.resolve(null);

  if (!await isErrorEpochCurrent(token)) return null;
  const generation = await token;

  const entry = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    type,
    message: redactSecrets(message),
    details: sanitizeDetails(details),
    source,
  };

  console.error(`[IntentLock:${type}] ${entry.message}`, entry.details || '');

  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return Promise.resolve(entry);
  }

  // Logging is best-effort and must never recursively log a failed mutation.
  return dispatch('appendError', { entry }, generation).catch(() => null);
}

export function getErrorLog() {
  if (!globalThis.chrome?.storage?.local) return Promise.resolve([]);
  return dispatch('readErrors');
}

export function clearErrorLog() {
  if (!globalThis.chrome?.storage?.local) return Promise.resolve();
  return dispatch('clearErrors');
}
