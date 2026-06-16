// llm.js

/**
 * Utility for interacting with an LLM for intent checking.
 * Using a simple mock for now, but architected to accept a real API endpoint.
 */

const LLM_API_ENDPOINT = "https://api.openai.com/v1/chat/completions";

function cleanJsonString(str) {
  if (typeof str !== 'string') return '';
  let cleaned = str.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
  }
  return cleaned.trim();
}

async function getApiKey() {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage) {
      resolve(null);
      return;
    }
    if (chrome.storage.session) {
      chrome.storage.session.get(['openaiApiKey'], (sessionRes) => {
        if (sessionRes && sessionRes.openaiApiKey) {
          resolve(sessionRes.openaiApiKey);
        } else if (chrome.storage.local) {
          chrome.storage.local.get(['openaiApiKey'], (localRes) => {
            resolve(localRes ? localRes.openaiApiKey || null : null);
          });
        } else {
          resolve(null);
        }
      });
    } else if (chrome.storage.local) {
      chrome.storage.local.get(['openaiApiKey'], (localRes) => {
        resolve(localRes ? localRes.openaiApiKey || null : null);
      });
    } else {
      resolve(null);
    }
  });
}

/**
 * Evaluate if a given URL + History matches the stated intent.
 * @param {string} intent User's stated aim
 * @param {string} url Current URL
 * @param {Array} history Recent events
 * @returns {Promise<{ isAligned: boolean, confidence: number }>}
 */
async function checkDriftLLM(intent, url, history) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    console.warn("No LLM API key set. Failing open (no drift).");
    return { isAligned: true, confidence: 1.0 };
  }

  const prompt = `
    You are IntentLock, an AI that enforces behavioral constraints.
    User's explicitly declared intent for this browsing session: "${intent}"
    User is currently on: ${url}
    
    Rule: Is the user Aligned with their intent, or Drifting?
    Respond ONLY in strict JSON format: {"aligned": boolean, "confidence": number}
    Do not add any additional text.
  `;

  try {
    const response = await fetch(LLM_API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini", // fast model for low latency
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 50,
        response_format: { type: "json_object" }
      })
    });

    if (!response.ok) {
       console.error("LLM evaluation failed", response.status);
       return { isAligned: true, confidence: 0 }; 
     }

    const data = await response.json();
    const resultText = cleanJsonString(data.choices[0].message.content);
    const result = JSON.parse(resultText);

    if (!result || typeof result.aligned !== 'boolean' || typeof result.confidence !== 'number') {
      console.warn("Unexpected LLM response shape:", result);
      return { isAligned: true, confidence: 0 };
    }

    return {
      isAligned: result.aligned,
      confidence: result.confidence
    };
  } catch (error) {
    console.error("LLM check error:", error);
    return { isAligned: true, confidence: 0 }; // Fail open
  }
}

/**
 * Generate a 3-step plan based on the user's intent to set expectations.
 * @param {string} intent User's stated aim
 * @returns {Promise<string[]>} Array of steps
 */
async function generateIntentPlan(intent) {
  const apiKey = await getApiKey();
  if (!apiKey) return []; // Graceful degradation

  const prompt = `
    The user declared the following intent for their browsing session: "${intent}"
    Create a very concise, practical 3-step checklist for them to accomplish this.
    Respond ONLY in strict JSON format: {"steps": ["Step 1", "Step 2", "Step 3"]}
  `;

  try {
    const response = await fetch(LLM_API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 100,
        response_format: { type: "json_object" }
      })
    });

    if (!response.ok) return [];

    const data = await response.json();
    const resultText = cleanJsonString(data.choices[0].message.content);
    const parsed = JSON.parse(resultText);
    let steps = [];
    if (parsed && Array.isArray(parsed.steps)) {
      steps = parsed.steps;
    } else if (Array.isArray(parsed)) {
      steps = parsed;
    } else {
      return [];
    }
    return steps.filter(step => typeof step === 'string').slice(0, 3);
  } catch (err) {
    console.error("Plan generation error:", err);
    return [];
  }
}

export { checkDriftLLM, generateIntentPlan, cleanJsonString };
