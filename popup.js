document.addEventListener('DOMContentLoaded', () => {
  const content = document.getElementById('content');

  chrome.storage.local.get(['activeSession'], (result) => {
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
      session.isActive = false;
      session.endTime = Date.now();

      chrome.storage.local.get(['sessionHistory'], (histResult) => {
        const history = histResult.sessionHistory || [];
        history.push({
          id: session.id,
          intent: session.intent,
          startTime: session.startTime,
          endTime: session.endTime,
          timeBudget: session.timeBudget,
          driftCount: session.events.filter(e => e.actionType === 'OVERRIDE').length,
          totalEvents: session.events.length,
          events: session.events
        });
        if (history.length > 100) history.shift();

        chrome.storage.local.set({ activeSession: session, sessionHistory: history }, () => {
          chrome.runtime.sendMessage({ type: 'SESSION_CLEARED' });
          content.textContent = '';
          const p = document.createElement('p');
          p.className = 'no-session';
          p.textContent = 'Session ended.';
          content.appendChild(p);
          addFooterLinks(content);
        });
      });
    });
    content.appendChild(btn);

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

    const settingsLink = document.createElement('a');
    settingsLink.href = '#';
    settingsLink.className = 'popup-link';
    settingsLink.textContent = 'Settings';
    settingsLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });

    footer.append(histLink, sep, settingsLink);
    parent.appendChild(footer);
  }
});
