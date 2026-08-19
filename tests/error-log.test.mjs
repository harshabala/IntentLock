import assert from 'node:assert/strict';
import test from 'node:test';

let storageData = { errorLog: [] };

globalThis.chrome = {
  storage: {
    local: {
      get: (keys, callback) => {
        const res = {};
        const keysArr = Array.isArray(keys) ? keys : [keys];
        for (const key of keysArr) {
          if (storageData[key] !== undefined) res[key] = storageData[key];
        }
        callback(res);
      },
      set: (data, callback) => {
        Object.assign(storageData, data);
        if (callback) callback();
      },
    },
  },
};

import {
  classifyApiError,
  formatErrorLogForExport,
  logError,
  getErrorLog,
  clearErrorLog,
  ERROR_TYPES,
} from '../error-log.js';

test('classifyApiError maps quota and invalid key responses', () => {
  const quota = classifyApiError(429, '{"error":{"message":"quota exceeded"}}', 'gemini');
  assert.equal(quota.code, 'quota_exceeded');
  assert.match(quota.message, /quota|rate limit/i);

  const invalid = classifyApiError(401, '{"error":{"message":"invalid api key"}}', 'openai');
  assert.equal(invalid.code, 'invalid_api_key');
});

test('provider diagnostics keep only structured status and code', () => {
  const body = JSON.stringify({
    error: {
      message: 'Prompt echo: write the private launch plan at https://private.example.test/doc?id=42',
    },
  });
  const error = classifyApiError(500, body, 'custom');

  assert.equal(error.code, 'api_error');
  assert.equal(error.providerMessage, null);
  assert.doesNotMatch(error.message, /Prompt echo|private\.example|launch plan/);
});

test('diagnostic details discard provider bodies, prompts, and private URLs', async () => {
  storageData = { errorLog: [] };
  await logError({
    type: ERROR_TYPES.API,
    message: 'API request failed (500).',
    details: {
      code: 'api_error',
      status: 500,
      bodyText: 'Prompt echo: keep this private text',
      prompt: 'private user intent',
      url: 'https://private.example.test/path?token=secret',
      providerId: 'custom',
    },
    source: 'provider',
  });

  const [entry] = await getErrorLog();
  assert.equal(entry.details.code, 'api_error');
  assert.equal(entry.details.status, 500);
  assert.equal(entry.details.providerId, 'custom');
  assert.equal(entry.details.bodyText, undefined);
  assert.equal(entry.details.prompt, undefined);
  assert.equal(entry.details.url, undefined);
});

test('legacy diagnostic entries whitelist top-level and nested fields', async () => {
  storageData = {
    errorLog: [{
      id: 'legacy-entry',
      timestamp: Date.now(),
      type: 'api',
      source: 'provider',
      message: 'structured failure',
      providerId: 'custom',
      bodyText: 'private provider response',
      prompt: 'private intent echo',
      url: 'https://private.example.test/path?token=secret',
      details: {
        code: 'api_error',
        status: 500,
        providerId: 'custom',
        nested: {
          model: 'safe-model',
          bodyText: 'nested private body',
          url: 'https://private.example.test/nested',
        },
      },
    }],
  };

  const [entry] = await getErrorLog();
  assert.deepEqual(Object.keys(entry).sort(), ['details', 'id', 'message', 'source', 'timestamp', 'type']);
  assert.equal(entry.providerId, undefined);
  assert.equal(entry.bodyText, undefined);
  assert.equal(entry.prompt, undefined);
  assert.equal(entry.url, undefined);
  assert.deepEqual(entry.details, {
    code: 'api_error',
    status: 500,
    providerId: 'custom',
    nested: { model: 'safe-model' },
  });
  assert.deepEqual(Object.keys(storageData.errorLog[0]).sort(), ['details', 'id', 'message', 'source', 'timestamp', 'type']);
});

test('logError stores entries locally with sanitized details', async () => {
  storageData = { errorLog: [] };
  await logError({
    type: ERROR_TYPES.VALIDATION,
    message: 'Test validation error',
    details: { apiKey: 'secret', providerId: 'gemini' },
    source: 'test',
  });

  const log = await getErrorLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].message, 'Test validation error');
  assert.equal(log[0].details.apiKey, '[redacted]');
  assert.equal(log[0].details.providerId, 'gemini');
});

test('formatErrorLogForExport produces copyable text', async () => {
  storageData = {
    errorLog: [{
      timestamp: Date.now(),
      type: 'api',
      source: 'chatCompletion',
      message: 'API quota exceeded',
      details: { code: 'quota_exceeded' },
    }],
  };

  const text = formatErrorLogForExport(await getErrorLog());
  assert.match(text, /IntentLock Diagnostic Log/);
  assert.match(text, /API quota exceeded/);
  assert.match(text, /quota_exceeded/);
});

test('diagnostic reads prune expired entries at rest and exports omit them', async () => {
  const now = Date.now();
  const fresh = {
    timestamp: now,
    type: 'runtime',
    source: 'test',
    message: 'fresh',
    details: { access_token: 'do-not-store' },
  };
  const expired = {
    timestamp: now - (14 * 24 * 60 * 60 * 1000) - 1,
    type: 'runtime',
    source: 'test',
    message: 'expired',
  };
  storageData = { errorLog: [fresh, expired] };

  const log = await getErrorLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].message, 'fresh');
  assert.equal(log[0].details.access_token, '[redacted]');
  assert.deepEqual(storageData.errorLog, log);

  const text = formatErrorLogForExport([fresh, expired]);
  assert.match(text, /Entries: 1/);
  assert.match(text, /fresh/);
  assert.doesNotMatch(text, /expired/);
});

test('clearErrorLog removes stored entries', async () => {
  storageData = { errorLog: [{ message: 'old' }] };
  await clearErrorLog();
  const log = await getErrorLog();
  assert.deepEqual(log, []);
});
