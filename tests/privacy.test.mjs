import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ERROR_LOG_RETENTION_MS,
  SESSION_RETENTION_MS,
  hostnameFromUrl,
  pruneByRetention,
  redactSecrets,
  sanitizeHistoryEntry,
  sanitizeSessionHistory,
  sanitizeUrl,
} from '../privacy-utils.js';
import { validateProviderEndpoint, validateProviderConfig } from '../providers.js';

test('provider context URL minimization removes path, query, and fragment', () => {
  assert.equal(sanitizeUrl('https://example.com/private/page?token=secret#fragment'), 'https://example.com');
  assert.equal(hostnameFromUrl('https://www.Example.com/a'), 'example.com');
  assert.equal(sanitizeUrl('chrome://settings'), null);
});

test('recursive redaction removes nested credentials, secret URLs, and auth schemes', () => {
  const safe = redactSecrets({
    request: {
      Authorization: 'Token token-secret-123456',
      nested: {
        apiKey: 'sk-test-secret',
        access_token: 'access-secret',
        auth: 'auth-secret',
        secret: 'secret-value',
        password: 'password-value',
      },
    },
    text: 'Authorization: Bearer bearer-secret-123456 https://api.test/?access_token=url-secret&password=pw-secret#secret=fragment-secret',
    providerId: 'openai',
  });
  assert.equal(safe.request.Authorization, '[redacted]');
  assert.equal(safe.request.nested.apiKey, '[redacted]');
  assert.equal(safe.request.nested.access_token, '[redacted]');
  assert.equal(safe.request.nested.auth, '[redacted]');
  assert.equal(safe.request.nested.secret, '[redacted]');
  assert.equal(safe.request.nested.password, '[redacted]');
  assert.doesNotMatch(safe.text, /(?:url-secret|pw-secret|fragment-secret|bearer-secret)/);
  assert.equal(safe.providerId, 'openai');
});

test('redaction covers provider-specific query secrets and embedded credentials', () => {
  const safe = redactSecrets(
    'https://user:password@provider.test/error?client_secret=one&x-api-key=two ' +
    'reflection access_token=three',
  );
  assert.doesNotMatch(safe, /password|one|two|three/);
});

test('retention helpers bound old data and legacy URLs', () => {
  const now = Date.now();
  const entries = [
    { endTime: now, overrides: [{ url: 'https://example.com/private?q=1', reflection: 'relevant' }] },
    { endTime: now - SESSION_RETENTION_MS - 1, overrides: [] },
  ];
  const history = sanitizeSessionHistory(entries, { now });
  assert.equal(history.length, 1);
  assert.equal(history[0].overrides[0].hostname, 'example.com');
  assert.equal(history[0].overrides[0].url, undefined);
  assert.equal(pruneByRetention([
    { timestamp: now },
    { timestamp: now - ERROR_LOG_RETENTION_MS - 1 },
  ], { now, retentionMs: ERROR_LOG_RETENTION_MS }).length, 1);
  assert.equal(sanitizeHistoryEntry(entries[0]).events, undefined);
});

test('retention keeps newest entries and report-compatible domain metrics', () => {
  const now = Date.now();
  const newest = sanitizeSessionHistory(
    Array.from({ length: 102 }, (_, index) => ({
      id: `session-${index}`,
      endTime: now - (101 - index),
      topDomains: [{ hostname: 'example.com', activeMs: 1000, aligned: index % 2 === 0, alignedMs: 750 }],
    })),
    { now },
  );

  assert.equal(newest.length, 100);
  assert.equal(newest[0].id, 'session-2');
  assert.equal(newest.at(-1).id, 'session-101');
  assert.equal(newest[0].topDomains[0].aligned, true);
  assert.equal(newest[0].topDomains[0].alignedMs, 750);
});

test('history reflections are redacted before export', () => {
  const [entry] = sanitizeSessionHistory([{
    id: 'secret-reflection',
    endTime: Date.now(),
    overrides: [{ reflection: 'access_token=do-not-export' }],
  }]);
  assert.equal(entry.overrides[0].reflection, 'access_token=[redacted]');
});

test('provider endpoint policy rejects unsafe overrides', () => {
  assert.equal(validateProviderEndpoint('openai', 'https://api.openai.com/v1/chat/completions'), null);
  assert.match(validateProviderEndpoint('openai', 'https://evil.example/v1/chat/completions'), /cannot be overridden/i);
  assert.equal(validateProviderEndpoint('ollama', 'http://127.0.0.1:11434/api/chat'), null);
  assert.match(validateProviderEndpoint('ollama', 'http://192.168.1.10:11434/api/chat'), /loopback/i);
  assert.match(validateProviderConfig({
    providerId: 'custom', customLabel: 'unsafe', model: 'x', baseUrl: 'http://cloud.example/api',
  }), /HTTPS/i);
});
