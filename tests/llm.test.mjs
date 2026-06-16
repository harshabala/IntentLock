import assert from 'node:assert/strict';
import test from 'node:test';

// Mock chrome API
globalThis.chrome = {
  storage: {
    session: {
      get: (keys, callback) => {
        callback({ openaiApiKey: 'fake-api-key' });
      }
    },
    local: {
      get: (keys, callback) => {
        callback({});
      }
    }
  }
};

import { checkDriftLLM, generateIntentPlan, cleanJsonString } from '../llm.js';

test('cleanJsonString helper strips markdown fences and surrounding whitespaces', () => {
  const cases = [
    {
      input: '```json\n{"aligned": true, "confidence": 0.95}\n```',
      expected: '{"aligned": true, "confidence": 0.95}'
    },
    {
      input: '```\n{"aligned": false}\n```',
      expected: '{"aligned": false}'
    },
    {
      input: '  ```json\n{"steps": ["A", "B"]}\n```  ',
      expected: '{"steps": ["A", "B"]}'
    },
    {
      input: '{"aligned": true}',
      expected: '{"aligned": true}'
    }
  ];

  for (const { input, expected } of cases) {
    assert.equal(cleanJsonString(input), expected);
  }
});

test('checkDriftLLM passes response_format and parses markdown JSON correctly', async () => {
  let fetchBody = null;
  globalThis.fetch = async (url, options) => {
    fetchBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '```json\n{"aligned": false, "confidence": 0.88}\n```'
            }
          }
        ]
      })
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
              content: responseContent
            }
          }
        ]
      })
    };
  };

  // Case 1: Wrapped in steps property, with markdown formatting
  responseContent = '```json\n{"steps": ["Read spec", "Write tests", "Implement code"]}\n```';
  let steps = await generateIntentPlan('Write code');
  assert.deepEqual(steps, ["Read spec", "Write tests", "Implement code"]);
  assert.deepEqual(fetchBody.response_format, { type: 'json_object' });

  // Case 2: Flat array returned, with markdown formatting (fallback)
  responseContent = '```\n["Step A", "Step B"]\n```';
  steps = await generateIntentPlan('Write code');
  assert.deepEqual(steps, ["Step A", "Step B"]);

  // Case 3: Invalid structure, returns empty array
  responseContent = '{"invalid": "format"}';
  steps = await generateIntentPlan('Write code');
  assert.deepEqual(steps, []);
});
