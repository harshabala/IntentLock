document.addEventListener('DOMContentLoaded', () => {
  const content = document.getElementById('content');

  function createHistoryEntry(session) {
    const events = Array.isArray(session.events) ? session.events : [];
    return {
      id: session.id,
      intent: session.intent,
      startTime: session.startTime,
      endTime: session.endTime,
      timeBudget: session.timeBudget,
      driftCount: events.filter(e => e.actionType === 'OVERRIDE').length,
      totalEvents: events.length
    };
  }

  chrome.storage.local.get(['activeSession', 'llmBackoffUntil'], (result) => {
    const session = result.activeSession;

    if (!session || !session.isActive) {
      content.textContent = '';
      const p1 = document.createElement('p');
      p1.className = 'no-session';
      p1.textContent = 'No active session.';
      const p2 = document.createElement('p');
      p2.className = 'no-session';
      p2.textContent = 'Open a new tab to declare intent.';
      content.append(p1, p2);
      addFooterLinks(content);
      return;
    }

    content.textContent = '';

    // Session intent display
    const intentBox = document.createElement('div');
    intentBox.className = 'session-intent';
    intentBox.textContent = session.intent;
    content.appendChild(intentBox);

    // Time display
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

    // End session button
    const btn = document.createElement('button');
    btn.className = 'complete-btn';
    btn.textContent = 'End session';
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'END_ACTIVE_SESSION' }, () => {
        chrome.runtime.sendMessage({ type: 'SESSION_CLEARED' });
        content.textContent = '';
        const p = document.createElement('p');
        p.className = 'no-session';
        p.textContent = 'Session ended.';
        content.appendChild(p);
        addFooterLinks(content);
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

    addFooterLinks(content);
  });

  function addFooterLinks(parent) {
    const footer = document.createElement('div');
    footer.className = 'popup-footer';

    const histLink = document.createElement('a');
    histLink.href = '#';
    histLink.className = 'popup-link';
    histLink.textContent = 'History';
    histLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
    });

    const sep = document.createElement('span');
    sep.className = 'history-sep';
    sep.textContent = '\u00B7';

    const diagLink = document.createElement('a');
    diagLink.href = '#';
    diagLink.className = 'popup-link';
    diagLink.textContent = 'Diagnostics';
    diagLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('diagnostics.html') });
    });

    const sep2 = document.createElement('span');
    sep2.className = 'history-sep';
    sep2.textContent = '\u00B7';

    const settingsLink = document.createElement('a');
    settingsLink.href = '#';
    settingsLink.className = 'popup-link';
    settingsLink.textContent = 'Settings';
    settingsLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });

    footer.append(histLink, sep, diagLink, sep2, settingsLink);
    parent.appendChild(footer);
  }
});
