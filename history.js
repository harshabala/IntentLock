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
  const historyList = document.getElementById('history-list');
  const emptyState = document.getElementById('empty-state');
  const searchInput = document.getElementById('history-search');

  let allSessions = [];
  let currentFilter = 'all';
  let searchQuery = '';

  // Load sessions
  chrome.storage.local.get(['sessionHistory'], (result) => {
    allSessions = result.sessionHistory || [];

    if (allSessions.length === 0) {
      emptyState.classList.remove('hidden');
      document.querySelector('.history-controls').classList.add('hidden');
      return;
    }

    // Setup filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        renderSessions();
      });
    });

    // Setup search
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase().trim();
      renderSessions();
    });

    renderSessions();
  });

  function filterSessions(sessions) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

    let filtered = sessions;

    // Apply time filter
    switch (currentFilter) {
      case 'today':
        filtered = filtered.filter(s => new Date(s.startTime) >= today);
        break;
      case 'week':
        filtered = filtered.filter(s => new Date(s.startTime) >= weekAgo);
        break;
      case 'month':
        filtered = filtered.filter(s => new Date(s.startTime) >= monthAgo);
        break;
    }

    // Apply search filter
    if (searchQuery) {
      filtered = filtered.filter(s => s.intent.toLowerCase().includes(searchQuery));
    }

    return filtered;
  }

  function renderSessions() {
    historyList.textContent = '';

    const filtered = filterSessions(allSessions);

    if (filtered.length === 0) {
      emptyState.classList.remove('hidden');
      return;
    } else {
      emptyState.classList.add('hidden');
    }

    // Render sessions (newest first)
    const reversed = [...filtered].reverse();
    reversed.forEach(session => {
      const card = document.createElement('div');
      card.className = 'section history-card';

      // Header row with intent
      const headerRow = document.createElement('div');
      headerRow.className = 'history-header-row';

      const intent = document.createElement('p');
      intent.className = 'history-intent';
      intent.textContent = session.intent;

      headerRow.appendChild(intent);
      card.appendChild(headerRow);

      // Meta row
      const meta = document.createElement('div');
      meta.className = 'history-meta';

      const date = new Date(session.startTime);
      const dateStr = date.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
      });
      const duration = Math.round((session.endTime - session.startTime) / 60000);

      const items = [
        dateStr,
        `${duration} min`
      ];
      if (session.onIntentRatio != null) {
        items.push(`${Math.round(session.onIntentRatio * 100)}% on-intent`);
      }
      items.push(`${session.driftCount || 0} drift${(session.driftCount || 0) !== 1 ? 's' : ''}`);

      if (session.timeBudget) {
        const diff = duration - session.timeBudget;
        items.push(diff <= 0 ? 'Under budget' : `${diff} min over`);
      }

      items.forEach((item, i) => {
        const span = document.createElement('span');
        span.textContent = item;
        meta.appendChild(span);
        if (i < items.length - 1) {
          const sep = document.createElement('span');
          sep.className = 'history-sep';
          sep.textContent = '\u00B7';
          meta.appendChild(sep);
        }
      });

      card.appendChild(meta);

      const overrides = Array.isArray(session.overrides) ? session.overrides : [];
      const reflections = overrides.filter(o => o.reflection);
      if (reflections.length > 0) {
        const reflSection = document.createElement('div');
        reflSection.className = 'history-reflections';

        reflections.forEach(o => {
          const item = document.createElement('div');
          item.className = 'reflection-item';

          const quote = document.createElement('p');
          quote.className = 'reflection-text';
          quote.textContent = `"${o.reflection}"`;

          item.appendChild(quote);

          if (o.hostname || o.url) {
            const urlNote = document.createElement('p');
            urlNote.className = 'reflection-url';
            if (o.hostname) {
              urlNote.textContent = o.hostname.replace(/^www\./, '');
            } else {
              try {
                urlNote.textContent = new URL(o.url).hostname.replace(/^www\./, '');
              } catch {
                urlNote.textContent = o.url;
              }
            }
            item.appendChild(urlNote);
          }

          reflSection.appendChild(item);
        });

        card.appendChild(reflSection);
      }

      historyList.appendChild(card);
    });
  }
});
