import { sanitizeSessionHistory } from './privacy-utils.js';

let dataDeletionInProgress = false;

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'DATA_DELETION_STARTED') dataDeletionInProgress = true;
  if (message?.type === 'DATA_DELETED') dataDeletionInProgress = false;
});

function loadSessionHistory(callback) {
  chrome.storage.local.get(['sessionHistory'], (result) => {
    const rawHistory = Array.isArray(result.sessionHistory) ? result.sessionHistory : [];
    const sanitizedHistory = sanitizeSessionHistory(rawHistory);
    callback(sanitizedHistory);
  });
}

chrome.storage.local.get(['theme'], (result) => {
  const theme = result.theme || 'auto';
  const root = document.documentElement;
  if (theme === 'dark') {
    root.classList.remove('theme-light');
    root.classList.add('theme-dark');
  } else if (theme === 'light') {
    root.classList.remove('theme-dark');
    root.classList.add('theme-light');
  } else {
    root.classList.remove('theme-dark', 'theme-light');
  }
});

function formatSessionMinutes(session) {
  const start = session.startTime || 0;
  const end = session.endTime || Date.now();
  const fromRange = Math.max(0, Math.round((end - start) / 60000));
  if (fromRange > 0) return `${fromRange} min`;
  const fromActive = Math.round((session.activeMs || 0) / 60000);
  return `${Math.max(0, fromActive)} min`;
}

function quotedIntent(text) {
  const el = document.createElement('p');
  el.className = 'session-intent intent-quote intent-statement';
  el.textContent = text || '';
  return el;
}

document.addEventListener('DOMContentLoaded', () => {
  const content = document.getElementById('content');

  function addFooter(parent) {
    const footer = document.createElement('div');
    footer.className = 'popup-footer';

    const settingsLink = document.createElement('a');
    settingsLink.href = '#';
    settingsLink.className = 'popup-link';
    settingsLink.textContent = 'Settings';
    settingsLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });

    footer.appendChild(settingsLink);
    parent.appendChild(footer);
  }

  function addViewStats(parent) {
    const statsLink = document.createElement('a');
    statsLink.href = '#';
    statsLink.className = 'popup-link';
    statsLink.textContent = 'View stats';
    statsLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('analytics.html') });
    });
    parent.appendChild(statsLink);
  }

  function renderIdle(sessionHistory) {
    content.textContent = '';
    const last = sessionHistory.length > 0 ? sessionHistory[sessionHistory.length - 1] : null;

    if (last) {
      content.appendChild(quotedIntent(last.intent));
      const timeEl = document.createElement('p');
      timeEl.className = 'time-remaining';
      timeEl.textContent = formatSessionMinutes(last);
      content.appendChild(timeEl);
    } else {
      const p1 = document.createElement('p');
      p1.className = 'no-session';
      p1.textContent = 'No active session.';
      content.appendChild(p1);
    }

    const newTabLink = document.createElement('a');
    newTabLink.href = '#';
    newTabLink.className = 'popup-link';
    newTabLink.textContent = 'Open a new tab to declare intent.';
    newTabLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html') });
    });
    content.appendChild(newTabLink);

    addViewStats(content);
    addFooter(content);
  }

  function updateUI() {
    chrome.storage.local.get(['activeSession', 'llmBackoffUntil'], (result) => {
      const session = result.activeSession;

      if (!session || !session.isActive) {
        loadSessionHistory(renderIdle);
        return;
      }

      content.textContent = '';
      content.appendChild(quotedIntent(session.intent));

      const timeEl = document.createElement('p');
      timeEl.className = 'time-remaining';
      content.appendChild(timeEl);

      function updateTime() {
        const elapsed = Math.round((Date.now() - session.startTime) / 60000);
        if (session.timeBudget) {
          const remaining = session.timeBudget - elapsed;
          if (remaining > 0) {
            timeEl.textContent = `${remaining} min remaining`;
            timeEl.classList.remove('time-exceeded');
          } else {
            timeEl.textContent = `Budget exceeded by ${Math.abs(remaining)} min`;
            timeEl.classList.add('time-exceeded');
          }
        } else {
          timeEl.textContent = `${elapsed} min elapsed`;
        }
      }

      updateTime();
      setInterval(updateTime, 10000);

      const btn = document.createElement('button');
      btn.className = 'complete-btn';
      btn.textContent = 'End session';
      btn.addEventListener('click', () => {
        if (dataDeletionInProgress) return;
        chrome.runtime.sendMessage({ type: 'END_ACTIVE_SESSION', sessionId: session.id }, () => {
          chrome.runtime.sendMessage({ type: 'SESSION_CLEARED' }, () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html?report=last') });
            window.close();
          });
        });
      });
      content.appendChild(btn);

      const backoffUntil = result.llmBackoffUntil || 0;
      const isBackedOff = backoffUntil > Date.now();
      if (isBackedOff) {
        const notice = document.createElement('p');
        notice.className = 'no-session';
        notice.style.cssText = 'font-size:0.7rem;color:#888;margin:4px 0 0;';
        const minutesLeft = Math.ceil((backoffUntil - Date.now()) / 60000);
        notice.textContent = `AI check paused (~${minutesLeft} min). Heuristics still active.`;
        content.appendChild(notice);
      }

      addViewStats(content);
      addFooter(content);
    });
  }

  updateUI();
});
