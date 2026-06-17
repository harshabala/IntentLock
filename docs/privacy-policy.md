# Privacy Policy for IntentLock

**Effective Date:** June 17, 2026

IntentLock is a privacy-first browser extension designed to help you maintain focus and align your browsing actions with your stated intent. We believe your browsing history, intents, and keys are strictly your own. This Privacy Policy details how the extension handles data.

## 1. Local Data Storage

All data generated, entered, or collected by IntentLock is stored **solely on your local machine** using the Chrome Extension Storage APIs (`chrome.storage.local`). This includes:
- **Intent Declarations:** The focus statements and goals you declare at the start of a session.
- **Browsing History & Logs:** The metadata and URLs of active tabs monitored during a session.
- **Alignment Events & Drift Logs:** Heuristic evaluations, tab-switch counts, and drift-intervention history.

None of this data is transmitted, uploaded, or shared with external servers. It remains fully offline and under your complete control. You can view, export, or permanently delete all local data at any time through the extension's Options menu.

## 2. API Key & LLM Drift Evaluation

If you configure an OpenAI API key to enable LLM-powered drift detection:
- **Secure Session Memory:** The API key is stored strictly in secure session memory (`chrome.storage.session`). This ensures the key is stored in RAM and is **automatically cleared and destroyed** when you close the browser.
- **Direct API Communication:** When evaluating tab drift, the extension sends your current intent and page metadata directly to the official OpenAI API completions endpoint (`api.openai.com`). 
- **No Intermediary Servers:** There is no intermediary server or third-party proxy. The API key is never shared, leaked, or transmitted to any server other than OpenAI's secure API.

## 3. No Analytics or Telemetry

We do not track you. IntentLock has **zero** built-in:
- Third-party analytics (e.g., Google Analytics).
- Telemetry or crash reporting sent to external servers.
- Advertising trackers, cookies, or user profiling scripts.

Your usage patterns, success rates, and configuration settings are stored locally and are visible only to you.
