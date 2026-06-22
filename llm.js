// llm.js

import {
  chatCompletion,
  cleanJsonString,
  getLlmConfig,
  isLlmConfigured,
} from './providers.js';

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
    console.warn('LLM not configured. Failing open (no drift).');
    return { isAligned: true, confidence: 1.0 };
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
    const resultText = await chatCompletion(prompt, {
      jsonMode: true,
      maxTokens: 50,
      temperature: 0.1,
    });

    if (!resultText) {
      return { isAligned: true, confidence: 0 };
    }

    const result = JSON.parse(cleanJsonString(resultText));

    if (!result || typeof result.aligned !== 'boolean' || typeof result.confidence !== 'number') {
      console.warn('Unexpected LLM response shape:', result);
      return { isAligned: true, confidence: 0 };
    }

    return {
      isAligned: result.aligned,
      confidence: result.confidence,
    };
  } catch (error) {
    console.error('LLM check error:', error);
    return { isAligned: true, confidence: 0 };
  }
}

/**
 * Generate a 3-step plan based on the user's intent to set expectations.
 * @param {string} intent User's stated aim
 * @returns {Promise<string[]>} Array of steps
 */
async function generateIntentPlan(intent) {
  const config = await getLlmConfig();
  if (!isLlmConfigured(config)) return [];

  const prompt = `
    The user declared the following intent for their browsing session: "${intent}"
    Create a very concise, practical 3-step checklist for them to accomplish this.
    Respond ONLY in strict JSON format: {"steps": ["Step 1", "Step 2", "Step 3"]}
  `;

  try {
    const resultText = await chatCompletion(prompt, {
      jsonMode: true,
      maxTokens: 100,
      temperature: 0.3,
    });

    if (!resultText) return [];

    const parsed = JSON.parse(cleanJsonString(resultText));
    let steps = [];
    if (parsed && Array.isArray(parsed.steps)) {
      steps = parsed.steps;
    } else if (Array.isArray(parsed)) {
      steps = parsed;
    } else {
      return [];
    }
    return steps.filter((step) => typeof step === 'string').slice(0, 3);
  } catch (err) {
    console.error('Plan generation error:', err);
    return [];
  }
}

export { checkDriftLLM, generateIntentPlan, cleanJsonString };