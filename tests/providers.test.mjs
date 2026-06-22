import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.chrome = {
  storage: {
    session: {
      get: (keys, callback) => callback({ llmApiKey: 'gemini-test-key' }),
    },
    local: {
      get: (keys, callback) => callback({
        llmProviderConfig: {
          providerId: 'gemini',
          model: 'gemini-2.0-flash',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
        },
      }),
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

test('getProvider falls back to OpenAI for unknown ids', () => {
  assert.equal(getProvider('unknown').id, 'openai');
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

  const text = await chatCompletion('test prompt', { jsonMode: true, maxTokens: 50, temperature: 0.1 });
  assert.equal(text, '{"aligned": true, "confidence": 0.9}');
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

  const text = await chatCompletion('plan prompt', { jsonMode: true });
  assert.equal(requestUrl, 'http://localhost:11434/api/chat');
  assert.equal(requestBody.format, 'json');
  assert.equal(requestBody.stream, false);
  assert.equal(text, '{"steps": ["A", "B", "C"]}');
});

test('cleanJsonString helper strips markdown fences and surrounding whitespaces', () => {
  assert.equal(
    cleanJsonString('```json\n{"aligned": true}\n```'),
    '{"aligned": true}',
  );
});