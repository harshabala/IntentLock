document.addEventListener('DOMContentLoaded', () => {
  const historyList = document.getElementById('history-list');
  const emptyState = document.getElementById('empty-state');
  const insightsSection = document.getElementById('insights');
  const insightsContent = document.getElementById('insights-content');

  chrome.storage.local.get(['sessionHistory'], (result) => {
    const sessions = result.sessionHistory || [];

    if (sessions.length === 0) {
      emptyState.classList.remove('hidden');
      return;
    }

    // Show insights if 10+ sessions
    if (sessions.length >= 10) {
      renderInsights(sessions);
    }

    // Render sessions (newest first)
    const reversed = [...sessions].reverse();
    reversed.forEach(session => {
      const card = document.createElement('div');
      card.className = 'section history-card';

      // Intent
      const intent = document.createElement('p');
      intent.className = 'history-intent';
      intent.textContent = session.intent;
      card.appendChild(intent);

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
        `${duration} min`,
        `${session.driftCount || 0} drift${(session.driftCount || 0) !== 1 ? 's' : ''}`
      ];

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
      historyList.appendChild(card);
    });
  });

  function renderInsights(sessions) {
    insightsSection.classList.remove('hidden');
    insightsContent.textContent = '';

    // Total sessions
    const totalSessions = sessions.length;

    // Average duration
    const durations = sessions.map(s => Math.round((s.endTime - s.startTime) / 60000));
    const avgDuration = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);

    // Total drift overrides
    const totalDrifts = sessions.reduce((sum, s) => sum + (s.driftCount || 0), 0);

    // Override rate
    const sessionsWithDrift = sessions.filter(s => (s.driftCount || 0) > 0).length;
    const driftRate = Math.round((sessionsWithDrift / totalSessions) * 100);

    // Most common drift targets
    const domainCounts = {};
    sessions.forEach(s => {
      (s.events || []).forEach(e => {
        if (e.actionType === 'OVERRIDE' || e.actionType === 'PAGE_LOAD') {
          try {
            const domain = new URL(e.url).hostname;
            domainCounts[domain] = (domainCounts[domain] || 0) + 1;
          } catch (_) { /* skip */ }
        }
      });
    });

    const topDomains = Object.entries(domainCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    // Budget adherence
    const budgetSessions = sessions.filter(s => s.timeBudget);
    let budgetAdherence = null;
    if (budgetSessions.length > 0) {
      const underBudget = budgetSessions.filter(s => {
        const dur = Math.round((s.endTime - s.startTime) / 60000);
        return dur <= s.timeBudget;
      }).length;
      budgetAdherence = Math.round((underBudget / budgetSessions.length) * 100);
    }

    // Render insight rows
    const insights = [
      { label: 'Total sessions', value: String(totalSessions) },
      { label: 'Avg duration', value: `${avgDuration} min` },
      { label: 'Total drift overrides', value: String(totalDrifts) },
      { label: 'Sessions with drift', value: `${driftRate}%` },
    ];

    if (budgetAdherence !== null) {
      insights.push({ label: 'Under budget rate', value: `${budgetAdherence}%` });
    }

    insights.forEach(item => {
      const row = document.createElement('div');
      row.className = 'stat-row';
      const label = document.createElement('span');
      label.className = 'stat-label';
      label.textContent = item.label;
      const value = document.createElement('span');
      value.className = 'stat-value';
      value.textContent = item.value;
      row.append(label, value);
      insightsContent.appendChild(row);
    });

    // Top domains
    if (topDomains.length > 0) {
      const domainTitle = document.createElement('p');
      domainTitle.className = 'plan-heading';
      domainTitle.style.marginTop = '16px';
      domainTitle.textContent = 'Most visited domains';
      insightsContent.appendChild(domainTitle);

      topDomains.forEach(([domain, count]) => {
        const row = document.createElement('div');
        row.className = 'stat-row';
        const label = document.createElement('span');
        label.className = 'stat-label';
        label.textContent = domain;
        const value = document.createElement('span');
        value.className = 'stat-value';
        value.textContent = `${count} visits`;
        row.append(label, value);
        insightsContent.appendChild(row);
      });
    }
  }
});
