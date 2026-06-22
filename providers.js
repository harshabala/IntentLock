// providers.js — Multi-provider LLM adapter for IntentLock

import { classifyApiError, logError, ERROR_TYPES } from './error-log.js';

export const DEFAULT_PROVIDER_ID = 'openai';

export const PROVIDERS = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    apiStyle: 'openai',
    defaultModel: 'gpt-4o-mini',
    defaultBaseUrl: 'https://api.openai.com/v1/chat/completions',
    authType: 'bearer',
    requiresApiKey: true,
    keyHint: 'sk-...',
    keyPlaceholder: 'sk-...',
    description: 'GPT-4o-mini for fast drift checks and plan generation.',
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    apiStyle: 'gemini',
    defaultModel: 'gemini-2.0-flash',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    authType: 'query',
    requiresApiKey: true,
    keyHint: 'AIza... (from Google AI Studio)',
    keyPlaceholder: 'AIza...',
    description: 'Free-tier friendly Gemini models via Google AI Studio.',
  },
  grok: {
    id: 'grok',
    label: 'xAI Grok',
    apiStyle: 'openai',
    defaultModel: 'grok-2-latest',
    defaultBaseUrl: 'https://api.x.ai/v1/chat/completions',
    authType: 'bearer',
    requiresApiKey: true,
    keyHint: 'xai-...',
    keyPlaceholder: 'xai-...',
    description: 'Grok models via the xAI API.',
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    apiStyle: 'ollama',
    defaultModel: 'llama3.2',
    defaultBaseUrl: 'http://localhost:11434/api/chat',
    authType: 'none',
    requiresApiKey: false,
    keyHint: 'No key required',
    keyPlaceholder: 'Not required',
    description: 'Run models locally with Ollama on port 11434.',
    isLocal: true,
  },
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    apiStyle: 'openai',
    defaultModel: 'local-model',
    defaultBaseUrl: 'http://localhost:1234/v1/chat/completions',
    authType: 'none',
    requiresApiKey: false,
    keyHint: 'No key required',
    keyPlaceholder: 'Not required (optional)',
    description: 'OpenAI-compatible local server from LM Studio on port 1234.',
    isLocal: true,
  },
  custom: {
    id: 'custom',
    label: 'Custom provider',
    apiStyle: 'openai',
    defaultModel: '',
    defaultBaseUrl: '',
    authType: 'bearer',
    requiresApiKey: true,
    keyHint: 'Provider API key',
    keyPlaceholder: 'Your API key',
    description: 'Any OpenAI-compatible, Gemini, or Ollama endpoint.',
  },
};

export const PROVIDER_LIST = Object.values(PROVIDERS);

export function cleanJsonString(str) {
  if (typeof str !== 'string') return '';
  let cleaned = str.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '');
  }
  return cleaned.trim();
}

export function getProvider(providerId) {
  return PROVIDERS[providerId] || PROVIDERS[DEFAULT_PROVIDER_ID];
}

export function getDefaultProviderConfig(providerId = DEFAULT_PROVIDER_ID) {
  const provider = getProvider(providerId);
  return {
    providerId: provider.id,
    model: provider.defaultModel,
    baseUrl: provider.defaultBaseUrl,
    customLabel: '',
    authType: provider.authType,
    apiStyle: provider.apiStyle,
  };
}

export function providerRequiresApiKey(providerId, config = {}) {
  if (providerId === 'custom') {
    return (config.authType || 'bearer') !== 'none';
  }
  return getProvider(providerId).requiresApiKey;
}

export function validateApiKey(providerId, key, config = {}) {
  const trimmed = (key || '').trim();
  if (!trimmed) {
    return providerRequiresApiKey(providerId, config) ? 'API key is required for this provider.' : null;
  }
  if (providerId === 'openai' && trimmed.startsWith('AIza')) {
    return 'This looks like a Google Gemini key. Switch provider to Google Gemini above.';
  }
  if (providerId === 'gemini' && trimmed.startsWith('sk-')) {
    return 'This looks like an OpenAI key. Switch provider to OpenAI above.';
  }
  if (providerId === 'openai' && !trimmed.startsWith('sk-')) {
    return 'OpenAI keys typically start with "sk-".';
  }
  if (providerId === 'grok' && !trimmed.startsWith('xai-') && trimmed.length < 20) {
    return 'xAI keys typically start with "xai-".';
  }
  if (providerId === 'gemini' && trimmed.length < 20) {
    return 'Enter a valid Gemini API key from Google AI Studio.';
  }
  return null;
}

async function throwApiFailure(response, providerId) {
  const bodyText = await response.text().catch(() => '');
  const apiError = classifyApiError(response.status, bodyText, providerId);
  const err = new Error(apiError.message);
  err.apiError = apiError;
  throw err;
}

export function validateProviderConfig(config) {
  const providerId = config?.providerId || DEFAULT_PROVIDER_ID;
  const provider = getProvider(providerId);

  if (providerId === 'custom') {
    if (!config.customLabel?.trim()) return 'Enter a name for your custom provider.';
    if (!config.baseUrl?.trim()) return 'Enter the API endpoint URL.';
    if (!config.model?.trim()) return 'Enter the model name.';
    try {
      new URL(config.baseUrl.trim());
    } catch {
      return 'Enter a valid API endpoint URL.';
    }
  }

  if ((provider.isLocal || providerId === 'custom') && config.baseUrl?.trim()) {
    try {
      new URL(config.baseUrl.trim());
    } catch {
      return 'Enter a valid base URL.';
    }
  }

  return null;
}

export function isLlmConfigured(config) {
  const providerId = config?.providerId || DEFAULT_PROVIDER_ID;
  const provider = getProvider(providerId);

  if (providerId === 'custom') {
    if (!config.baseUrl?.trim() || !config.model?.trim()) return false;
    if (providerRequiresApiKey(providerId, config) && !config.apiKey) return false;
    return true;
  }

  if (provider.isLocal) return true;
  return Boolean(config.apiKey);
}

export async function getLlmConfig() {
  const fallback = {
    ...getDefaultProviderConfig(DEFAULT_PROVIDER_ID),
    provider: getProvider(DEFAULT_PROVIDER_ID),
    apiKey: null,
  };

  if (typeof chrome === 'undefined' || !chrome.storage) {
    return fallback;
  }

  return new Promise((resolve) => {
    chrome.storage.local.get(['llmProviderConfig', 'openaiApiKey'], (localRes) => {
      const stored = { ...getDefaultProviderConfig(), ...(localRes?.llmProviderConfig || {}) };
      const providerId = stored.providerId || DEFAULT_PROVIDER_ID;
      const provider = getProvider(providerId);

      const finish = (apiKey) => {
        resolve({
          providerId,
          provider,
          apiKey,
          model: stored.model || provider.defaultModel,
          baseUrl: stored.baseUrl || provider.defaultBaseUrl,
          customLabel: stored.customLabel || '',
          authType: stored.authType || provider.authType,
          apiStyle: stored.apiStyle || provider.apiStyle,
        });
      };

      if (chrome.storage.session) {
        chrome.storage.session.get(['llmApiKey', 'openaiApiKey'], (sessionRes) => {
          const apiKey = sessionRes?.llmApiKey || sessionRes?.openaiApiKey || localRes?.openaiApiKey || null;
          finish(apiKey);
        });
      } else {
        finish(localRes?.openaiApiKey || null);
      }
    });
  });
}

async function callOpenAiCompatible({ baseUrl, apiKey, model, prompt, jsonMode, maxTokens, temperature, authType, providerId }) {
  const headers = { 'Content-Type': 'application/json' };
  let url = baseUrl;

  if (authType === 'bearer' && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  } else if (authType === 'header' && apiKey) {
    headers['x-api-key'] = apiKey;
  } else if (authType === 'query' && apiKey) {
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}key=${encodeURIComponent(apiKey)}`;
  }

  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature,
    max_tokens: maxTokens,
  };
  if (jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    await throwApiFailure(response, providerId);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? null;
}

async function callGemini({ baseUrl, apiKey, model, prompt, jsonMode, maxTokens, temperature, providerId }) {
  const root = baseUrl.replace(/\/$/, '');
  const url = `${root}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
    },
  };
  if (jsonMode) {
    body.generationConfig.responseMimeType = 'application/json';
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    await throwApiFailure(response, providerId);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
}

async function callOllama({ baseUrl, model, prompt, jsonMode, maxTokens, temperature, providerId }) {
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    options: { temperature, num_predict: maxTokens },
  };
  if (jsonMode) {
    body.format = 'json';
  }

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    await throwApiFailure(response, providerId);
  }

  const data = await response.json();
  return data.message?.content ?? null;
}

export async function chatCompletion(prompt, options = {}) {
  const { jsonMode = true, maxTokens = 100, temperature = 0.1 } = options;
  const config = await getLlmConfig();

  if (!isLlmConfigured(config)) {
    return { ok: false, error: { code: 'not_configured', message: 'LLM provider is not configured.', providerId: config.providerId } };
  }

  const apiStyle = config.providerId === 'custom'
    ? (config.apiStyle || 'openai')
    : config.provider.apiStyle;

  try {
    let text = null;
    switch (apiStyle) {
      case 'openai':
        text = await callOpenAiCompatible({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          model: config.model,
          prompt,
          jsonMode,
          maxTokens,
          temperature,
          authType: config.authType,
          providerId: config.providerId,
        });
        break;
      case 'gemini':
        text = await callGemini({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          model: config.model,
          prompt,
          jsonMode,
          maxTokens,
          temperature,
          providerId: config.providerId,
        });
        break;
      case 'ollama':
        text = await callOllama({
          baseUrl: config.baseUrl,
          model: config.model,
          prompt,
          jsonMode,
          maxTokens,
          temperature,
          providerId: config.providerId,
        });
        break;
      default:
        return { ok: false, error: { code: 'unsupported_provider', message: 'Unsupported API format.', providerId: config.providerId } };
    }

    if (!text) {
      const emptyError = { code: 'empty_response', message: 'API returned an empty response.', providerId: config.providerId };
      await logError({
        type: ERROR_TYPES.API,
        message: emptyError.message,
        details: emptyError,
        source: 'chatCompletion',
      });
      return { ok: false, error: emptyError };
    }

    return { ok: true, text };
  } catch (error) {
    const apiError = error.apiError || classifyApiError(0, error.message, config.providerId);
    await logError({
      type: ERROR_TYPES.API,
      message: apiError.message,
      details: apiError,
      source: 'chatCompletion',
    });
    return { ok: false, error: apiError };
  }
}