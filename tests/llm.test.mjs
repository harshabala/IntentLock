import assert from 'node:assert/strict';
import test from 'node:test';

let storageData = {
  errorLog: [],
  llmProviderConfig: {
    providerId: 'openai',
    model: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    authType: 'bearer',
    apiStyle: 'openai',
  },
};

globalThis.chrome = {
  storage: {
    session: {
      get: (keys, callback) => {
        callback({ llmApiKey: 'fake-api-key' });
      },
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

import { clearDriftCache } from '../drift-cache.js';
import { checkDriftLLM, generateIntentPlan, cleanJsonString } from '../llm.js';

test('cleanJsonString helper strips markdown fences and surrounding whitespaces', () => {
  const cases = [
    {
      input: '```json\n{"aligned": true, "confidence": 0.95}\n```',
      expected: '{"aligned": true, "confidence": 0.95}',
    },
    {
      input: '```\n{"aligned": false}\n```',
      expected: '{"aligned": false}',
    },
    {
      input: '  ```json\n{"steps": ["A", "B"]}\n```  ',
      expected: '{"steps": ["A", "B"]}',
    },
    {
      input: '{"aligned": true}',
      expected: '{"aligned": true}',
    },
  ];

  for (const { input, expected } of cases) {
    assert.equal(cleanJsonString(input), expected);
  }
});

test('checkDriftLLM returns cached result without second API call', async () => {
  clearDriftCache();
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"aligned": false, "confidence": 0.91}' } }],
      }),
    };
  };

  const first = await checkDriftLLM('test intent', 'https://example.com', []);
  const second = await checkDriftLLM('test intent', 'https://example.com', []);

  assert.equal(fetchCount, 1);
  assert.equal(first.cached, undefined);
  assert.equal(second.cached, true);
  assert.deepEqual(second, { isAligned: false, confidence: 0.91, cached: true });
});

test('checkDriftLLM passes response_format and parses markdown JSON correctly', async () => {
  clearDriftCache();
  let fetchBody = null;
  globalThis.fetch = async (url, options) => {
    fetchBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '```json\n{"aligned": false, "confidence": 0.88}\n```',
            },
          },
        ],
      }),
    };
  };

  const result = await checkDriftLLM('test intent', 'https://youtube.com', []);
  assert.deepEqual(result, { isAligned: false, confidence: 0.88 });
  assert.deepEqual(fetchBody.response_format, { type: 'json_object' });
});

test('generateIntentPlan passes response_format and extracts steps safely from steps property or flat array', async () => {
  let fetchBody = null;
  let responseContent = '';

  globalThis.fetch = async (url, options) => {
    fetchBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: responseContent,
            },
          },
        ],
      }),
    };
  };

  responseContent = '```json\n{"steps": ["Read spec", "Write tests", "Implement code"]}\n```';
  let result = await generateIntentPlan('Write code');
  assert.deepEqual(result.steps, ['Read spec', 'Write tests', 'Implement code']);
  assert.equal(result.error, null);
  assert.deepEqual(fetchBody.response_format, { type: 'json_object' });

  responseContent = '```\n["Step A", "Step B"]\n```';
  result = await generateIntentPlan('Write code');
  assert.deepEqual(result.steps, ['Step A', 'Step B']);

  responseContent = '{"invalid": "format"}';
  result = await generateIntentPlan('Write code');
  assert.deepEqual(result.steps, []);
  assert.ok(result.error);
});