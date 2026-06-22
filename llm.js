// llm.js

import {
  chatCompletion,
  cleanJsonString,
  getLlmConfig,
  isLlmConfigured,
} from './providers.js';
import { logError, ERROR_TYPES } from './error-log.js';
import {
  buildDriftCacheKey,
  getCachedDrift,
  setCachedDrift,
} from './drift-cache.js';

/**
 * Evaluate if a given URL + History matches the stated intent.
 * @param {string} intent User's stated aim
 * @param {string} url Current URL
 * @param {Array} history Recent events
 * @returns {Promise<{ isAligned: boolean, confidence: number }>}
 */
async function checkDriftLLM(intent, url, history) {
  const config = await getLlmConfig();
  if (!isLlmConfigured(config)) {
    return { isAligned: true, confidence: 1.0 };
  }

  const cacheKey = buildDriftCacheKey(intent, url, history);
  const cached = getCachedDrift(cacheKey);
  if (cached) {
    return cached;
  }

  const recentHistory = Array.isArray(history) ? history.slice(-5) : [];
  const historySummary = recentHistory
    .map((event) => `${event.actionType}: ${event.url || 'n/a'}`)
    .join('; ');

  const prompt = `
    You are IntentLock, an AI that enforces behavioral constraints.
    User's explicitly declared intent for this browsing session: "${intent}"
    User is currently on: ${url}
    Recent browsing events: ${historySummary || 'none'}

    Rule: Is the user Aligned with their intent, or Drifting?
    Respond ONLY in strict JSON format: {"aligned": boolean, "confidence": number}
    Do not add any additional text.
  `;

  try {
    const result = await chatCompletion(prompt, {
      jsonMode: true,
      maxTokens: 50,
      temperature: 0.1,
    });

    if (!result.ok) {
      if (result.error?.code === 'quota_backoff' || result.error?.code === 'quota_exceeded') {
        return { isAligned: true, confidence: 0, llmSkipped: result.error.code };
      }
      return { isAligned: true, confidence: 0 };
    }

    const parsed = JSON.parse(cleanJsonString(result.text));

    if (!parsed || typeof parsed.aligned !== 'boolean' || typeof parsed.confidence !== 'number') {
      await logError({
        type: ERROR_TYPES.API,
        message: 'LLM drift check returned an unexpected response shape.',
        details: { providerId: config.providerId },
        source: 'checkDriftLLM',
      });
      return { isAligned: true, confidence: 0 };
    }

    const driftResult = {
      isAligned: parsed.aligned,
      confidence: parsed.confidence,
    };
    setCachedDrift(cacheKey, driftResult);
    return driftResult;
  } catch (error) {
    await logError({
      type: ERROR_TYPES.API,
      message: 'LLM drift check failed to parse response.',
      details: { providerId: config.providerId, error: error.message },
      source: 'checkDriftLLM',
    });
    return { isAligned: true, confidence: 0 };
  }
}

/**
 * Generate a 3-step plan based on the user's intent to set expectations.
 * @param {string} intent User's stated aim
 * @returns {Promise<{ steps: string[], error: object|null }>}
 */
async function generateIntentPlan(intent) {
  const config = await getLlmConfig();
  if (!isLlmConfigured(config)) {
    return { steps: [], error: null };
  }

  const prompt = `
    The user declared the following intent for their browsing session: "${intent}"
    Create a very concise, practical 3-step checklist for them to accomplish this.
    Respond ONLY in strict JSON format: {"steps": ["Step 1", "Step 2", "Step 3"]}
  `;

  try {
    const result = await chatCompletion(prompt, {
      jsonMode: true,
      maxTokens: 100,
      temperature: 0.3,
    });

    if (!result.ok) {
      return { steps: [], error: result.error };
    }

    const parsed = JSON.parse(cleanJsonString(result.text));
    let steps = [];
    if (parsed && Array.isArray(parsed.steps)) {
      steps = parsed.steps;
    } else if (Array.isArray(parsed)) {
      steps = parsed;
    } else {
      await logError({
        type: ERROR_TYPES.API,
        message: 'Plan generation returned an unexpected response format.',
        details: { providerId: config.providerId },
        source: 'generateIntentPlan',
      });
      return { steps: [], error: { code: 'invalid_response', message: 'Plan generation returned an unexpected format.' } };
    }
    return { steps: steps.filter((step) => typeof step === 'string').slice(0, 3), error: null };
  } catch (err) {
    await logError({
      type: ERROR_TYPES.API,
      message: 'Plan generation failed to parse response.',
      details: { providerId: config.providerId, error: err.message },
      source: 'generateIntentPlan',
    });
    return { steps: [], error: { code: 'parse_error', message: 'Plan generation failed to parse response.' } };
  }
}

export { checkDriftLLM, generateIntentPlan, cleanJsonString };