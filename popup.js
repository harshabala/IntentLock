import { summarizeWeek, formatWeekExport, PRIVACY_COPY } from './session-metrics.js';

// Load and apply theme override as early as possible
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

document.addEventListener('DOMContentLoaded', () => {
  const content = document.getElementById('content');

  function updateUI() {
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

        renderWeekGlanceSection(content);
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

      renderWeekGlanceSection(content);
    });
  }

  function renderWeekGlanceSection(parentContainer) {
    chrome.storage.local.get(['sessionHistory'], (histResult) => {
      const sessionHistory = histResult.sessionHistory || [];
      const weekGlance = document.createElement('div');
      weekGlance.className = 'week-glance';

      const heading = document.createElement('h3');
      heading.textContent = 'This week';
      weekGlance.appendChild(heading);

      const summary = summarizeWeek(sessionHistory, Date.now());

      if (summary.sessionCount === 0) {
        const emptyP = document.createElement('p');
        emptyP.className = 'no-session';
        emptyP.textContent = 'No sessions this week yet. Open a new tab to start one.';
        weekGlance.appendChild(emptyP);
      } else {
        const createGlanceRow = (label, value) => {
          const row = document.createElement('div');
          row.className = 'glance-row';
          const labelSpan = document.createElement('span');
          labelSpan.className = 'glance-label';
          labelSpan.textContent = label;
          const valueSpan = document.createElement('span');
          valueSpan.className = 'glance-value';
          valueSpan.textContent = value;
          row.append(labelSpan, valueSpan);
          return row;
        };

        weekGlance.appendChild(createGlanceRow('Sessions', `${summary.sessionCount}`));
        weekGlance.appendChild(
          createGlanceRow(
            'Avg on-intent',
            summary.avgOnIntentRatio != null ? `${Math.round(summary.avgOnIntentRatio * 100)}%` : '—'
          )
        );
        if (summary.bestDay) {
          weekGlance.appendChild(createGlanceRow('Best day', `${summary.bestDay}`));
        }

        const exportActions = document.createElement('div');
        exportActions.className = 'export-actions';

        const exportBtn = document.createElement('button');
        exportBtn.id = 'export-week-btn';
        exportBtn.className = 'complete-btn';
        exportBtn.textContent = 'Export week as text';

        const statusSpan = document.createElement('span');
        statusSpan.className = 'export-status';

        exportBtn.addEventListener('click', async () => {
          const text = formatWeekExport(summary, Date.now());
          let copied = false;
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            try {
              await navigator.clipboard.writeText(text);
              copied = true;
              statusSpan.textContent = 'Copied to clipboard.';
              setTimeout(() => {
                if (statusSpan.textContent === 'Copied to clipboard.') {
                  statusSpan.textContent = '';
                }
              }, 3000);
            } catch (e) {
              copied = false;
            }
          }
          if (!copied) {
            try {
              const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `intentlock-week-${new Date().toISOString().slice(0, 10)}.txt`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
              statusSpan.textContent = 'Copied to clipboard.';
              setTimeout(() => {
                if (statusSpan.textContent === 'Copied to clipboard.') {
                  statusSpan.textContent = '';
                }
              }, 3000);
            } catch (err) {
              statusSpan.textContent = 'Export failed.';
            }
          }
        });

        exportActions.append(exportBtn, statusSpan);
        weekGlance.appendChild(exportActions);
      }

      const caveatP = document.createElement('p');
      caveatP.className = 'method-caveat';
      caveatP.textContent = 'Averages cover sessions ended in the last 7 days; unscored sessions are excluded.';
      weekGlance.appendChild(caveatP);

      const privacyP = document.createElement('p');
      privacyP.className = 'privacy-copy';
      privacyP.textContent = PRIVACY_COPY;
      weekGlance.appendChild(privacyP);

      parentContainer.appendChild(weekGlance);
      addFooterLinks(parentContainer);
    });
  }

  updateUI();

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
