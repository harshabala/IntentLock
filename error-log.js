// error-log.js — Local diagnostic log for user-visible errors

export const ERROR_TYPES = {
  API: 'api',
  CONFIG: 'config',
  UI: 'ui',
  STORAGE: 'storage',
  VALIDATION: 'validation',
  RUNTIME: 'runtime',
};

export const MAX_LOG_ENTRIES = 200;

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
  const lines = [
    'IntentLock Diagnostic Log',
    `Exported: ${new Date().toISOString()}`,
    `Entries: ${entries.length}`,
    '',
  ];

  entries.forEach((entry, index) => {
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
  const copy = { ...details };
  if (copy.apiKey) copy.apiKey = '[redacted]';
  if (copy.key) copy.key = '[redacted]';
  return copy;
}

export function logError({ type = ERROR_TYPES.RUNTIME, message, details = null, source = 'unknown' }) {
  if (!message) return Promise.resolve(null);

  const entry = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    type,
    message,
    details: sanitizeDetails(details),
    source,
  };

  console.error(`[IntentLock:${type}] ${message}`, entry.details || '');

  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return Promise.resolve(entry);
  }

  return new Promise((resolve) => {
    chrome.storage.local.get(['errorLog'], (result) => {
      const log = Array.isArray(result?.errorLog) ? result.errorLog : [];
      log.unshift(entry);
      if (log.length > MAX_LOG_ENTRIES) log.length = MAX_LOG_ENTRIES;
      chrome.storage.local.set({ errorLog: log }, () => resolve(entry));
    });
  });
}

export function getErrorLog() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return Promise.resolve([]);
  }
  return new Promise((resolve) => {
    chrome.storage.local.get(['errorLog'], (result) => {
      resolve(Array.isArray(result?.errorLog) ? result.errorLog : []);
    });
  });
}

export function clearErrorLog() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    chrome.storage.local.set({ errorLog: [] }, () => resolve());
  });
}