// providers.js — Multi-provider LLM adapter for IntentLock

import { classifyApiError, logError, ERROR_TYPES } from './error-log.js';
import {
  isLlmBackedOff,
  parseRetryAfterMs,
  setQuotaBackoff,
  shouldLogQuotaError,
} from './llm-backoff.js';
import { redactSecrets } from './privacy-utils.js';
import { isStorageDeletionActive } from './storage-queue.js';

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
    defaultModel: 'gemini-2.0-flash-lite',
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
const MAX_PROVIDER_CONCURRENCY = 2;
const MAX_PROMPT_LENGTH = 16_000;
const PROVIDER_TIMEOUT_MS = 10_000;
const inFlightRequests = new Map();
const activeProviderControllers = new Set();

if (typeof chrome !== 'undefined') {
  chrome.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName !== 'local' || changes.trackingEnabled?.newValue !== false) return;
    activeProviderControllers.forEach((controller) => controller.abort());
  });
}

function trackingDisabledResult(providerId) {
  return {
    ok: false,
    error: {
      code: 'tracking_disabled',
      message: 'LLM calls are disabled while tracking is off.',
      providerId,
    },
  };
}

async function assertTrackingEnabled(providerId) {
  if (isStorageDeletionActive()) {
    const error = new Error('LLM calls are disabled while data deletion is in progress.');
    error.code = 'data_deletion';
    error.providerId = providerId;
    throw error;
  }
  if (await trackingIsDisabled()) {
    const error = new Error('LLM calls are disabled while tracking is off.');
    error.code = 'tracking_disabled';
    error.providerId = providerId;
    throw error;
  }
}

async function fetchWithTimeout(url, options, timeoutMs = PROVIDER_TIMEOUT_MS) {
  const controller = options.controller
    || (typeof AbortController === 'function' ? new AbortController() : null);
  const requestOptions = { ...options };
  delete requestOptions.controller;
  if (controller) activeProviderControllers.add(controller);
  const timer = setTimeout(() => controller?.abort(), timeoutMs);
  try {
    return await fetch(url, controller ? { ...requestOptions, signal: controller.signal } : requestOptions);
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('Provider request timed out.');
      timeoutError.code = 'provider_timeout';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (controller) activeProviderControllers.delete(controller);
  }
}

function createProviderController() {
  if (typeof AbortController !== 'function') return null;
  const controller = new AbortController();
  activeProviderControllers.add(controller);
  return controller;
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function validateProviderEndpoint(providerId, baseUrl) {
  const provider = PROVIDERS[providerId];
  if (!provider) return 'Select a supported provider.';
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return 'Enter a valid API endpoint URL.';
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    return 'Endpoint must use HTTP(S) without embedded credentials.';
  }
  if (providerId === 'custom') {
    if (!isLoopbackHostname(parsed.hostname) && parsed.protocol !== 'https:') {
      return 'Custom cloud endpoints must use HTTPS; HTTP is allowed only for localhost.';
    }
    return null;
  }
  if (provider.isLocal) {
    return isLoopbackHostname(parsed.hostname)
      ? null
      : 'Local providers must use a loopback endpoint.';
  }
  const expected = new URL(provider.defaultBaseUrl);
  if (
    parsed.origin !== expected.origin ||
    parsed.pathname !== expected.pathname ||
    parsed.search ||
    parsed.hash
  ) {
    return 'Built-in cloud provider endpoints cannot be overridden.';
  }
  return null;
}

export function cleanJsonString(str) {
  if (typeof str !== 'string') return '';
  let cleaned = str.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '');
  }
  return cleaned.trim();
}

export function getProvider(providerId) {
  return PROVIDERS[providerId] || null;
}

export function getDefaultProviderConfig(providerId = DEFAULT_PROVIDER_ID) {
  const provider = PROVIDERS[providerId] || PROVIDERS[DEFAULT_PROVIDER_ID];
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
  return Boolean(getProvider(providerId)?.requiresApiKey);
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
  err.bodyText = bodyText;
  err.status = response.status;
  throw err;
}

export function validateProviderConfig(config) {
  const providerId = config?.providerId;
  if (!providerId || !PROVIDERS[providerId]) return 'Select a supported provider.';
  const provider = PROVIDERS[providerId];
  const baseUrl = config?.baseUrl?.trim() || provider.defaultBaseUrl;

  if (providerId === 'custom') {
    if (!config.customLabel?.trim()) return 'Enter a name for your custom provider.';
    if (!config.baseUrl?.trim()) return 'Enter the API endpoint URL.';
    if (!config.model?.trim()) return 'Enter the model name.';
  }

  const endpointError = validateProviderEndpoint(providerId, baseUrl);
  if (endpointError) return endpointError;

  return null;
}

export function isLlmConfigured(config) {
  const providerId = config?.providerId;
  const provider = (config?.provider && config.provider.id === providerId)
    ? config.provider
    : getProvider(providerId);
  if (!providerId || !provider) return false;
  if (validateProviderConfig({ ...config, providerId, baseUrl: config?.baseUrl || provider.defaultBaseUrl }) !== null) {
    return false;
  }

  if (providerId === 'custom') {
    if (!config.baseUrl?.trim() || !config.model?.trim()) return false;
    if (providerRequiresApiKey(providerId, config) && !config.apiKey) return false;
    return true;
  }

  if (provider.isLocal) return true;
  return Boolean(config.apiKey);
}

export async function getLlmConfig() {
  const unconfigured = {
    providerId: null,
    provider: null,
    apiKey: null,
    model: '',
    baseUrl: '',
    customLabel: '',
    authType: 'none',
    apiStyle: '',
  };

  if (typeof chrome === 'undefined' || !chrome.storage) {
    return unconfigured;
  }

  return new Promise((resolve) => {
    chrome.storage.local.get(['llmProviderConfig', 'llmApiKey', 'openaiApiKey'], (localRes) => {
      const stored = localRes?.llmProviderConfig || {};
      const providerId = stored.providerId;
      const provider = getProvider(providerId);
      if (!provider) {
        resolve({ ...unconfigured, providerId: providerId || null });
        return;
      }

      const finish = (apiKey) => {
        resolve({
          providerId,
          provider,
          apiKey,
          model: stored.model || provider.defaultModel,
          baseUrl: providerId === 'custom'
            ? (stored.baseUrl || provider.defaultBaseUrl)
            : provider.defaultBaseUrl,
          customLabel: stored.customLabel || '',
          authType: providerId === 'custom'
            ? (stored.authType || provider.authType)
            : provider.authType,
          apiStyle: stored.apiStyle || provider.apiStyle,
        });
      };

      if (chrome.storage.session) {
        chrome.storage.session.get(['llmApiKey', 'openaiApiKey'], (sessionRes) => {
          const apiKey = sessionRes?.llmApiKey
            || sessionRes?.openaiApiKey
            || localRes?.llmApiKey
            || localRes?.openaiApiKey
            || null;
          finish(apiKey);
        });
      } else {
        finish(localRes?.llmApiKey || localRes?.openaiApiKey || null);
      }
    });
  });
}

async function callOpenAiCompatible({ baseUrl, apiKey, model, prompt, jsonMode, maxTokens, temperature, authType, providerId }) {
  const headers = { 'Content-Type': 'application/json' };
  let url = baseUrl;
  const effectiveAuthType = providerId === 'custom'
    ? authType
    : (getProvider(providerId)?.authType || 'bearer');

  if (effectiveAuthType === 'bearer' && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  } else if (effectiveAuthType === 'header' && apiKey) {
    headers['x-api-key'] = apiKey;
  } else if (effectiveAuthType === 'query' && apiKey) {
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

  const controller = createProviderController();
  try {
    await assertTrackingEnabled(providerId);
  } catch (error) {
    if (controller) activeProviderControllers.delete(controller);
    throw error;
  }
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    controller,
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

  const controller = createProviderController();
  try {
    await assertTrackingEnabled(providerId);
  } catch (error) {
    if (controller) activeProviderControllers.delete(controller);
    throw error;
  }
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    controller,
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

  const controller = createProviderController();
  try {
    await assertTrackingEnabled(providerId);
  } catch (error) {
    if (controller) activeProviderControllers.delete(controller);
    throw error;
  }
  const response = await fetchWithTimeout(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    controller,
  });

  if (!response.ok) {
    await throwApiFailure(response, providerId);
  }

  const data = await response.json();
  return data.message?.content ?? null;
}

async function chatCompletionInternal(prompt, options = {}) {
  const { jsonMode = true, maxTokens = 100, temperature = 0.1 } = options;
  if (isStorageDeletionActive()) {
    return {
      ok: false,
      error: {
        code: 'data_deletion',
        message: 'LLM calls are disabled while data deletion is in progress.',
      },
    };
  }
  const config = await getLlmConfig();

  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    const tracking = await new Promise((resolve) => {
      chrome.storage.local.get(['trackingEnabled'], (result) => resolve(result?.trackingEnabled));
    });
    if (tracking === false) {
      return trackingDisabledResult(config.providerId);
    }
  }

  const configError = validateProviderConfig(config);
  if (configError) {
    const error = { code: 'invalid_provider_config', message: configError, providerId: config.providerId };
    await logError({ type: ERROR_TYPES.CONFIG, message: configError, details: redactSecrets(error), source: 'chatCompletion' });
    return { ok: false, error };
  }

  if (!isLlmConfigured(config)) {
    return { ok: false, error: { code: 'not_configured', message: 'LLM provider is not configured.', providerId: config.providerId } };
  }

  if (isLlmBackedOff()) {
    return {
      ok: false,
      error: {
        code: 'quota_backoff',
        message: 'LLM calls paused after a quota error. Heuristic drift still works. Retry later or switch models in Settings.',
        providerId: config.providerId,
      },
    };
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
    if (error?.code === 'tracking_disabled') {
      return trackingDisabledResult(error.providerId || config.providerId);
    }
    const bodyText = error.bodyText || error.message || '';
    const apiError = error.apiError || classifyApiError(error.status || 0, bodyText, config.providerId);

    if (apiError.code === 'quota_exceeded') {
      setQuotaBackoff({ retryAfterMs: parseRetryAfterMs(bodyText) });
      if (shouldLogQuotaError()) {
        const modelHint = config.providerId === 'gemini'
          ? ' Try model gemini-2.0-flash-lite in Advanced settings, or wait for quota reset.'
          : '';
        await logError({
          type: ERROR_TYPES.API,
          message: `${apiError.message}${modelHint}`,
          details: { ...apiError, model: config.model },
          source: 'chatCompletion',
        });
      }
    } else {
      await logError({
        type: ERROR_TYPES.API,
        message: apiError.message,
        details: apiError,
        source: 'chatCompletion',
      });
    }

    return { ok: false, error: apiError };
  }
}

export async function chatCompletion(prompt, options = {}) {
  if (typeof prompt !== 'string' || prompt.length > MAX_PROMPT_LENGTH) {
    return { ok: false, error: { code: 'prompt_too_large', message: 'Provider prompt exceeds the safety limit.' } };
  }
  const key = JSON.stringify([prompt, options]);
  const existing = inFlightRequests.get(key);
  if (existing) return existing;
  if (inFlightRequests.size >= MAX_PROVIDER_CONCURRENCY) {
    return { ok: false, error: { code: 'provider_busy', message: 'Another provider check is already in progress.' } };
  }
  const request = chatCompletionInternal(prompt, {
    ...options,
    maxTokens: Math.max(1, Math.min(Number.isFinite(options.maxTokens) ? options.maxTokens : 100, 500)),
  });
  inFlightRequests.set(key, request);
  try {
    return await request;
  } finally {
    inFlightRequests.delete(key);
  }
}

async function trackingIsDisabled() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return false;
  return new Promise((resolve) => {
    chrome.storage.local.get(['trackingEnabled'], (result) => resolve(result?.trackingEnabled === false));
  });
}
