document.addEventListener('DOMContentLoaded', () => {
  const reasonText = document.getElementById('reason-text');
  const currentIntent = document.getElementById('current-intent');
  const reflectionInput = document.getElementById('reflection-input');
  const returnBtn = document.getElementById('return-btn');
  const reflectionForm = document.getElementById('reflection-form');

  chrome.storage.local.get(['activeSession', 'interventionState'], (result) => {
    if (result.activeSession && result.activeSession.isActive) {
      currentIntent.textContent = result.activeSession.intent;
    } else {
      currentIntent.textContent = 'No active session found.';
    }

    if (result.interventionState && result.interventionState.reason) {
      reasonText.textContent = result.interventionState.reason;
    }
  });

  returnBtn.addEventListener('click', () => {
    chrome.storage.local.remove(['interventionState'], () => {
      chrome.tabs.getCurrent((tab) => {
        chrome.tabs.remove(tab.id);
      });
    });
  });

  reflectionForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const reflection = reflectionInput.value.trim();
    if (!reflection) return;

    chrome.storage.local.get(['activeSession', 'interventionState'], (result) => {
      if (result.activeSession) {
        result.activeSession.events.push({
          timestamp: Date.now(),
          actionType: 'OVERRIDE',
          reflection: reflection
        });

        chrome.storage.local.set({ activeSession: result.activeSession }, () => {
          chrome.runtime.sendMessage({ type: 'OVERRIDE_INTERVENTION', sessionData: result.activeSession });

          const originalUrl = result.interventionState ? result.interventionState.originalUrl : null;
          chrome.storage.local.remove(['interventionState'], () => {
            if (originalUrl) {
              window.location.href = originalUrl;
            } else {
              const container = document.querySelector('.lock-container');
              container.textContent = '';

              const header = document.createElement('div');
              header.className = 'header';
              const h1 = document.createElement('h1');
              h1.textContent = 'Override accepted';
              const p = document.createElement('p');
              p.textContent = 'You may continue your session.';
              header.append(h1, p);
              container.appendChild(header);

              const hint = document.createElement('p');
              hint.className = 'navigate-hint';
              hint.textContent = 'Navigate away from this page when ready.';
              container.appendChild(hint);
            }
          });
        });
      }
    });
  });
});
