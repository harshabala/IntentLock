import './theme.js';
import { initializeStorageClient, captureStorageEpoch, sendStorageAction, guardStorageContinuation } from './storage-client.js';
import { sanitizeSessionHistory } from './privacy-utils.js';
import { activeElapsedMs, isSessionPaused } from './session-metrics.js';

let dataDeletionInProgress = false;
let privacyRevision = 0;

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'DATA_DELETION_STARTED' || message?.type === 'DATA_DELETED') {
    privacyRevision++;
    const content = document.getElementById('content');
    if (content) content.textContent = '';
  }
  if (message?.type === 'DATA_DELETION_STARTED') dataDeletionInProgress = true;
  if (message?.type === 'DATA_DELETED') dataDeletionInProgress = false;
});

function loadSessionHistory(callback) {
  const revision = privacyRevision;
  chrome.storage.local.get(['sessionHistory', 'privacyMutationState'], (result) => {
    if (dataDeletionInProgress || revision !== privacyRevision || result.privacyMutationState?.deleting) return;
    const rawHistory = Array.isArray(result.sessionHistory) ? result.sessionHistory : [];
    const sanitizedHistory = sanitizeSessionHistory(rawHistory);
    callback(sanitizedHistory);
  });
}

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

document.addEventListener('DOMContentLoaded', async () => {
  try { await initializeStorageClient(); }
  catch (error) {
    const status = document.createElement('p');
    status.setAttribute('role', 'alert');
    status.textContent = error.message;
    document.body.appendChild(status);
    return;
  }
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

  function showConfirmEndDialog(session, trigger, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    const h3 = document.createElement('h3');
    h3.id = 'popup-end-title';
    h3.textContent = 'End session?';
    dialog.setAttribute('aria-labelledby', h3.id);

    const p = document.createElement('p');
    const elapsed = Math.round(activeElapsedMs(session) / 60000);
    const events = Array.isArray(session.events) ? session.events : [];
    const storedOverrides = Array.isArray(session.overrides) ? session.overrides : [];
    const overrides = typeof session.overrideCount === 'number'
      ? session.overrideCount
      : storedOverrides.length > 0
        ? storedOverrides.length
        : events.filter((e) => e?.actionType === 'OVERRIDE').length;
    p.textContent = `${elapsed} minutes. ${overrides} override${overrides !== 1 ? 's' : ''}. End this session?`;

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'complete-btn';
    cancelBtn.textContent = 'Cancel';

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = 'End session';

    function closeDialog() {
      document.removeEventListener('keydown', onKeydown, true);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (trigger && typeof trigger.focus === 'function') trigger.focus();
    }

    // Modal keyboard contract: Escape cancels, Tab and Shift+Tab stay inside.
    function onKeydown(event) {
      if (!overlay.parentNode) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDialog();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [cancelBtn, confirmBtn].filter(button => !button.disabled);
      const index = focusable.indexOf(document.activeElement);
      event.preventDefault();
      const next = event.shiftKey
        ? focusable[(index <= 0 ? focusable.length : index) - 1]
        : focusable[(index + 1) % focusable.length];
      next?.focus();
    }
    document.addEventListener('keydown', onKeydown, true);

    cancelBtn.addEventListener('click', () => closeDialog());
    confirmBtn.addEventListener('click', () => {
      closeDialog();
      onConfirm();
    });

    actions.append(cancelBtn, confirmBtn);
    dialog.append(h3, p, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      overlay.classList.add('is-open');
    });
    cancelBtn.focus();
  }

  function renderIdle(sessionHistory) {
    content.textContent = '';
    const last = sessionHistory.length > 0 ? sessionHistory[sessionHistory.length - 1] : null;

    if (last) {
      const kicker = document.createElement('p');
      kicker.className = 'session-kicker';
      kicker.textContent = 'Last session';
      content.appendChild(kicker);
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
    const revision = privacyRevision;
    chrome.storage.local.get(['activeSession', 'llmBackoffUntil', 'privacyMutationState'], (result) => {
      if (dataDeletionInProgress || revision !== privacyRevision || result.privacyMutationState?.deleting) return;
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
        const elapsed = Math.round(activeElapsedMs(session) / 60000);
        if (isSessionPaused(session)) {
          timeEl.textContent = session.timeBudget
            ? `Paused · ${Math.max(0, session.timeBudget - elapsed)} min remaining`
            : `Paused · ${elapsed} min elapsed`;
          timeEl.classList.remove('time-exceeded');
          return;
        }
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
      btn.addEventListener('click', (e) => {
        if (dataDeletionInProgress) return;
        showConfirmEndDialog(session, e.currentTarget || btn, () => {
          const epoch = captureStorageEpoch();
          btn.disabled = true;
          sendStorageAction({ type: 'END_ACTIVE_SESSION', sessionId: session.id }, epoch).then(guardStorageContinuation(response => {
            if (!response.session) throw new Error('The session could not be ended.');
            chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html?report=last') });
            window.close();
          })).catch(error => {
            btn.disabled = false;
            const status = document.createElement('p');
            status.setAttribute('role', 'alert');
            status.textContent = error.message;
            content.appendChild(status);
          });
        });
      });
      content.appendChild(btn);

      const backoffUntil = result.llmBackoffUntil || 0;
      const isBackedOff = backoffUntil > Date.now();
      if (isBackedOff) {
        const notice = document.createElement('p');
        notice.className = 'muted-note';
        const minutesLeft = Math.ceil((backoffUntil - Date.now()) / 60000);
        notice.textContent = `AI check paused (~${minutesLeft} min). Local lock still active.`;
        content.appendChild(notice);
      }

      addViewStats(content);
      addFooter(content);
    });
  }

  updateUI();
});
