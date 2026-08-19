import assert from 'node:assert/strict';
import test from 'node:test';
import { beginStorageDeletion, endStorageDeletion } from '../storage-queue.js';

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
  getEffectiveAuthType,
  chatCompletion,
} from '../providers.js';

test('getProvider falls back to OpenAI for unknown ids', () => {
  assert.equal(getProvider('unknown').id, 'openai');
});

test('providerRequiresApiKey respects local and custom auth settings', () => {
  assert.equal(providerRequiresApiKey('ollama'), false);
  assert.equal(providerRequiresApiKey('gemini'), true);
  assert.equal(providerRequiresApiKey('custom', { authType: 'none' }), false);
  assert.equal(providerRequiresApiKey('custom', { authType: 'bearer' }), true);
});

test('custom query authentication is the effective disclosure mode', () => {
  assert.equal(getEffectiveAuthType('custom', { authType: 'query' }), 'query');
  assert.equal(getEffectiveAuthType('custom', { authType: 'bearer' }), 'bearer');
  assert.equal(getEffectiveAuthType('gemini', {}), 'query');
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

test('getLlmConfig does not fall back to a persistent local API key', async () => {
  const previousConfig = storageData.llmProviderConfig;
  const previousKey = storageData.llmApiKey;
  const previousSessionGet = globalThis.chrome.storage.session.get;
  storageData.llmProviderConfig = { providerId: 'openai' };
  storageData.llmApiKey = 'local-llm-key';
  globalThis.chrome.storage.session.get = (_keys, callback) => callback({});
  try {
    const config = await getLlmConfig();
    assert.equal(config.apiKey, null);
  } finally {
    storageData.llmProviderConfig = previousConfig;
    if (previousKey === undefined) delete storageData.llmApiKey;
    else storageData.llmApiKey = previousKey;
    globalThis.chrome.storage.session.get = previousSessionGet;
  }
});

test('deletion aborts in-flight provider work immediately', async () => {
  const previousConfig = storageData.llmProviderConfig;
  const previousFetch = globalThis.fetch;
  const previousSessionGet = globalThis.chrome.storage.session.get;
  let requestController = null;
  storageData.llmProviderConfig = {
    providerId: 'ollama',
    model: 'llama3.2',
    baseUrl: 'http://localhost:11434/api/chat',
  };
  globalThis.chrome.storage.session.get = (_keys, callback) => callback({});
  globalThis.fetch = (_url, { signal }) => {
    requestController = { signal };
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  };

  const request = chatCompletion('in-flight deletion test');
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    assert.ok(requestController, 'provider request should have started');
    beginStorageDeletion();
    assert.equal(requestController.signal.aborted, true);
    const result = await request;
    assert.equal(result.error.code, 'data_deletion');
  } finally {
    if (requestController && !requestController.signal.aborted) requestController.signal.dispatchEvent(new Event('abort'));
    endStorageDeletion();
    storageData.llmProviderConfig = previousConfig;
    globalThis.fetch = previousFetch;
    globalThis.chrome.storage.session.get = previousSessionGet;
  }
});

test('deletion blocks a provider fetch that races after the tracking read', async () => {
  const previousConfig = storageData.llmProviderConfig;
  const previousFetch = globalThis.fetch;
  const previousLocalGet = globalThis.chrome.storage.local.get;
  const previousSessionGet = globalThis.chrome.storage.session.get;
  let trackingReads = 0;
  let fetchCalled = false;
  storageData.llmProviderConfig = {
    providerId: 'ollama',
    model: 'llama3.2',
    baseUrl: 'http://localhost:11434/api/chat',
  };
  globalThis.chrome.storage.session.get = (_keys, callback) => callback({});
  globalThis.chrome.storage.local.get = (keys, callback) => {
    const keysArr = Array.isArray(keys) ? keys : [keys];
    if (keysArr.length === 1 && keysArr[0] === 'trackingEnabled') {
      trackingReads += 1;
      callback({});
      if (trackingReads === 2) beginStorageDeletion();
      return;
    }
    const result = {};
    for (const key of keysArr) {
      if (storageData[key] !== undefined) result[key] = storageData[key];
    }
    callback(result);
  };
  globalThis.fetch = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({ message: { content: '{}' } }) };
  };

  try {
    const result = await chatCompletion('racing deletion test');
    assert.equal(fetchCalled, false);
    assert.equal(result.error.code, 'data_deletion');
  } finally {
    endStorageDeletion();
    storageData.llmProviderConfig = previousConfig;
    globalThis.fetch = previousFetch;
    globalThis.chrome.storage.local.get = previousLocalGet;
    globalThis.chrome.storage.session.get = previousSessionGet;
  }
});

test('tombstone flip immediately before provider fetch blocks invocation', async () => {
  const previousConfig = storageData.llmProviderConfig;
  const previousFetch = globalThis.fetch;
  const previousLocalGet = globalThis.chrome.storage.local.get;
  const previousSessionGet = globalThis.chrome.storage.session.get;
  let tombstoneReads = 0;
  let fetchCalled = false;
  storageData.llmProviderConfig = {
    providerId: 'ollama',
    model: 'llama3.2',
    baseUrl: 'http://localhost:11434/api/chat',
  };
  globalThis.chrome.storage.session.get = (_keys, callback) => callback({});
  globalThis.chrome.storage.local.get = (keys, callback) => {
    const keysArr = Array.isArray(keys) ? keys : [keys];
    if (keysArr.length === 1 && keysArr[0] === 'deletionTombstone') {
      tombstoneReads += 1;
      const readNumber = tombstoneReads;
      if (readNumber === 2) {
        storageData.deletionTombstone = { generation: 1, active: true };
      }
      callback({ deletionTombstone: storageData.deletionTombstone || { generation: 0, active: false } });
      return;
    }
    const result = {};
    for (const key of keysArr) {
      if (storageData[key] !== undefined) result[key] = storageData[key];
    }
    callback(result);
  };
  globalThis.fetch = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({ message: { content: '{}' } }) };
  };

  try {
    const result = await chatCompletion('tombstone flip before fetch');
    assert.equal(fetchCalled, false);
    assert.equal(result.error.code, 'data_deletion');
    assert.ok(tombstoneReads >= 2, 'the fetch barrier should re-read the persisted tombstone');
  } finally {
    endStorageDeletion();
    delete storageData.deletionTombstone;
    storageData.llmProviderConfig = previousConfig;
    globalThis.fetch = previousFetch;
    globalThis.chrome.storage.local.get = previousLocalGet;
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
