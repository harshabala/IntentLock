document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('api-key');
  const saveKeyBtn = document.getElementById('save-key-btn');
  const keyStatus = document.getElementById('key-status');

  const distractionSitesInput = document.getElementById('distraction-sites');
  const saveSitesBtn = document.getElementById('save-sites-btn');
  const sitesStatus = document.getElementById('sites-status');

  const quickIntentsList = document.getElementById('quick-intents-list');
  const quickStatus = document.getElementById('quick-status');

  const trackingToggle = document.getElementById('tracking-toggle');
  const soundToggle = document.getElementById('sound-toggle');
  const exportBtn = document.getElementById('export-btn');
  const deleteDataBtn = document.getElementById('delete-data-btn');
  const dataStatus = document.getElementById('data-status');
  const themeStatus = document.getElementById('theme-status');

  const dailyGoalInput = document.getElementById('daily-goal');
  const weeklyGoalInput = document.getElementById('weekly-goal');
  const saveGoalsBtn = document.getElementById('save-goals-btn');
  const goalsStatus = document.getElementById('goals-status');

  const DEFAULT_SITES = [
    'twitter.com', 'x.com', 'facebook.com', 'reddit.com',
    'instagram.com', 'youtube.com', 'netflix.com', 'tiktok.com'
  ];

  // Load existing settings
  chrome.storage.local.get([
    'openaiApiKey', 'trackingEnabled', 'soundEnabled', 'customDistractionSites', 'quickIntents', 'theme', 'goals'
  ], (result) => {
    if (result.openaiApiKey) {
      apiKeyInput.placeholder = 'Key saved — enter new key to replace';
    }
    if (result.trackingEnabled !== undefined) {
      trackingToggle.checked = result.trackingEnabled;
    }
    if (result.soundEnabled !== undefined) {
      soundToggle.checked = result.soundEnabled;
    } else {
      soundToggle.checked = true; // Default to enabled
    }

    const sites = result.customDistractionSites || DEFAULT_SITES;
    distractionSitesInput.value = sites.join('\n');

    renderQuickIntents(result.quickIntents || []);

    // Load goals
    if (result.goals) {
      if (result.goals.daily) dailyGoalInput.value = result.goals.daily;
      if (result.goals.weekly) weeklyGoalInput.value = result.goals.weekly;
    }

    // Load theme
    const theme = result.theme || 'auto';
    document.querySelectorAll('.theme-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === theme);
    });
    applyTheme(theme);
  });

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function showStatus(el, text) {
    el.textContent = text;
    el.classList.remove('hidden');
    el.style.display = 'block';
    clearTimeout(el._hideTimer);
    if (reducedMotion) {
      el.style.opacity = '1';
      el._hideTimer = setTimeout(() => {
        el.style.display = 'none';
      }, 3000);
    } else {
      el.style.opacity = '0';
      el.style.transition = 'opacity 200ms cubic-bezier(0.2, 0, 0, 1)';
      el.offsetHeight;
      el.style.opacity = '1';
      el._hideTimer = setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => {
          el.style.display = 'none';
        }, 200);
      }, 3000);
    }
  }

  // ── API Key ─────────────────────────────────────────────────────────

  saveKeyBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    if (!key) return;

    // Basic validation: OpenAI API keys typically start with 'sk-'
    if (!key.startsWith('sk-')) {
      showStatus(keyStatus, 'Invalid API key format. Key should start with "sk-"');
      return;
    }

    chrome.storage.local.set({ openaiApiKey: key }, () => {
      apiKeyInput.value = '';
      apiKeyInput.placeholder = 'Key saved — enter new key to replace';
      showStatus(keyStatus, 'API key saved.');
      chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' });
    });
  });

  // ── Distraction sites ───────────────────────────────────────────────

  saveSitesBtn.addEventListener('click', () => {
    const raw = distractionSitesInput.value.trim();
    const sites = raw.split('\n')
      .map(s => s.trim().toLowerCase())
      .filter(s => s.length > 0 && s.includes('.'));

    chrome.storage.local.set({ customDistractionSites: sites }, () => {
      showStatus(sitesStatus, `${sites.length} sites saved.`);
      chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' });
    });
  });

  // ── Quick intents management ────────────────────────────────────────

  function renderQuickIntents(intents) {
    quickIntentsList.textContent = '';

    if (intents.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'no-session';
      empty.textContent = 'No saved intents. Save one from the new tab page.';
      quickIntentsList.appendChild(empty);
      return;
    }

    intents.forEach((qi, index) => {
      const row = document.createElement('div');
      row.className = 'quick-intent-row';

      const text = document.createElement('span');
      text.className = 'quick-intent-text';
      text.textContent = qi.intent;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'quick-intent-remove';
      removeBtn.textContent = '\u00D7';
      removeBtn.addEventListener('click', () => {
        intents.splice(index, 1);
        chrome.storage.local.set({ quickIntents: intents }, () => {
          renderQuickIntents(intents);
          showStatus(quickStatus, 'Intent removed.');
        });
      });

      row.append(text, removeBtn);
      quickIntentsList.appendChild(row);
    });
  }

  // ── Tracking toggle ─────────────────────────────────────────────────

  trackingToggle.addEventListener('change', (e) => {
    const enabled = e.target.checked;
    chrome.storage.local.set({ trackingEnabled: enabled }, () => {
      showStatus(dataStatus, enabled ? 'Tracking enabled.' : 'Tracking disabled.');
      chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' });
    });
  });

  // ── Sound toggle ───────────────────────────────────────────────────

  soundToggle.addEventListener('change', (e) => {
    const enabled = e.target.checked;
    chrome.storage.local.set({ soundEnabled: enabled }, () => {
      showStatus(dataStatus, enabled ? 'Sound alerts enabled.' : 'Sound alerts disabled.');
      chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' });
    });
  });

  // ── Goals ──────────────────────────────────────────────────────────

  saveGoalsBtn.addEventListener('click', () => {
    const daily = parseInt(dailyGoalInput.value, 10);
    const weekly = parseInt(weeklyGoalInput.value, 10);

    const goals = {
      daily: isNaN(daily) ? null : daily,
      weekly: isNaN(weekly) ? null : weekly
    };

    chrome.storage.local.set({ goals }, () => {
      showStatus(goalsStatus, 'Goals saved.');
      chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' });
    });
  });

  // ── Data export ─────────────────────────────────────────────────────

  exportBtn.addEventListener('click', () => {
    chrome.storage.local.get(['sessionHistory', 'quickIntents'], (result) => {
      const data = {
        exportedAt: new Date().toISOString(),
        sessions: result.sessionHistory || [],
        quickIntents: result.quickIntents || []
      };

      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `intentlock-export-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);

      showStatus(dataStatus, 'History exported.');
    });
  });

  // ── Delete all data ─────────────────────────────────────────────────

  deleteDataBtn.addEventListener('click', () => {
    if (confirm('Delete all stored data? This cannot be undone.')) {
      chrome.storage.local.remove([
        'activeSession', 'interventionState', 'sessionHistory',
        'quickIntents', 'breakUntil', 'onboardingComplete', 'theme'
      ], () => {
        showStatus(dataStatus, 'All data deleted.');
        chrome.runtime.sendMessage({ type: 'SESSION_CLEARED' });
        renderQuickIntents([]);
        // Reset theme to auto
        document.querySelectorAll('.theme-btn').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.theme === 'auto');
        });
        applyTheme('auto');
      });
    }
  });

  // ── Theme toggle ────────────────────────────────────────────────────

  function applyTheme(theme, animate) {
    const root = document.documentElement;

    function setTheme() {
      if (theme === 'auto') {
        root.style.removeProperty('color-scheme');
        root.classList.remove('theme-dark', 'theme-light');
      } else if (theme === 'dark') {
        root.style.colorScheme = 'dark';
        root.classList.remove('theme-light');
        root.classList.add('theme-dark');
      } else if (theme === 'light') {
        root.style.colorScheme = 'light';
        root.classList.remove('theme-dark');
        root.classList.add('theme-light');
      }
    }

    if (animate && !reducedMotion) {
      document.body.style.transition = 'opacity 150ms cubic-bezier(0.2, 0, 0, 1)';
      document.body.style.opacity = '0.6';
      setTimeout(() => {
        setTheme();
        document.body.style.opacity = '1';
      }, 150);
    } else {
      setTheme();
    }
  }

  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme;
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      chrome.storage.local.set({ theme }, () => {
        applyTheme(theme, true);
        showStatus(themeStatus, 'Theme updated.');
        chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' });
      });
    });
  });
});
