document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('api-key');
  const saveKeyBtn = document.getElementById('save-key-btn');
  const keyStatus = document.getElementById('key-status');

  const distractionSitesInput = document.getElementById('distraction-sites');
  const saveSitesBtn = document.getElementById('save-sites-btn');
  const sitesStatus = document.getElementById('sites-status');

  const trackingToggle = document.getElementById('tracking-toggle');
  const exportBtn = document.getElementById('export-btn');
  const deleteDataBtn = document.getElementById('delete-data-btn');
  const dataStatus = document.getElementById('data-status');
  const themeStatus = document.getElementById('theme-status');
  let deleteArmed = false;
  let deleteArmTimer = null;

  const DEFAULT_SITES = [
    'twitter.com', 'x.com', 'facebook.com', 'reddit.com',
    'instagram.com', 'youtube.com', 'netflix.com', 'tiktok.com'
  ];

  // Load existing settings
  chrome.storage.local.get([
    'openaiApiKey', 'trackingEnabled', 'customDistractionSites', 'theme'
  ], (localResult) => {
    const processSettings = (sessionApiKey) => {
      let finalKey = sessionApiKey;
      let migrated = false;

      if (localResult.openaiApiKey && chrome.storage.session) {
        migrated = true;
        finalKey = localResult.openaiApiKey;
        chrome.storage.session.set({ openaiApiKey: finalKey }, () => {
          chrome.storage.local.remove(['openaiApiKey']);
        });
      }

      if (finalKey) {
        apiKeyInput.placeholder = 'Key saved — enter new key to replace';
      }

      if (migrated) {
        showStatus(keyStatus, 'OpenAI API key migrated to secure session storage.');
      }

      if (localResult.trackingEnabled !== undefined) {
        trackingToggle.checked = localResult.trackingEnabled;
      }

      const sites = localResult.customDistractionSites || DEFAULT_SITES;
      distractionSitesInput.value = sites.join('\n');

      // Load theme
      const theme = localResult.theme || 'auto';
      document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === theme);
      });
      applyTheme(theme);
    };

    if (chrome.storage.session) {
      chrome.storage.session.get(['openaiApiKey'], (sessionResult) => {
        processSettings(sessionResult.openaiApiKey);
      });
    } else {
      processSettings(localResult.openaiApiKey);
    }
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

    const storageArea = chrome.storage.session || chrome.storage.local;
    storageArea.set({ openaiApiKey: key }, () => {
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

  // ── Tracking toggle ─────────────────────────────────────────────────

  trackingToggle.addEventListener('change', (e) => {
    const enabled = e.target.checked;
    chrome.storage.local.set({ trackingEnabled: enabled }, () => {
      showStatus(dataStatus, enabled ? 'Tracking enabled.' : 'Tracking disabled.');
      chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' });
    });
  });

  // ── Data export ─────────────────────────────────────────────────────

  exportBtn.addEventListener('click', () => {
    chrome.storage.local.get(['sessionHistory'], (result) => {
      const data = {
        exportedAt: new Date().toISOString(),
        sessions: result.sessionHistory || []
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
    if (!deleteArmed) {
      deleteArmed = true;
      deleteDataBtn.textContent = 'Confirm delete';
      showStatus(dataStatus, 'Click confirm delete to erase all local IntentLock data.');
      clearTimeout(deleteArmTimer);
      deleteArmTimer = setTimeout(() => {
        deleteArmed = false;
        deleteDataBtn.textContent = 'Delete all data';
      }, 5000);
      return;
    }

    clearTimeout(deleteArmTimer);
    deleteArmed = false;
    deleteDataBtn.disabled = true;
    deleteDataBtn.textContent = 'Deleting...';

    chrome.storage.local.clear(() => {
      const finishDelete = () => {
        distractionSitesInput.value = DEFAULT_SITES.join('\n');
        apiKeyInput.value = '';
        apiKeyInput.placeholder = 'sk-...';
        trackingToggle.checked = true;
        showStatus(dataStatus, 'All data deleted.');
        chrome.runtime.sendMessage({ type: 'SESSION_CLEARED' });
        document.querySelectorAll('.theme-btn').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.theme === 'auto');
        });
        applyTheme('auto');
        deleteDataBtn.disabled = false;
        deleteDataBtn.textContent = 'Delete all data';
      };

      if (chrome.storage.session) {
        chrome.storage.session.clear(finishDelete);
      } else {
        finishDelete();
      }
    });
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
