let privacyRevision = 0;
chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'DATA_DELETION_STARTED' || message?.type === 'DATA_DELETED') {
    privacyRevision++;
    const summary = document.getElementById('week-summary');
    if (summary) summary.textContent = '';
  }
});
import { summarizeWeek, PRIVACY_COPY } from './session-metrics.js';
import { sanitizeSessionHistory } from './privacy-utils.js';

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
    root.classList.remove('theme-light');
    const colorSchemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
    const syncAutoTheme = () => {
      root.classList.toggle('theme-dark', colorSchemeMedia.matches);
    };
    syncAutoTheme();
    colorSchemeMedia.addEventListener('change', syncAutoTheme);
  }
});

function createGlanceRow(label, value) {
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
}

document.addEventListener('DOMContentLoaded', () => {
  const weekGlance = document.getElementById('week-summary');
  if (!weekGlance) return;

  const revision = privacyRevision;
  chrome.storage.local.get(['sessionHistory'], (result) => {
    if (revision !== privacyRevision) return;
    weekGlance.textContent = '';

    if (chrome.runtime.lastError) {
      const errP = document.createElement('p');
      errP.className = 'no-session';
      errP.setAttribute('role', 'alert');
      errP.textContent = chrome.runtime.lastError.message
        ? `Could not load stats. ${chrome.runtime.lastError.message}`
        : 'Could not load stats.';
      weekGlance.appendChild(errP);
      return;
    }

    const rawHistory = Array.isArray(result.sessionHistory) ? result.sessionHistory : [];
    const sanitizedHistory = sanitizeSessionHistory(rawHistory);
    const summary = summarizeWeek(sanitizedHistory, Date.now());

    if (summary.sessionCount === 0) {
      const emptyP = document.createElement('p');
      emptyP.className = 'no-session';
      emptyP.textContent = 'No sessions this week yet.';
      weekGlance.appendChild(emptyP);
    } else {
      weekGlance.appendChild(createGlanceRow('Sessions', `${summary.sessionCount}`));
      weekGlance.appendChild(
        createGlanceRow(
          'Avg on-intent',
          summary.avgOnIntentRatio != null ? `${Math.round(summary.avgOnIntentRatio * 100)}%` : '—'
        )
      );
    }

    const caveatP = document.createElement('p');
    caveatP.className = 'method-caveat';
    caveatP.textContent = 'Averages cover sessions ended in the last 7 days; unscored sessions are excluded.';
    weekGlance.appendChild(caveatP);

    const privacyP = document.createElement('p');
    privacyP.className = 'privacy-copy';
    privacyP.textContent = PRIVACY_COPY;
    weekGlance.appendChild(privacyP);
  });
});
