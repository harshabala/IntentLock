// intervention.js — Fallback intervention page

let interventionState = null;
let currentTabId = null;
let dismissalPromise = null;

function isTrackableUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      resolve({ response, error: error ? new Error(error.message) : null });
    });
  });
}

function setError(message) {
  const error = document.getElementById('transition-error');
  if (error) error.textContent = message || 'Unable to update the lock.';
}

function replaceWithMessage(title, body) {
  const container = document.querySelector('.lock-container');
  if (!container) return null;
  container.textContent = '';
  container.setAttribute('aria-labelledby', 'intervention-title');
  container.setAttribute('aria-describedby', 'reason-text');
  const header = document.createElement('div');
  header.className = 'header';
  const h1 = document.createElement('h1');
  h1.id = 'intervention-title';
  h1.textContent = title;
  const p = document.createElement('p');
  p.id = 'reason-text';
  p.textContent = body;
  header.append(h1, p);
  container.appendChild(header);
  const error = document.createElement('p');
  error.id = 'transition-error';
  error.className = 'transition-error';
  error.setAttribute('role', 'alert');
  error.setAttribute('aria-live', 'polite');
  container.appendChild(error);
  return container;
}

function closeCurrentTab(onFailure = setError) {
  return new Promise((resolve) => chrome.tabs.getCurrent((tab) => {
    if (chrome.runtime.lastError || !tab?.id) {
      onFailure(chrome.runtime.lastError?.message || 'The lock was updated. Close this tab to continue.');
      resolve(false);
      return;
    }
    chrome.tabs.remove(tab.id, () => {
      if (chrome.runtime.lastError) {
        onFailure(chrome.runtime.lastError.message);
        resolve(false);
        return;
      }
      resolve(true);
    });
  }));
}

function dismissFallbackLock(message) {
  if (dismissalPromise) return dismissalPromise;
  interventionState = null;
  replaceWithMessage('Lock disabled', message);
  dismissalPromise = closeCurrentTab((error) => setError(error));
  return dismissalPromise;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'HIDE_INTERVENTION' || message?.type === 'DATA_DELETION_STARTED') {
    dismissFallbackLock(
      message.type === 'DATA_DELETION_STARTED'
        ? 'Your IntentLock data is being deleted. This tab will close.'
        : 'Tracking is disabled. This lock is no longer active.',
    );
    sendResponse?.({ hidden: true });
    return true;
  }
  return false;
});

async function submitTransition(transition, details = {}) {
  if (!interventionState?.sessionId || !interventionState?.nonce) {
    setError('This intervention is no longer active. Reload the tab to re-check.');
    return null;
  }

  const result = await sendRuntimeMessage({
    type: 'INTERVENTION_TRANSITION',
    transition,
    sessionId: interventionState.sessionId,
    nonce: interventionState.nonce,
    tabId: currentTabId,
    ...details,
  });
  if (!result.response?.ok) {
    setError(result.response?.error || result.error?.message || 'Unable to update the lock.');
    return null;
  }
  return result.response;
}

document.addEventListener('DOMContentLoaded', async () => {
  const reasonText = document.getElementById('reason-text');
  const currentIntent = document.getElementById('current-intent');
  const reflectionInput = document.getElementById('reflection-input');
  const returnBtn = document.getElementById('return-btn');
  const endSessionBtn = document.getElementById('end-session-btn');
  const reflectionForm = document.getElementById('reflection-form');
  const markRelated = document.getElementById('intentlock-mark-related');
  const dialog = document.querySelector('.lock-container');
  let transitionInFlight = false;

  function setTransitionBusy(busy) {
    transitionInFlight = busy;
    [returnBtn, endSessionBtn].forEach((button) => {
      if (button) button.disabled = busy;
    });
    if (reflectionForm) reflectionForm.setAttribute('aria-busy', String(busy));
    if (reflectionInput) reflectionInput.disabled = busy;
    if (markRelated) markRelated.disabled = busy;
  }

  function getFocusableElements() {
    return Array.from(dialog?.querySelectorAll('button, textarea, input, [href], [tabindex]:not([tabindex="-1"])') || [])
      .filter((element) => !element.disabled && element.offsetParent !== null);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const focusable = getFocusableElements();
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  const tabResult = await new Promise((resolve) => chrome.tabs.getCurrent(resolve));
  currentTabId = tabResult?.id ?? null;

  const [sessionResult, stateResult] = await Promise.all([
    new Promise((resolve) => chrome.storage.local.get(['activeSession'], resolve)),
    sendRuntimeMessage({ type: 'GET_INTERVENTION_STATE', tabId: currentTabId }),
  ]);

  if (sessionResult.activeSession?.isActive) {
    currentIntent.textContent = stateResult.response?.state?.intent
      || sessionResult.activeSession.intent
      || 'No active session intent.';
  } else {
    currentIntent.textContent = 'No active session found.';
  }

  interventionState = stateResult.response?.state || null;
  if (interventionState?.reason) reasonText.textContent = interventionState.reason;
  if (!interventionState) {
    setError(stateResult.response?.error || 'This intervention is no longer active.');
  }
  reflectionInput.focus();

  returnBtn.addEventListener('click', async () => {
    if (transitionInFlight) return;
    setTransitionBusy(true);
    try {
      const result = await submitTransition('close-tab');
      if (result?.ok) replaceWithMessage('Tab closed', 'The locked tab was closed.');
    } finally {
      setTransitionBusy(false);
    }
  });

  endSessionBtn.addEventListener('click', async () => {
    if (transitionInFlight) return;
    setTransitionBusy(true);
    try {
      const result = await submitTransition('end-session');
      if (!result) return;
      if (result.closeTab) {
        const closed = await closeCurrentTab((error) => setError(error));
        if (!closed) {
          const endedContainer = replaceWithMessage('Session ended', 'Your session has been recorded. Close this tab to finish.');
          const retryButton = document.createElement('button');
          retryButton.type = 'button';
          retryButton.className = 'primary-btn';
          retryButton.textContent = 'Close tab';
          retryButton.addEventListener('click', async () => {
            retryButton.disabled = true;
            const retryClosed = await closeCurrentTab((error) => setError(error));
            if (!retryClosed) retryButton.disabled = false;
          });
          endedContainer?.appendChild(retryButton);
          setError('The tab could not be closed automatically.');
        }
      } else {
        replaceWithMessage('Session ended', 'Your session has been recorded.');
      }
    } finally {
      setTransitionBusy(false);
    }
  });

  reflectionForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (transitionInFlight) return;
    const reflection = reflectionInput.value.trim();
    if (!reflection) {
      reflectionInput.focus();
      return;
    }

    setTransitionBusy(true);
    try {
      const result = await submitTransition('override', {
        reflection,
        markRelated: Boolean(markRelated?.checked),
      });
      if (!result) return;

      if (isTrackableUrl(interventionState.originalUrl)) {
        window.location.href = interventionState.originalUrl;
      } else {
        replaceWithMessage('Override accepted', 'You may continue your session.');
      }
    } finally {
      setTransitionBusy(false);
    }
  });
});
