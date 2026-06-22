import { SITE_CATEGORIES, buildDefaultPolicy, migrateLegacyDistractionSites } from './heuristic-policy.js';

document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('api-key');
  const saveKeyBtn = document.getElementById('save-key-btn');
  const keyStatus = document.getElementById('key-status');

  const saveSitesBtn = document.getElementById('save-sites-btn');
  const sitesStatus = document.getElementById('sites-status');

  const trackingToggle = document.getElementById('tracking-toggle');
  const exportBtn = document.getElementById('export-btn');
  const deleteDataBtn = document.getElementById('delete-data-btn');
  const dataStatus = document.getElementById('data-status');
  const themeStatus = document.getElementById('theme-status');
  let deleteArmed = false;
  let deleteArmTimer = null;

  function buildCategoryGrid(policy) {
    const grid = document.getElementById('category-grid');
    if (!grid) return;
    grid.textContent = '';

    SITE_CATEGORIES.forEach(cat => {
      const currentPolicy = policy.categoryPolicies?.[cat.id] || cat.defaultPolicy;

      const row = document.createElement('div');
      row.className = 'category-row';

      const nameEl = document.createElement('span');
      nameEl.className = 'category-name';
      nameEl.textContent = cat.label;

      const controls = document.createElement('div');
      controls.className = 'category-controls';

      ['block', 'warn', 'allow'].forEach(choice => {
        const labelEl = document.createElement('label');
        labelEl.className = 'category-choice';

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = `cat-${cat.id}`;
        radio.value = choice;
        radio.checked = choice === currentPolicy;
        radio.setAttribute('aria-label', `${cat.label}: ${choice}`);

        labelEl.append(radio, document.createTextNode(choice));
        controls.appendChild(labelEl);
      });

      row.append(nameEl, controls);
      grid.appendChild(row);
    });
  }

  // Load existing settings
  chrome.storage.local.get([
    'openaiApiKey', 'trackingEnabled', 'customDistractionSites', 'theme', 'heuristicPolicy'
  ], (localResult) => {
    const processSettings = (sessionApiKey) => {
      let finalKey = sessionApiKey;

      if (localResult.openaiApiKey && chrome.storage.session) {
        finalKey = localResult.openaiApiKey;
        chrome.storage.session.set({ openaiApiKey: finalKey }, () => {
          chrome.storage.local.remove(['openaiApiKey'], () => {
            showStatus(keyStatus, 'OpenAI API key migrated to secure session storage.');
          });
        });
      }

      if (finalKey) {
        apiKeyInput.placeholder = 'Key saved — enter new key to replace';
      }

      if (localResult.trackingEnabled !== undefined) {
        trackingToggle.checked = localResult.trackingEnabled;
      }

      let activePolicy = localResult.heuristicPolicy;
      if (!activePolicy || activePolicy.version !== 1) {
        activePolicy = localResult.customDistractionSites
          ? migrateLegacyDistractionSites(localResult.customDistractionSites)
          : buildDefaultPolicy('deep_work', 'balanced');
      }
      buildCategoryGrid(activePolicy);

      const customBlockInput = document.getElementById('custom-block-domains');
      const customAllowInput = document.getElementById('custom-allow-domains');
      if (customBlockInput) customBlockInput.value = (activePolicy.customBlockDomains || []).join('\n');
      if (customAllowInput) customAllowInput.value = (activePolicy.customAllowDomains || []).join('\n');

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

  // ── Site policies ────────────────────────────────────────────────────

  const HOSTNAME_RE = /^[a-z0-9][a-z0-9\-\.]*\.[a-z]{2,}$/;
  function parseCustomDomains(text) {
    return text.split('\n').map(s => s.trim().toLowerCase()).filter(s => s && HOSTNAME_RE.test(s));
  }

  saveSitesBtn.addEventListener('click', () => {
    chrome.storage.local.get(['heuristicPolicy', 'customDistractionSites'], (stored) => {
      let policy = stored.heuristicPolicy;
      if (!policy || policy.version !== 1) {
        policy = stored.customDistractionSites
          ? migrateLegacyDistractionSites(stored.customDistractionSites)
          : buildDefaultPolicy('deep_work', 'balanced');
      }

      // Read category grid radio values
      const updatedPolicies = {};
      SITE_CATEGORIES.forEach(cat => {
        const checked = document.querySelector(`input[name="cat-${cat.id}"]:checked`);
        if (checked) updatedPolicies[cat.id] = checked.value;
      });
      policy.categoryPolicies = { ...policy.categoryPolicies, ...updatedPolicies };

      // Read custom block/allow textareas
      const customBlockInput = document.getElementById('custom-block-domains');
      const customAllowInput = document.getElementById('custom-allow-domains');
      policy.customBlockDomains = parseCustomDomains(customBlockInput?.value || '');
      policy.customAllowDomains = parseCustomDomains(customAllowInput?.value || '');

      chrome.storage.local.set({ heuristicPolicy: policy }, () => {
        showStatus(sitesStatus, 'Site policies saved.');
        chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' });
      });
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
        const defaultPolicy = buildDefaultPolicy('deep_work', 'balanced');
        buildCategoryGrid(defaultPolicy);
        const customBlockInput = document.getElementById('custom-block-domains');
        const customAllowInput = document.getElementById('custom-allow-domains');
        if (customBlockInput) customBlockInput.value = '';
        if (customAllowInput) customAllowInput.value = '';
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
