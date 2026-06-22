import {
  PROVIDER_LIST,
  DEFAULT_PROVIDER_ID,
  getProvider,
  getDefaultProviderConfig,
  providerRequiresApiKey,
  validateApiKey,
  validateProviderConfig,
} from './providers.js';
import { logError, ERROR_TYPES } from './error-log.js';

document.addEventListener('DOMContentLoaded', () => {
  const providerSelect = document.getElementById('provider-select');
  const providerDescription = document.getElementById('provider-description');
  const customProviderFields = document.getElementById('custom-provider-fields');
  const customLabelInput = document.getElementById('custom-label');
  const apiStyleSelect = document.getElementById('api-style-select');
  const authTypeSelect = document.getElementById('auth-type-select');
  const providerAdvancedDisclosure = document.getElementById('provider-advanced-disclosure');
  const providerAdvancedToggle = document.getElementById('provider-advanced-toggle');
  const providerModelFields = document.getElementById('provider-model-fields');
  const modelInput = document.getElementById('model-input');
  const baseUrlGroup = document.getElementById('base-url-group');
  const baseUrlInput = document.getElementById('base-url-input');
  const baseUrlHint = document.getElementById('base-url-hint');
  const apiKeyGroup = document.getElementById('api-key-group');
  const apiKeyInput = document.getElementById('api-key');
  const apiKeyHint = document.getElementById('api-key-hint');
  const saveProviderBtn = document.getElementById('save-provider-btn');
  const providerStatus = document.getElementById('provider-status');

  const distractionSitesInput = document.getElementById('distraction-sites');
  const saveSitesBtn = document.getElementById('save-sites-btn');
  const sitesStatus = document.getElementById('sites-status');

  const trackingToggle = document.getElementById('tracking-toggle');
  const exportBtn = document.getElementById('export-btn');
  const deleteDataBtn = document.getElementById('delete-data-btn');
  const dataStatus = document.getElementById('data-status');
  const themeStatus = document.getElementById('theme-status');
  const openDiagnosticsBtn = document.getElementById('open-diagnostics-btn');
  let deleteArmed = false;
  let deleteArmTimer = null;
  let hasSavedApiKey = false;
  let providerAdvancedOpen = false;

  function isCloudProvider(providerId) {
    const provider = getProvider(providerId);
    return !provider.isLocal && providerId !== 'custom';
  }

  const DEFAULT_SITES = [
    'twitter.com', 'x.com', 'facebook.com', 'reddit.com',
    'instagram.com', 'youtube.com', 'netflix.com', 'tiktok.com'
  ];

  PROVIDER_LIST.forEach((provider) => {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.label;
    providerSelect.appendChild(option);
  });

  function getFormConfig() {
    const providerId = providerSelect.value || DEFAULT_PROVIDER_ID;
    const provider = getProvider(providerId);
    return {
      providerId,
      model: modelInput.value.trim() || provider.defaultModel,
      baseUrl: baseUrlInput.value.trim() || provider.defaultBaseUrl,
      customLabel: customLabelInput.value.trim(),
      authType: providerId === 'custom' ? authTypeSelect.value : provider.authType,
      apiStyle: providerId === 'custom' ? apiStyleSelect.value : provider.apiStyle,
    };
  }

  function updateProviderUI(providerId = providerSelect.value) {
    const provider = getProvider(providerId);
    const cloudProvider = isCloudProvider(providerId);
    providerDescription.textContent = provider.description;
    customProviderFields.classList.toggle('hidden', providerId !== 'custom');

    providerAdvancedDisclosure.classList.toggle('hidden', !cloudProvider);
    if (cloudProvider) {
      providerModelFields.classList.toggle('hidden', !providerAdvancedOpen);
      providerAdvancedToggle.setAttribute('aria-expanded', String(providerAdvancedOpen));
    } else {
      providerModelFields.classList.remove('hidden');
      providerAdvancedOpen = false;
      providerAdvancedToggle.setAttribute('aria-expanded', 'false');
    }

    const showBaseUrl = providerId === 'custom' || provider.isLocal || cloudProvider;
    baseUrlGroup.classList.toggle('hidden', !showBaseUrl);

    if (providerId !== 'custom') {
      modelInput.placeholder = provider.defaultModel;
      baseUrlInput.placeholder = provider.defaultBaseUrl;
    }

    baseUrlHint.textContent = provider.isLocal
      ? 'Make sure your local server is running before starting a session.'
      : providerId === 'custom'
        ? 'Full URL to your provider endpoint.'
        : '';

    const needsKey = providerRequiresApiKey(providerId, getFormConfig());
    apiKeyGroup.classList.toggle('hidden', !needsKey);
    apiKeyInput.placeholder = hasSavedApiKey && needsKey
      ? 'Key saved — enter new key to replace'
      : provider.keyPlaceholder;
    apiKeyHint.textContent = needsKey
      ? `${provider.keyHint}. Stored in session memory and cleared when the browser closes.`
      : provider.keyHint;
  }

  function applyStoredConfig(stored = {}) {
    const providerId = stored.providerId || DEFAULT_PROVIDER_ID;
    const provider = getProvider(providerId);
    providerSelect.value = providerId;
    modelInput.value = stored.model || provider.defaultModel;
    baseUrlInput.value = stored.baseUrl || provider.defaultBaseUrl;
    customLabelInput.value = stored.customLabel || '';
    authTypeSelect.value = stored.authType || provider.authType;
    apiStyleSelect.value = stored.apiStyle || provider.apiStyle;
    updateProviderUI(providerId);
  }

  providerSelect.addEventListener('change', () => {
    const provider = getProvider(providerSelect.value);
    modelInput.value = provider.defaultModel;
    baseUrlInput.value = provider.defaultBaseUrl;
    providerAdvancedOpen = false;
    hasSavedApiKey = false;
    apiKeyInput.value = '';
    clearFieldError(apiKeyInput, 'api-key-hint');

    const finishProviderSwitch = () => {
      updateProviderUI(providerSelect.value);
    };

    if (chrome.storage.session) {
      chrome.storage.session.remove(['llmApiKey'], finishProviderSwitch);
    } else {
      finishProviderSwitch();
    }
  });

  providerAdvancedToggle.addEventListener('click', () => {
    providerAdvancedOpen = !providerAdvancedOpen;
    updateProviderUI();
  });

  authTypeSelect.addEventListener('change', () => updateProviderUI());
  apiStyleSelect.addEventListener('change', () => updateProviderUI());

  apiKeyInput.addEventListener('input', () => {
    clearFieldError(apiKeyInput, 'api-key-hint');
  });

  chrome.storage.local.get([
    'llmProviderConfig', 'openaiApiKey', 'trackingEnabled', 'customDistractionSites', 'theme'
  ], (localResult) => {
    const processSettings = (sessionApiKey) => {
      let migratedKey = sessionApiKey;

      if (localResult.openaiApiKey && chrome.storage.session) {
        migratedKey = localResult.openaiApiKey;
        chrome.storage.session.set({ llmApiKey: migratedKey }, () => {
          chrome.storage.local.remove(['openaiApiKey'], () => {
            showStatus(providerStatus, 'Legacy API key migrated to secure session storage.');
          });
        });
      }

      hasSavedApiKey = Boolean(migratedKey);
      applyStoredConfig(localResult.llmProviderConfig || getDefaultProviderConfig());

      if (!localResult.llmProviderConfig) {
        chrome.storage.local.set({
          llmProviderConfig: getDefaultProviderConfig(DEFAULT_PROVIDER_ID),
        });
      }

      if (localResult.trackingEnabled !== undefined) {
        trackingToggle.checked = localResult.trackingEnabled;
      }

      const sites = localResult.customDistractionSites || DEFAULT_SITES;
      distractionSitesInput.value = sites.join('\n');

      const theme = localResult.theme || 'auto';
      document.querySelectorAll('.theme-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.theme === theme);
      });
      applyTheme(theme);
    };

    if (chrome.storage.session) {
      chrome.storage.session.get(['llmApiKey', 'openaiApiKey'], (sessionResult) => {
        processSettings(sessionResult.llmApiKey || sessionResult.openaiApiKey);
      });
    } else {
      processSettings(localResult.openaiApiKey);
    }
  });

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function setFieldError(field, message, hintId) {
    let errorEl = field._errorEl;
    if (!errorEl) {
      errorEl = document.createElement('p');
      errorEl.className = 'field-error';
      errorEl.id = `${field.id}-error`;
      errorEl.setAttribute('role', 'alert');
      field.parentNode.appendChild(errorEl);
      field._errorEl = errorEl;
    }
    errorEl.textContent = message;
    field.setAttribute('aria-invalid', 'true');
    const describedBy = [hintId, errorEl.id].filter(Boolean).join(' ');
    field.setAttribute('aria-describedby', describedBy);
    field.focus();
  }

  function clearFieldError(field, hintId) {
    if (field._errorEl) {
      field._errorEl.textContent = '';
    }
    field.removeAttribute('aria-invalid');
    if (hintId) {
      field.setAttribute('aria-describedby', hintId);
    } else {
      field.removeAttribute('aria-describedby');
    }
  }

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

  openDiagnosticsBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('diagnostics.html') });
  });

  saveProviderBtn.addEventListener('click', () => {
    const config = getFormConfig();
    const configError = validateProviderConfig(config);
    if (configError) {
      showStatus(providerStatus, configError);
      logError({
        type: ERROR_TYPES.VALIDATION,
        message: configError,
        details: { providerId: config.providerId, action: 'save_provider' },
        source: 'options',
      });
      return;
    }

    clearFieldError(apiKeyInput, 'api-key-hint');

    const key = apiKeyInput.value.trim();
    const keyError = validateApiKey(config.providerId, key || (hasSavedApiKey ? 'saved' : ''), config);
    if (keyError && !hasSavedApiKey) {
      setFieldError(apiKeyInput, keyError, 'api-key-hint');
      logError({
        type: ERROR_TYPES.VALIDATION,
        message: keyError,
        details: { providerId: config.providerId, action: 'save_provider' },
        source: 'options',
      });
      return;
    }
    if (key) {
      const newKeyError = validateApiKey(config.providerId, key, config);
      if (newKeyError) {
        setFieldError(apiKeyInput, newKeyError, 'api-key-hint');
        logError({
          type: ERROR_TYPES.VALIDATION,
          message: newKeyError,
          details: { providerId: config.providerId, action: 'save_provider' },
          source: 'options',
        });
        return;
      }
    }

    chrome.storage.local.set({ llmProviderConfig: config }, () => {
      if (chrome.runtime.lastError) {
        const msg = 'Could not save provider settings.';
        showStatus(providerStatus, `${msg} See Diagnostics below.`);
        logError({
          type: ERROR_TYPES.STORAGE,
          message: msg,
          details: { error: chrome.runtime.lastError.message },
          source: 'options',
        });
        return;
      }

      const finish = () => {
        hasSavedApiKey = hasSavedApiKey || Boolean(key);
        apiKeyInput.value = '';
        updateProviderUI(config.providerId);
        showStatus(providerStatus, `${getProvider(config.providerId).label} settings saved.`);
        chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' });
      };

      if (key) {
        const storageArea = chrome.storage.session || chrome.storage.local;
        storageArea.set({ llmApiKey: key }, () => {
          if (chrome.runtime.lastError) {
            const msg = 'Could not save API key to session storage.';
            setFieldError(apiKeyInput, `${msg} See Diagnostics below.`, 'api-key-hint');
            logError({
              type: ERROR_TYPES.STORAGE,
              message: msg,
              details: { error: chrome.runtime.lastError.message, providerId: config.providerId },
              source: 'options',
            });
            return;
          }
          finish();
        });
      } else {
        finish();
      }
    });
  });

  saveSitesBtn.addEventListener('click', () => {
    const raw = distractionSitesInput.value.trim();
    const sites = raw.split('\n')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0 && s.includes('.'));

    chrome.storage.local.set({ customDistractionSites: sites }, () => {
      showStatus(sitesStatus, `${sites.length} sites saved.`);
      chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' });
    });
  });

  trackingToggle.addEventListener('change', (e) => {
    const enabled = e.target.checked;
    chrome.storage.local.set({ trackingEnabled: enabled }, () => {
      showStatus(dataStatus, enabled ? 'Tracking enabled.' : 'Tracking disabled.');
      chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' });
    });
  });

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
        hasSavedApiKey = false;
        applyStoredConfig(getDefaultProviderConfig());
        distractionSitesInput.value = DEFAULT_SITES.join('\n');
        apiKeyInput.value = '';
        trackingToggle.checked = true;
        chrome.storage.local.set({ llmProviderConfig: getDefaultProviderConfig() });
        showStatus(dataStatus, 'All data deleted.');
        chrome.runtime.sendMessage({ type: 'SESSION_CLEARED' });
        document.querySelectorAll('.theme-btn').forEach((btn) => {
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

  document.querySelectorAll('.theme-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme;
      document.querySelectorAll('.theme-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      chrome.storage.local.set({ theme }, () => {
        applyTheme(theme, true);
        showStatus(themeStatus, 'Theme updated.');
        chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' });
      });
    });
  });
});