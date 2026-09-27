# Privacy Policy for IntentLock

**Public URL:** https://harshabala.github.io/IntentLock/privacy.html

**Effective Date:** August 24, 2026

IntentLock is a privacy-first browser extension designed to help you maintain focus and align your browsing actions with your stated intent. We believe your browsing history, intents, and keys are strictly your own. This Privacy Policy details how the extension handles data.

## 1. Local Data Storage

IntentLock stores session data, browsing metadata, settings, and diagnostic logs **locally by default** using the Chrome Extension Storage APIs (`chrome.storage.local` and, for API keys, `chrome.storage.session`). This includes:
- **Intent Declarations:** The focus statements and goals you declare at the start of a session.
- **Browsing History & Logs:** The metadata and URLs of active tabs monitored during a session.
- **Alignment Events & Drift Logs:** Heuristic evaluations, tab-switch counts, and drift-intervention history.

IntentLock does not use analytics, advertising, or telemetry services. You can view, export, or delete all local data through Settings (Options). Session history is automatically limited to the newest 100 entries from the last 30 days, and diagnostic logs to the newest 200 entries from the last 14 days; both are pruned in storage at startup and hourly. A session that is not ended within 24 hours is ended automatically and stops collecting.

## 2. API Key & LLM Drift Evaluation

If you enable tracking and configure a cloud or custom remote provider for LLM-powered features (optional providers include OpenAI, Google Gemini, Grok, Ollama, and LM Studio):
- **Key storage:** When `chrome.storage.session` is available, the API key is kept there and is **automatically cleared** when you close the browser. The key is never written to local storage; if session storage is unavailable, a key cannot be saved and AI checks stay off. Changing the provider or endpoint without re-entering the key removes it. The extension does not sync keys to a remote service.
- **Direct API Communication:** IntentLock sends the declared intent and minimized browsing context directly to the provider you selected. Page context is reduced to origins and bounded recent events; full paths, query strings, and fragments are not sent.
- **Provider choice matters:** The selected provider receives the request under its own privacy policy. Local providers such as Ollama and LM Studio keep the request on your machine. IntentLock does not operate an intermediary analytics or proxy service.
- **Tracking control:** Turning tracking off suppresses provider requests and browsing-event collection.

## 3. No Analytics or Telemetry

We do not track you. IntentLock has **zero** built-in:
- Third-party analytics (e.g., Google Analytics).
- Telemetry or crash reporting sent to external servers.
- Advertising trackers, cookies, or user profiling scripts.

Your usage patterns, success rates, and configuration settings are stored locally. Data sent to an explicitly selected remote provider is governed by that provider's terms and privacy policy.
