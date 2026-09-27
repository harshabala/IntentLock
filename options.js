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
import { SITE_CATEGORIES, buildDefaultPolicy, migrateLegacyDistractionSites } from './heuristic-policy.js';
import { sanitizeSessionHistory } from './privacy-utils.js';
import { initializeStorageClient, captureStorageEpoch, mutateStorage, guardStorageContinuation } from './storage-client.js';

document.addEventListener('DOMContentLoaded', async () => {
  let clientReady = false;
  try { await initializeStorageClient(); clientReady = true; }
  catch (error) {
    const status = document.createElement('p');
    status.setAttribute('role', 'alert');
    status.textContent = error.message;
    document.body.appendChild(status);
    // Retry deletion remains available even when the durable barrier blocks
    // initialization. No stored settings are loaded in this state.
  }
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

  const saveSitesBtn = document.getElementById('save-sites-btn');
  const sitesStatus = document.getElementById('sites-status');

  const trackingToggle = document.getElementById('tracking-toggle');
  const exportBtn = document.getElementById('export-btn');
  const deleteDataBtn = document.getElementById('delete-data-btn');
  const dataStatus = document.getElementById('data-status');
  const themeStatus = document.getElementById('theme-status');
  const openDiagnosticsBtn = document.getElementById('open-diagnostics-btn');
  const testInterventionBtn = document.getElementById('test-intervention-btn');
  const testInterventionStatus = document.getElementById('test-intervention-status');
  let deleteArmed = false;
  let deleteArmTimer = null;
  let deletionInProgress = !clientReady;
  let privacyRevision = 0;
  let hasSavedApiKey = false;
  let providerAdvancedOpen = false;

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'DATA_DELETION_STARTED') {
      deletionInProgress = true;
      privacyRevision++;
    }
    if (message?.type === 'DATA_DELETED') {
      deletionInProgress = false;
      privacyRevision++;
      resetDeletedSettings();
    }
  });

  function isCloudProvider(providerId) {
    const provider = getProvider(providerId);
    if (!provider) return false;
    return !provider.isLocal && providerId !== 'custom';
  }

  PROVIDER_LIST.forEach((provider) => {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.label;
    providerSelect.appendChild(option);
  });

  function getFormConfig() {
    const providerId = getProvider(providerSelect.value)?.id || DEFAULT_PROVIDER_ID;
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
    const provider = getProvider(providerId) || getProvider(DEFAULT_PROVIDER_ID);
    const cloudProvider = isCloudProvider(provider?.id || providerId);
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
    const provider = getProvider(stored.providerId) || getProvider(DEFAULT_PROVIDER_ID);
    const providerId = provider.id;
    providerSelect.value = providerId;
    modelInput.value = stored.model || provider.defaultModel;
    baseUrlInput.value = stored.baseUrl || provider.defaultBaseUrl;
    customLabelInput.value = stored.customLabel || '';
    authTypeSelect.value = stored.authType || provider.authType;
    apiStyleSelect.value = stored.apiStyle || provider.apiStyle;
    updateProviderUI(providerId);
  }

  providerSelect.addEventListener('change', () => {
    if (deletionInProgress) return;
    const provider = getProvider(providerSelect.value) || getProvider(DEFAULT_PROVIDER_ID);
    modelInput.value = provider.defaultModel;
    baseUrlInput.value = provider.defaultBaseUrl;
    providerAdvancedOpen = false;
    clearFieldError(apiKeyInput, 'api-key-hint');

    const finishProviderSwitch = () => {
      hasSavedApiKey = false;
      apiKeyInput.value = '';
      updateProviderUI(providerSelect.value);
    };

    if (chrome.storage.session) {
      const epoch = captureStorageEpoch();
      mutateStorage('clearKey', {}, epoch).then(guardStorageContinuation(finishProviderSwitch), error => showStatus(providerStatus, error.message));
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

  function buildCategoryGrid(policy) {
    const CATEGORY_GROUPS = [
      {
        label: 'Potentially distracting',
        ids: ['social_media', 'short_video', 'streaming', 'gaming', 'memes', 'gambling', 'news', 'forums', 'sports'],
      },
      {
        label: 'Work tools',
        ids: ['email', 'messaging', 'job_boards', 'professional_network', 'documentation', 'code_forge', 'ai_tools', 'productivity'],
      },
      {
        label: 'Neutral / personal',
        ids: ['shopping', 'finance', 'health', 'travel'],
      },
    ];

    const grid = document.getElementById('category-grid');
    if (!grid) return;
    grid.textContent = '';

    const currentPolicy = (policy?.version === 1 && policy.categoryPolicies) ? policy.categoryPolicies : {};

    CATEGORY_GROUPS.forEach(group => {
      const groupHeader = document.createElement('h3');
      groupHeader.className = 'category-group-header';
      groupHeader.textContent = group.label;
      grid.appendChild(groupHeader);

      group.ids.forEach(catId => {
        const cat = SITE_CATEGORIES.find(c => c.id === catId);
        if (!cat) return;
        const current = currentPolicy[cat.id] || cat.defaultPolicy || 'warn';

        const row = document.createElement('div');
        row.className = 'category-row';

        const labelEl = document.createElement('label');
        labelEl.className = 'category-label';
        labelEl.textContent = cat.label;
        row.appendChild(labelEl);

        const radioGroup = document.createElement('div');
        radioGroup.className = 'category-radios';
        radioGroup.setAttribute('role', 'group');
        radioGroup.setAttribute('aria-label', `${cat.label} policy`);

        ['block', 'warn', 'allow'].forEach(val => {
          const radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = `cat-${cat.id}`;
          radio.value = val;
          radio.id = `cat-${cat.id}-${val}`;
          if (current === val) radio.checked = true;

          const radioLabel = document.createElement('label');
          radioLabel.setAttribute('for', `cat-${cat.id}-${val}`);
          radioLabel.textContent = val;

          radioGroup.append(radio, radioLabel);
        });

        row.appendChild(radioGroup);
        grid.appendChild(row);
      });
    });
  }

  const settingsRevision = privacyRevision;
  if (clientReady) chrome.storage.local.get([
    'llmProviderConfig', 'trackingEnabled', 'customDistractionSites', 'theme', 'heuristicPolicy'
  ], (localResult) => {
    if (deletionInProgress || settingsRevision !== privacyRevision) return;
    const processSettings = (sessionApiKey) => {
      if (deletionInProgress || settingsRevision !== privacyRevision) return;
      // Only report presence of the canonical session key; never display it.
      hasSavedApiKey = Boolean(sessionApiKey);
      applyStoredConfig(localResult.llmProviderConfig || getDefaultProviderConfig());

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

      const theme = localResult.theme || 'auto';
      document.querySelectorAll('.theme-btn').forEach((btn) => {
        const on = btn.dataset.theme === theme;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      applyTheme(theme);
    };

    if (chrome.storage.session) {
      chrome.storage.session.get(['llmApiKey'], (sessionResult) => {
        processSettings(sessionResult?.llmApiKey);
      });
    } else {
      processSettings(null);
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
      el.style.transition = 'opacity 160ms ease-out';
      el.offsetHeight;
      el.style.opacity = '1';
      el._hideTimer = setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => {
          el.style.display = 'none';
        }, 160);
      }, 3000);
    }
  }

  openDiagnosticsBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('diagnostics.html') });
  });

  saveProviderBtn.addEventListener('click', () => {
    const epoch = captureStorageEpoch();
    epoch.catch(() => {});
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

    if (deletionInProgress) return;
    saveProviderBtn.disabled = true;
    mutateStorage('saveProvider', { config, ...(key ? { key } : {}) }, epoch).then(guardStorageContinuation((result) => {
      hasSavedApiKey = !result?.keyCleared && (hasSavedApiKey || Boolean(key));
      apiKeyInput.value = '';
      updateProviderUI(config.providerId);
      const label = (getProvider(config.providerId) || getProvider(DEFAULT_PROVIDER_ID)).label;
      showStatus(providerStatus, result?.keyCleared && providerRequiresApiKey(config.providerId, config)
        ? `${label} settings saved. The endpoint changed, so the saved key was removed — enter the key again.`
        : `${label} settings saved.`);
      chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' });
    }), error => {
      showStatus(providerStatus, error.message);
    }).finally(() => { saveProviderBtn.disabled = false; });
  });

  const HOSTNAME_RE = /^[a-z0-9][a-z0-9\-.]*\.[a-z]{2,}$/;
  function parseCustomDomains(text) {
    return text.split('\n').map(s => s.trim().toLowerCase()).filter(s => s && HOSTNAME_RE.test(s));
  }

  saveSitesBtn.addEventListener('click', () => {
    const epoch = captureStorageEpoch();
    epoch.catch(() => {});
    if (deletionInProgress) return;
    const categoryPolicies = {};
    document.querySelectorAll('#category-grid input[type="radio"]:checked').forEach(radio => {
      const catId = radio.name.replace(/^cat-/, '');
      categoryPolicies[catId] = radio.value;
    });

    const customBlockDomains = parseCustomDomains(
      (document.getElementById('custom-block-domains')?.value || '')
    );
    const customAllowDomains = parseCustomDomains(
      (document.getElementById('custom-allow-domains')?.value || '')
    );

    saveSitesBtn.disabled = true;
    mutateStorage('saveSites', { categoryPolicies, customBlockDomains, customAllowDomains }, epoch).then(guardStorageContinuation(() => {
      showStatus(sitesStatus, 'Site policies saved.');
      chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' });
    }), error => showStatus(sitesStatus, error.message))
      .finally(() => { saveSitesBtn.disabled = false; });
  });

  trackingToggle.addEventListener('change', (e) => {
    const enabled = e.target.checked;
    if (deletionInProgress) {
      trackingToggle.checked = !enabled;
      return;
    }
    trackingToggle.disabled = true;
    mutateStorage('tracking', { enabled }).then(guardStorageContinuation(() => {
      showStatus(dataStatus, enabled ? 'Tracking enabled.' : 'Tracking disabled.');
      chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' });
    }), error => {
      trackingToggle.checked = !enabled;
      showStatus(dataStatus, error.message);
    }).finally(() => { trackingToggle.disabled = false; });
  });

  exportBtn.addEventListener('click', () => {
    const revision = privacyRevision;
    if (deletionInProgress) return;
    chrome.storage.local.get(['sessionHistory'], (result) => {
      if (deletionInProgress || revision !== privacyRevision) return;
      const data = {
        exportedAt: new Date().toISOString(),
        sessions: sanitizeSessionHistory(result.sessionHistory || [])
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

  function resetDeletedSettings() {
    deletionInProgress = false;
    hasSavedApiKey = false;
    applyStoredConfig(getDefaultProviderConfig());
    const freshPolicy = buildDefaultPolicy('deep_work', 'balanced');
    buildCategoryGrid(freshPolicy);
    const blockInput = document.getElementById('custom-block-domains');
    const allowInput = document.getElementById('custom-allow-domains');
    if (blockInput) blockInput.value = '';
    if (allowInput) allowInput.value = '';
    apiKeyInput.value = '';
    trackingToggle.checked = true;
    showStatus(dataStatus, 'All data deleted.');
    document.querySelectorAll('.theme-btn').forEach((btn) => {
      const on = btn.dataset.theme === 'auto';
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    applyTheme('auto');
    deleteDataBtn.disabled = false;
    deleteDataBtn.textContent = 'Delete all data';
  }

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
    deletionInProgress = true;

    // The service worker owns deletion so queued logging/session writes are
    // serialized behind the deletion barrier and cannot resurrect data.
    chrome.runtime.sendMessage({ type: 'DELETE_ALL_DATA' }, (response) => {
      if (chrome.runtime.lastError || response?.status !== 'ok') {
        deletionInProgress = true;
        deleteDataBtn.disabled = false;
        deleteDataBtn.textContent = 'Delete all data';
        showStatus(dataStatus, response?.message || 'Could not delete all data.');
        return;
      }
      resetDeletedSettings();
    });
  });

  let autoColorSchemeMedia = null;
  let autoColorSchemeListener = null;

  function applyTheme(theme) {
    const root = document.documentElement;
    if (autoColorSchemeMedia && autoColorSchemeListener) {
      autoColorSchemeMedia.removeEventListener('change', autoColorSchemeListener);
      autoColorSchemeMedia = null;
      autoColorSchemeListener = null;
    }
    if (theme === 'auto') {
      root.style.removeProperty('color-scheme');
      root.classList.remove('theme-light');
      autoColorSchemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
      autoColorSchemeListener = () => {
        root.classList.toggle('theme-dark', autoColorSchemeMedia.matches);
      };
      autoColorSchemeListener();
      autoColorSchemeMedia.addEventListener('change', autoColorSchemeListener);
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

  testInterventionBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'TEST_INTERVENTION' }, (response) => {
      if (chrome.runtime.lastError) {
        showStatus(testInterventionStatus, 'Could not reach extension background. Reload the extension.');
        return;
      }
      if (response?.ok) {
        showStatus(testInterventionStatus, 'Intervention triggered on your current tab.');
      } else {
        showStatus(testInterventionStatus, response?.error || 'Could not trigger intervention.');
      }
    });
  });

  document.querySelectorAll('.theme-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (deletionInProgress) return;
      const theme = btn.dataset.theme;
      mutateStorage('theme', { theme }).then(guardStorageContinuation(() => {
        document.querySelectorAll('.theme-btn').forEach((b) => {
          const on = b === btn;
          b.classList.toggle('active', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        if (deletionInProgress) return;
        applyTheme(theme);
        showStatus(themeStatus, 'Theme updated.');
        chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' });
      }), error => showStatus(themeStatus, error.message));
    });
  });
});
