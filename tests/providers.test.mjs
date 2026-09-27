import { applyStorageCommand } from '../storage-authority.js';
import { registerErrorLogAuthority } from '../error-log.js';
registerErrorLogAuthority(applyStorageCommand);
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { beginStorageDeletion, endStorageDeletion } from '../storage-queue.js';

// Node 18 may not expose the browser Web Crypto global.
globalThis.crypto ??= webcrypto;

let storageData = {
  errorLog: [],
  llmProviderConfig: {
    providerId: 'gemini',
    model: 'gemini-2.0-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
  },
};

globalThis.chrome = {
  storage: {
    session: {
      get: (keys, callback) => callback({ llmApiKey: 'gemini-test-key' }),
    },
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
  cleanJsonString,
  getProvider,
  providerRequiresApiKey,
  validateApiKey,
  validateProviderConfig,
  isLlmConfigured,
  getLlmConfig,
  chatCompletion,
} from '../providers.js';

test('getProvider does not map unknown ids to OpenAI', () => {
  assert.equal(getProvider('unknown'), null);
  assert.equal(getProvider('none'), null);
  assert.equal(getProvider('openai').id, 'openai');
});

test('providerRequiresApiKey respects local and custom auth settings', () => {
  assert.equal(providerRequiresApiKey('ollama'), false);
  assert.equal(providerRequiresApiKey('gemini'), true);
  assert.equal(providerRequiresApiKey('custom', { authType: 'none' }), false);
  assert.equal(providerRequiresApiKey('custom', { authType: 'bearer' }), true);
});

test('validateApiKey enforces provider-specific key formats', () => {
  assert.equal(validateApiKey('openai', ''), 'API key is required for this provider.');
  assert.match(validateApiKey('openai', 'bad'), /sk-/);
  assert.match(validateApiKey('openai', 'AIzaSyD_valid_key_example_12345'), /Gemini key/i);
  assert.equal(validateApiKey('ollama', ''), null);
  assert.equal(validateApiKey('gemini', 'AIzaSyD_valid_key_example_12345'), null);
});

test('validateProviderConfig requires custom provider fields', () => {
  assert.match(
    validateProviderConfig({ providerId: 'custom', customLabel: '', baseUrl: '', model: '' }),
    /name/i,
  );
  assert.equal(
    validateProviderConfig({
      providerId: 'custom',
      customLabel: 'My API',
      baseUrl: 'https://api.example.com/v1/chat/completions',
      model: 'my-model',
    }),
    null,
  );
});

test('isLlmConfigured allows local providers without API keys', () => {
  assert.equal(isLlmConfigured({ providerId: 'ollama', provider: getProvider('ollama') }), true);
  assert.equal(
    isLlmConfigured({ providerId: 'gemini', provider: getProvider('gemini'), apiKey: null }),
    false,
  );
  assert.equal(isLlmConfigured({ providerId: 'unknown', apiKey: 'sk-test-key' }), false);
  assert.equal(isLlmConfigured({ providerId: 'none', apiKey: 'sk-test-key' }), false);
  assert.equal(isLlmConfigured({ apiKey: 'sk-test-key' }), false);
});

test('getLlmConfig reads provider config and session API key', async () => {
  const config = await getLlmConfig();
  assert.equal(config.providerId, 'gemini');
  assert.equal(config.apiKey, 'gemini-test-key');
  assert.equal(config.model, 'gemini-2.0-flash');
});

test('built-in provider auth mode ignores persisted tampering', async () => {
  const previousConfig = storageData.llmProviderConfig;
  const previousSessionGet = globalThis.chrome.storage.session.get;
  storageData.llmProviderConfig = {
    providerId: 'openai',
    model: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    authType: 'query',
  };
  globalThis.chrome.storage.session.get = (_keys, callback) => callback({ llmApiKey: 'sk-test-key' });
  try {
    const config = await getLlmConfig();
    assert.equal(config.authType, 'bearer');
  } finally {
    storageData.llmProviderConfig = previousConfig;
    globalThis.chrome.storage.session.get = previousSessionGet;
  }
});

test('built-in provider keys never enter request URLs', async () => {
  const previousConfig = storageData.llmProviderConfig;
  const previousSessionGet = globalThis.chrome.storage.session.get;
  const previousFetch = globalThis.fetch;
  storageData.llmProviderConfig = {
    providerId: 'openai',
    model: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    authType: 'query',
  };
  globalThis.chrome.storage.session.get = (_keys, callback) => callback({ llmApiKey: 'sk-test-key' });
  let requestUrl = '';
  let requestHeaders = null;
  globalThis.fetch = async (url, options) => {
    requestUrl = url;
    requestHeaders = options.headers;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
  };
  try {
    const result = await chatCompletion('auth test');
    assert.equal(result.ok, true);
    assert.equal(requestUrl, 'https://api.openai.com/v1/chat/completions');
    assert.equal(requestHeaders.Authorization, 'Bearer sk-test-key');
    assert.equal(requestHeaders['x-api-key'], undefined);
    assert.doesNotMatch(requestUrl, /key=/);
  } finally {
    storageData.llmProviderConfig = previousConfig;
    globalThis.chrome.storage.session.get = previousSessionGet;
    globalThis.fetch = previousFetch;
  }
});

test('getLlmConfig never uses a local key alias as a request credential', async () => {
  const previousConfig = storageData.llmProviderConfig;
  const previousKey = storageData.llmApiKey;
  const previousSessionGet = globalThis.chrome.storage.session.get;
  storageData.llmProviderConfig = { providerId: 'openai' };
  storageData.llmApiKey = 'local-llm-key';
  globalThis.chrome.storage.session.get = (_keys, callback) => callback({});
  try {
    const config = await getLlmConfig();
    assert.equal(config.apiKey, null);
    assert.equal(isLlmConfigured(config), false);
  } finally {
    storageData.llmProviderConfig = previousConfig;
    if (previousKey === undefined) delete storageData.llmApiKey;
    else storageData.llmApiKey = previousKey;
    globalThis.chrome.storage.session.get = previousSessionGet;
  }
});

test('chatCompletion routes Gemini requests to generateContent endpoint', async () => {
  let requestUrl = '';
  let requestBody = null;

  globalThis.fetch = async (url, options) => {
    requestUrl = url;
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"aligned": true, "confidence": 0.9}' }] } }],
      }),
    };
  };

  const result = await chatCompletion('test prompt', { jsonMode: true, maxTokens: 50, temperature: 0.1 });
  assert.equal(result.ok, true);
  assert.equal(result.text, '{"aligned": true, "confidence": 0.9}');
  assert.match(requestUrl, /generateContent\?key=/);
  assert.equal(requestBody.generationConfig.responseMimeType, 'application/json');
});

test('chatCompletion routes Ollama requests to local chat endpoint', async () => {
  globalThis.chrome.storage.local.get = (keys, callback) => callback({
    llmProviderConfig: {
      providerId: 'ollama',
      model: 'llama3.2',
      baseUrl: 'http://localhost:11434/api/chat',
    },
  });
  globalThis.chrome.storage.session.get = (keys, callback) => callback({});

  let requestUrl = '';
  let requestBody = null;

  globalThis.fetch = async (url, options) => {
    requestUrl = url;
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        message: { content: '{"steps": ["A", "B", "C"]}' },
      }),
    };
  };

  const result = await chatCompletion('plan prompt', { jsonMode: true });
  assert.equal(requestUrl, 'http://localhost:11434/api/chat');
  assert.equal(requestBody.format, 'json');
  assert.equal(requestBody.stream, false);
  assert.equal(result.ok, true);
  assert.equal(result.text, '{"steps": ["A", "B", "C"]}');
});

test('chatCompletion logs and returns structured error on API failure', async () => {
  storageData.errorLog = [];
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    text: async () => '{"error":{"message":"quota exceeded"}}',
  });

  const result = await chatCompletion('test prompt');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'quota_exceeded');
  assert.equal(storageData.errorLog.length, 1);
  assert.match(storageData.errorLog[0].message, /quota|rate limit/i);
});

test('cleanJsonString helper strips markdown fences and surrounding whitespaces', () => {
  assert.equal(
    cleanJsonString('```json\n{"aligned": true}\n```'),
    '{"aligned": true}',
  );
});

test('unknown provider id does not become a live OpenAI send', async () => {
  const previousConfig = storageData.llmProviderConfig;
  const previousSessionGet = globalThis.chrome.storage.session.get;
  const previousLocalGet = globalThis.chrome.storage.local.get;
  const previousFetch = globalThis.fetch;
  const restoreLocalGet = (keys, callback) => {
    const res = {};
    const keysArr = Array.isArray(keys) ? keys : [keys];
    for (const key of keysArr) {
      if (storageData[key] !== undefined) res[key] = storageData[key];
    }
    callback(res);
  };
  globalThis.chrome.storage.local.get = restoreLocalGet;
  globalThis.chrome.storage.session.get = (_keys, callback) => callback({ llmApiKey: 'sk-test-key' });
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error('fetch should not run for unknown provider');
  };
  try {
    storageData.llmProviderConfig = { providerId: 'none' };
    let result = await chatCompletion('should not send');
    assert.equal(result.ok, false);
    assert.equal(called, false);
    assert.equal(isLlmConfigured(await getLlmConfig()), false);

    delete storageData.llmProviderConfig;
    result = await chatCompletion('missing config');
    assert.equal(result.ok, false);
    assert.equal(called, false);
    assert.equal(isLlmConfigured(await getLlmConfig()), false);

    storageData.llmProviderConfig = { providerId: 'not-a-provider' };
    result = await chatCompletion('unknown id');
    assert.equal(result.ok, false);
    assert.equal(called, false);
    const config = await getLlmConfig();
    assert.notEqual(config.providerId, 'openai');
    assert.equal(isLlmConfigured(config), false);
  } finally {
    if (previousConfig === undefined) delete storageData.llmProviderConfig;
    else storageData.llmProviderConfig = previousConfig;
    globalThis.chrome.storage.session.get = previousSessionGet;
    globalThis.chrome.storage.local.get = previousLocalGet;
    globalThis.fetch = previousFetch;
  }
});

test('chatCompletion does not call a provider when tracking is disabled', async () => {
  globalThis.chrome.storage.local.get = (keys, callback) => callback({
    trackingEnabled: false,
    llmProviderConfig: {
      providerId: 'ollama',
      model: 'llama3.2',
      baseUrl: 'http://localhost:11434/api/chat',
    },
  });
  globalThis.chrome.storage.session.get = (keys, callback) => callback({});
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error('fetch should not run');
  };

  const result = await chatCompletion('disabled');
  assert.equal(result.error.code, 'tracking_disabled');
  assert.equal(called, false);
});

test('chatCompletion is blocked while delete-all data is in progress', async () => {
  beginStorageDeletion();
  try {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      throw new Error('fetch should not run during deletion');
    };

    const result = await chatCompletion('deletion boundary');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'data_deletion');
    assert.equal(called, false);
  } finally {
    endStorageDeletion();
  }
});
