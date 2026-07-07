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

import {
  getErrorLog,
  clearErrorLog,
  formatErrorLogForExport,
} from './error-log.js';

document.addEventListener('DOMContentLoaded', () => {
  const listEl = document.getElementById('error-log-list');
  const emptyEl = document.getElementById('empty-log');
  const copyBtn = document.getElementById('copy-log-btn');
  const clearBtn = document.getElementById('clear-log-btn');
  const copyStatus = document.getElementById('copy-status');
  let allEntries = [];
  let activeFilter = 'all';

  function showStatus(text) {
    copyStatus.textContent = text;
    copyStatus.classList.remove('hidden');
    copyStatus.style.display = 'block';
    clearTimeout(copyStatus._timer);
    copyStatus._timer = setTimeout(() => {
      copyStatus.style.display = 'none';
    }, 2500);
  }

  function formatTime(timestamp) {
    return new Date(timestamp).toLocaleString();
  }

  function renderEntries() {
    const filtered = activeFilter === 'all'
      ? allEntries
      : allEntries.filter((entry) => entry.type === activeFilter);

    listEl.textContent = '';
    emptyEl.classList.toggle('hidden', filtered.length > 0);

    filtered.forEach((entry) => {
      const card = document.createElement('article');
      card.className = 'diagnostics-entry';

      const meta = document.createElement('div');
      meta.className = 'diagnostics-meta';
      meta.textContent = `${formatTime(entry.timestamp)} · ${entry.type} · ${entry.source || 'unknown'}`;

      const message = document.createElement('p');
      message.className = 'diagnostics-message';
      message.textContent = entry.message;

      card.append(meta, message);

      if (entry.details && Object.keys(entry.details).length > 0) {
        const details = document.createElement('pre');
        details.className = 'diagnostics-details';
        details.textContent = JSON.stringify(entry.details, null, 2);
        card.appendChild(details);
      }

      listEl.appendChild(card);
    });
  }

  async function refresh() {
    allEntries = await getErrorLog();
    renderEntries();
  }

  document.querySelectorAll('.diagnostics-filters .filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.diagnostics-filters .filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      renderEntries();
    });
  });

  copyBtn.addEventListener('click', async () => {
    const filtered = activeFilter === 'all'
      ? allEntries
      : allEntries.filter((entry) => entry.type === activeFilter);
    const text = formatErrorLogForExport(filtered);
    try {
      await navigator.clipboard.writeText(text);
      showStatus('Log copied to clipboard.');
    } catch {
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `intentlock-diagnostics-${Date.now()}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      showStatus('Log downloaded as text file.');
    }
  });

  clearBtn.addEventListener('click', async () => {
    await clearErrorLog();
    allEntries = [];
    renderEntries();
    showStatus('Diagnostic log cleared.');
  });

  refresh();
});