// privacy-utils.js — bounded retention and redaction helpers

export const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const ERROR_LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_SESSION_HISTORY = 100;
export const MAX_ERROR_LOG_ENTRIES = 200;

const SECRET_KEY_RE = /(api[-_]?key|access[-_]?token|(?:client|refresh|id|oauth)[-_]?token|token|auth(?:orization)?|bearer|cookie|password|secret|credential|private[-_]?key)/i;
const SECRET_QUERY_RE = /([?#&](?:x[-_]?api[-_]?key|api[-_]?key|client[-_]?secret|app[-_]?secret|access[-_]?token|(?:client|refresh|id|oauth)[-_]?token|auth(?:orization)?|bearer|cookie|password|secret|credential|private[-_]?key|signature|sig|token|key)=)[^&#\s]*/gi;
const SECRET_ASSIGNMENT_RE = /(\b(?:x[-_]?api[-_]?key|api[-_]?key|client[-_]?secret|app[-_]?secret|access[-_]?token|(?:client|refresh|id|oauth)[-_]?token|authorization|password|secret|credential|private[-_]?key|signature|sig|token|key)\s*[=:]\s*)([^\s,;&]+)/gi;
const EMBEDDED_CREDENTIALS_RE = /([a-z][a-z\d+.-]*:\/\/[^/\s:@]+:)[^@\s]+@/gi;
const AUTHORIZATION_VALUE_RE = /\b((?:authorization\s*:\s*)?(?:bearer|basic|token)\s+)[A-Za-z0-9+/=._~:-]{8,}/gi;
const SECRET_VALUE_RES = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bAIza[A-Za-z0-9_-]{12,}\b/g,
  /\bxai-[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{8,}\b/g,
];

export function redactSecrets(value, key = '') {
  if (SECRET_KEY_RE.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    let sanitized = value.replace(SECRET_QUERY_RE, '$1[redacted]');
    sanitized = sanitized.replace(EMBEDDED_CREDENTIALS_RE, '$1[redacted]@');
    sanitized = sanitized.replace(AUTHORIZATION_VALUE_RE, '$1[redacted]');
    sanitized = sanitized.replace(SECRET_ASSIGNMENT_RE, '$1[redacted]');
    return SECRET_VALUE_RES.reduce((result, pattern) => result.replace(pattern, '[redacted]'), sanitized);
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactSecrets(entryValue, entryKey),
    ]));
  }
  return value;
}

export function sanitizeUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function hostnameFromUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
    return hostname || null;
  } catch {
    return null;
  }
}

export function pruneByRetention(entries, {
  now = Date.now(),
  retentionMs,
  maxEntries = Infinity,
  newestFirst = false,
} = {}) {
  if (!Array.isArray(entries)) return [];
  const cutoff = Number.isFinite(retentionMs) ? now - retentionMs : -Infinity;
  const retained = entries
    .filter((entry) => {
      const timestamp = entry?.timestamp ?? entry?.endTime ?? entry?.startTime;
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    });
  if (!Number.isFinite(maxEntries)) return retained;
  if (maxEntries <= 0) return [];
  return newestFirst ? retained.slice(0, maxEntries) : retained.slice(-maxEntries);
}

function normalizedHostname(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const candidate = value.includes('://') ? value : `https://${value}`;
  try {
    const hostname = new URL(candidate).hostname.toLowerCase().replace(/^www\./, '');
    return hostname || null;
  } catch {
    return null;
  }
}

export function sanitizeHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const copy = redactSecrets({ ...entry });
  delete copy.events;
  if (Array.isArray(entry.overrides)) {
    copy.overrides = entry.overrides.map((override) => ({
      timestamp: override.timestamp || 0,
      hostname: normalizedHostname(override.hostname) || hostnameFromUrl(override.url),
      reflection: typeof override.reflection === 'string' ? redactSecrets(override.reflection) : null,
    }));
  }
  if (Array.isArray(entry.topDomains)) {
    copy.topDomains = entry.topDomains.map((domain = {}) => ({
      hostname: normalizedHostname(domain.hostname || domain.domain),
      activeMs: Number.isFinite(domain.activeMs) ? Math.max(0, domain.activeMs) : 0,
      aligned: domain.aligned === true,
      alignedMs: Number.isFinite(domain.alignedMs) ? Math.max(0, domain.alignedMs) : 0,
    }));
  }
  return copy;
}

export function sanitizeSessionHistory(entries, options = {}) {
  return pruneByRetention(entries, {
    retentionMs: SESSION_RETENTION_MS,
    maxEntries: MAX_SESSION_HISTORY,
    newestFirst: false,
    ...options,
  }).map(sanitizeHistoryEntry).filter(Boolean);
}
