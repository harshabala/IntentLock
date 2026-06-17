# IntentLock Production Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Secure the OpenAI API key, verify the override cooldown logic with tests, implement a premium onboarding wizard, scope down extension permissions, and prepare Chrome Web Store assets for production readiness.

**Architecture:** We will use `chrome.storage.session` to secure the API key in memory so that it is automatically cleared when the browser is closed, while providing automatic migration from `chrome.storage.local`. We will write a Node test suite `tests/cooldown.test.mjs` to test cooldown behaviors, build an inline CSS-designed onboarding wizard in `newtab.html/js/css`, scope down host permissions in `manifest.json`, and write documentation for store assets.

**Tech Stack:** JavaScript (ES6+), Chrome Extension APIs (Manifest V3), Node.js Test Runner.

---

### Task 1: API Key Migration and Secure Session Storage

**Files:**
- Modify: `llm.js:19-27`
- Modify: `background.js:166-237`
- Modify: `options.js:23-44`, `options.js:73-90`
- Modify: `options.html:15-26`
- Modify: `newtab.js:487-506`
- Modify: `tests/llm.test.mjs:4-14`

**Step 1: Write the failing test**
Update `tests/llm.test.mjs` to mock `chrome.storage.session`. Then we will write a test checking that `getApiKey()` retrieves the key from `chrome.storage.session` instead of `chrome.storage.local`.

```javascript
// Inside tests/llm.test.mjs:
globalThis.chrome = {
  storage: {
    local: {
      get: (keys, callback) => callback({}),
      set: (data, callback) => callback && callback(),
      remove: (keys, callback) => callback && callback()
    },
    session: {
      get: (keys, callback) => callback({ openaiApiKey: 'session-fake-key' })
    }
  }
};
```

**Step 2: Run test to verify it fails**
Run: `node --test tests/llm.test.mjs`
Expected: FAIL (or it passes but with wrong assumptions if we haven't updated `getApiKey` in `llm.js` to look in session storage).

**Step 3: Write minimal implementation**
1. Update `llm.js` `getApiKey()` to read from `chrome.storage.session` first.
2. Update `background.js` startup to run a migration function: if `openaiApiKey` is in `chrome.storage.local`, save to `chrome.storage.session` and remove from `chrome.storage.local`.
3. Update `options.js` to save keys to `chrome.storage.session`, read keys from `chrome.storage.session` (querying both for migration), and display a status notice if a migration occurred.
4. Update `options.html` to update the description of API key storage: "An OpenAI API key enables intent parsing and drift detection. For security, your key is stored in secure session memory and cleared when the browser is closed."
5. Update `newtab.js` to read the key from `chrome.storage.session`.

**Step 4: Run test to verify it passes**
Run: `node --test tests/llm.test.mjs tests/background.test.mjs`
Expected: PASS

**Step 5: Commit**
```bash
git add llm.js background.js options.js options.html newtab.js tests/llm.test.mjs
git commit -m "security: migrate API key to secure session storage"
```

---

### Task 2: Override Cooldown Unit Tests

**Files:**
- Create: `tests/cooldown.test.mjs`

**Step 1: Write the failing test**
Create `tests/cooldown.test.mjs` to verify:
1. `overrideCooldowns` is updated when receiving an `OVERRIDE_INTERVENTION` message containing sessionData.
2. `evaluateDrift` bypasses interventions for a domain under cooldown.
3. Subdomain matching is respected (e.g. cooldown on `facebook.com` covers `m.facebook.com`).
4. Cooldown is cleared on a new session or session cleared.

**Step 2: Run test to verify it fails**
Run: `node --test tests/cooldown.test.mjs`
Expected: FAIL (empty or failing because the test doesn't exist yet, or fails assertions).

**Step 3: Write minimal implementation**
Implement the test mocks for `chrome.tabs`, `chrome.storage`, `chrome.runtime`, and write the test assertions. Make sure it uses a mock time or sets cooldown timestamps relative to `Date.now()`.

**Step 4: Run test to verify it passes**
Run: `node --test tests/cooldown.test.mjs`
Expected: PASS

**Step 5: Commit**
```bash
git add tests/cooldown.test.mjs
git commit -m "test: add unit tests for override cooldown domain logic"
```

---

### Task 3: Minimal Onboarding Flow

**Files:**
- Modify: `newtab.js` (DOM check, adding `showOnboardingWizard`)
- Modify: `newtab.css` (adding wizard styles at the bottom)

**Step 1: Write the failing test**
Add a static smoke test case in `tests/static-smoke.test.mjs` to verify that `newtab.js` handles `hasSeenOnboarding` in local storage properly and exports or refers to onboarding functions.

**Step 2: Run test to verify it fails**
Run: `node --test tests/static-smoke.test.mjs`
Expected: FAIL

**Step 3: Write minimal implementation**
1. In `newtab.js`, update storage load to fetch `hasSeenOnboarding`. If falsy, call `showOnboardingWizard(container)`.
2. Implement `showOnboardingWizard(container)` to render Step 1 (Welcome message + explanation + Next button) and Step 2 (API Key input + session storage note + "Save & Start" + "Skip for now" buttons).
3. Clicking "Save & Start" or "Skip for now" will save `hasSeenOnboarding: true` in `chrome.storage.local` and show `showNewSessionForm(container)`.
4. Add CSS styles in `newtab.css` for `.onboarding-wizard`, `.wizard-step`, and buttons to look premium, minimal, matching the VV design system.

**Step 4: Run test to verify it passes**
Run: `node --test tests/static-smoke.test.mjs`
Expected: PASS

**Step 5: Commit**
```bash
git add newtab.js newtab.css tests/static-smoke.test.mjs
git commit -m "feat: add premium onboarding wizard to newtab"
```

---

### Task 4: Scope Down Host Permissions

**Files:**
- Modify: `manifest.json:24-33`

**Step 1: Write the failing test**
Update `tests/static-smoke.test.mjs` to assert that `manifest.json` does NOT contain `<all_urls>` in `host_permissions` or content script matches, and instead contains `https://*/*` and `http://*/*`.

**Step 2: Run test to verify it fails**
Run: `node --test tests/static-smoke.test.mjs`
Expected: FAIL

**Step 3: Write minimal implementation**
Modify `manifest.json` to replace `<all_urls>` with `["https://*/*", "http://*/*"]` in both `host_permissions` and `content_scripts[0].matches`.

**Step 4: Run test to verify it passes**
Run: `node --test tests/static-smoke.test.mjs`
Expected: PASS

**Step 5: Commit**
```bash
git add manifest.json tests/static-smoke.test.mjs
git commit -m "security: scope down host permissions in manifest"
```

---

### Task 5: Chrome Web Store Assets

**Files:**
- Create: `docs/privacy-policy.md`
- Create: `docs/store-assets-plan.md`
- Modify: `CHANGELOG.md`

**Step 1: Write the files**
Create the directories if necessary. Write the documents:
- `docs/privacy-policy.md`: Draft a privacy policy declaring that all intent data, browsed URLs, and API keys are stored purely locally on the user's device, with the API key stored in temporary secure session memory and sent only directly to OpenAI API endpoints for real-time drift alignment check.
- `docs/store-assets-plan.md`: Outline the Chrome Web Store listing metadata, including the 160-character summary, detailed description, key features, and visual asset plan (screenshots showing intent declaration, active session timer, and the intervention screen).
- `CHANGELOG.md`: Document all V1.2.1 updates (Phase 2 to 5 changes) under the `## Unreleased` section.

**Step 2: Verify files exist**
Ensure all documentation files exist and pass any markdown checks.

**Step 3: Commit**
```bash
git add docs/privacy-policy.md docs/store-assets-plan.md CHANGELOG.md
git commit -m "docs: create privacy policy and web store listing assets plan"
```
