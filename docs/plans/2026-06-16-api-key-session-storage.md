# Task 1: API Key Migration and Secure Session Storage Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Secure the OpenAI API key by storing it in `chrome.storage.session` instead of `chrome.storage.local`, implement migration on startup/options load, update options UI text/notice, and update the test runner to mock session storage correctly.

**Architecture:** We will update `llm.js`'s `getApiKey()` helper to read from session storage with a local storage fallback. In `background.js` startup, we will check if a key exists in local storage and migrate it to session storage. In `options.js`, we will handle options load migration, saving to session storage, and clearing session storage on reset. In `options.html`, we will update the text description and add a notice. In `newtab.js`, we will check the API key from session storage with fallback. In `tests/llm.test.mjs`, we will update the mock to include `chrome.storage.session`.

**Tech Stack:** JavaScript (ES6+), Chrome Extension APIs (Manifest V3), Node.js Test Runner.

---

### Task 1.1: Mock chrome.storage.session in Tests

**Files:**
- Modify: `/Users/harshabalakrishnan/Documents/Projects/IntentLock/tests/llm.test.mjs`

**Step 1: Write mock for storage.session**
Update `globalThis.chrome` in `tests/llm.test.mjs` to define `chrome.storage.session`.

```javascript
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
```

**Step 2: Commit**
```bash
git add tests/llm.test.mjs
git commit -m "test: mock chrome.storage.session in llm test suite"
```

---

### Task 1.2: Update API Key Getter in llm.js

**Files:**
- Modify: `/Users/harshabalakrishnan/Documents/Projects/IntentLock/llm.js`

**Step 1: Update getApiKey()**
Modify `getApiKey()` to read from `chrome.storage.session` first, falling back to `chrome.storage.local`.

```javascript
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
```

**Step 2: Commit**
```bash
git add llm.js
git commit -m "security: update getApiKey helper to read from session storage with fallback"
```

---

### Task 1.3: Implement Background Migration Logic

**Files:**
- Modify: `/Users/harshabalakrishnan/Documents/Projects/IntentLock/background.js`

**Step 1: Implement migration on load/startup**
Add migration function in background.js startup logic:

```javascript
function migrateApiKeyToSession() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session && chrome.storage.local) {
    chrome.storage.local.get(['openaiApiKey'], (res) => {
      if (res && res.openaiApiKey) {
        chrome.storage.session.set({ openaiApiKey: res.openaiApiKey }, () => {
          chrome.storage.local.remove(['openaiApiKey'], () => {
            console.log("OpenAI API key migrated from local to session storage.");
          });
        });
      }
    });
  }
}
migrateApiKeyToSession();
```

**Step 2: Commit**
```bash
git add background.js
git commit -m "security: implement automatic api key migration in background worker"
```

---

### Task 1.4: Update Options Page logic (options.js)

**Files:**
- Modify: `/Users/harshabalakrishnan/Documents/Projects/IntentLock/options.js`

**Step 1: Update Load, Save, and Delete logic**
Modify `options.js` to query/migrate on load, save to `chrome.storage.session` on save, and clear session storage on delete.

**Step 2: Commit**
```bash
git add options.js
git commit -m "security: update options settings to use secure session storage for api key"
```

---

### Task 1.5: Update Options HTML Page (options.html)

**Files:**
- Modify: `/Users/harshabalakrishnan/Documents/Projects/IntentLock/options.html`

**Step 1: Modify settings description and add a notice**
Update description text and notice under LLM Configuration.

**Step 2: Commit**
```bash
git add options.html
git commit -m "docs: update settings page descriptions for secure session storage"
```

---

### Task 1.6: Update New Tab Page logic (newtab.js)

**Files:**
- Modify: `/Users/harshabalakrishnan/Documents/Projects/IntentLock/newtab.js`

**Step 1: Check for API Key in session storage**
Read API key from `chrome.storage.session` with fallback.

**Step 2: Commit**
```bash
git add newtab.js
git commit -m "security: update newtab api key notice check to look in session storage"
```
