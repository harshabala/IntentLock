import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

// Node 18 may not expose the browser Web Crypto global.
globalThis.crypto ??= webcrypto;

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
