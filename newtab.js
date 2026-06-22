import { generateIntentPlan } from './llm.js';
import {
  PROVIDER_LIST,
  DEFAULT_PROVIDER_ID,
  getProvider,
  getDefaultProviderConfig,
  getLlmConfig,
  isLlmConfigured,
  validateApiKey,
} from './providers.js';

document.addEventListener('DOMContentLoaded', () => {
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

  function closeOverlay(overlay, callback) {
    let done = false;
    function finish() {
      if (done) return;
      done = true;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (callback) callback();
    }
    if (reducedMotion) {
      finish();
      return;
    }
    overlay.classList.add('closing');
    overlay.addEventListener('transitionend', function handler(e) {
      if (e.target !== overlay) return;
      overlay.removeEventListener('transitionend', handler);
      finish();
    });
    // Fallback in case transitionend doesn't fire
    setTimeout(finish, 250);
  }

  function setupModalDialog({ overlay, dialog, heading, trigger }) {
    const previousFocus = trigger || document.activeElement;
    const headingId = `modal-title-${crypto.randomUUID()}`;
    heading.id = headingId;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', headingId);

    const FOCUSABLE_SELECTOR =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

    function getFocusableElements() {
      return Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR))
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
    }

    function restoreFocus() {
      if (previousFocus && typeof previousFocus.focus === 'function') {
        previousFocus.focus();
      }
    }

    function handleKeydown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeModal();
        return;
      }
      if (e.key !== 'Tab') return;

      const focusable = getFocusableElements();
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    function teardown() {
      document.removeEventListener('keydown', handleKeydown);
    }

    function closeModal(callback) {
      teardown();
      closeOverlay(overlay, () => {
        restoreFocus();
        if (callback) callback();
      });
    }

    document.addEventListener('keydown', handleKeydown);

    const focusable = getFocusableElements();
    if (focusable.length > 0) {
      focusable[0].focus();
    } else {
      dialog.setAttribute('tabindex', '-1');
      dialog.focus();
    }

    return { closeModal };
  }

  let timerInterval = null;

  chrome.storage.local.get(['activeSession', 'hasSeenOnboarding'], (result) => {
    if (result.activeSession && result.activeSession.isActive) {
      showActiveState(result.activeSession);
    } else if (!result.hasSeenOnboarding) {
      showOnboardingWizard(document.querySelector('.lock-container'));
    } else {
      showNewSessionForm(document.querySelector('.lock-container'));
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.activeSession) {
      const session = changes.activeSession.newValue;
      if (session && session.isActive) {
        showActiveState(session);
      } else {
        if (timerInterval) {
          clearInterval(timerInterval);
          timerInterval = null;
        }
        document.querySelectorAll('.confirm-overlay').forEach(el => el.remove());
        showNewSessionForm(document.querySelector('.lock-container'));
      }
    }
  });

  // ── Live session timer ──────────────────────────────────────────────


  function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function createTimer(session, parent) {
    const timerEl = document.createElement('div');
    timerEl.className = 'session-timer';

    const timeLabel = document.createElement('span');
    timeLabel.className = 'timer-label';

    const timeValue = document.createElement('span');
    timeValue.className = 'timer-value';

    timerEl.append(timeLabel, timeValue);
    parent.appendChild(timerEl);

    function getElapsed() {
      return Date.now() - session.startTime;
    }

    function tick() {
      const elapsed = getElapsed();
      if (session.timeBudget) {
        const budgetMs = session.timeBudget * 60000;
        const remaining = budgetMs - elapsed;
        if (remaining > 0) {
          timeLabel.textContent = 'Remaining';
          timeValue.textContent = formatTime(remaining);
          timerEl.classList.remove('timer-exceeded');
        } else {
          timeLabel.textContent = 'Exceeded by';
          timeValue.textContent = formatTime(Math.abs(remaining));
          timerEl.classList.add('timer-exceeded');
        }
      } else {
        timeLabel.textContent = 'Elapsed';
        timeValue.textContent = formatTime(elapsed);
      }
    }

    tick();
    timerInterval = setInterval(tick, 1000);
    return timerEl;
  }

  function createHistoryEntry(session) {
    const events = Array.isArray(session.events) ? session.events : [];
    return {
      id: session.id,
      intent: session.intent,
      startTime: session.startTime,
      endTime: session.endTime,
      timeBudget: session.timeBudget,
      driftCount: events.filter(e => e.actionType === 'OVERRIDE').length,
      totalEvents: events.length
    };
  }

  // ── Active session state ────────────────────────────────────────────

  function showActiveState(session) {
    if (timerInterval) clearInterval(timerInterval);
    const container = document.querySelector('.lock-container');
    container.textContent = '';

    // Header
    const header = document.createElement('div');
    header.className = 'header';
    const h1 = document.createElement('h1');
    h1.textContent = 'Session locked';
    const label = document.createElement('p');
    label.className = 'intent-active-label';
    label.textContent = 'Intent active';
    header.append(h1, label);
    container.appendChild(header);

    // Timer
    createTimer(session, container);

    // Real-time stats
    const statsDiv = document.createElement('div');
    statsDiv.className = 'session-stats';

    const events = Array.isArray(session.events) ? session.events : [];
    const pageLoads = events.filter(e => e.actionType === 'PAGE_LOAD').length;
    const tabSwitches = events.filter(e => e.actionType === 'TAB_SWITCH').length;
    const drifts = events.filter(e => e.actionType === 'OVERRIDE').length;

    const stats = [
      { value: String(pageLoads), label: 'Pages' },
      { value: String(tabSwitches), label: 'Switches' },
      { value: String(drifts), label: 'Drifts' }
    ];

    stats.forEach(stat => {
      const box = document.createElement('div');
      box.className = 'stat-box';
      const value = document.createElement('div');
      value.className = 'stat-value';
      value.textContent = stat.value;
      const label = document.createElement('div');
      label.className = 'stat-label';
      label.textContent = stat.label;
      box.append(value, label);
      statsDiv.appendChild(box);
    });

    container.appendChild(statsDiv);

    // Intent display
    const intentBox = document.createElement('div');
    intentBox.className = 'intent-display';
    const intentHeader = document.createElement('div');
    intentHeader.className = 'intent-header';
    const intentText = document.createElement('p');
    intentText.className = 'intent-text';
    intentText.textContent = session.intent;
    const editBtn = document.createElement('button');
    editBtn.className = 'edit-intent-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', (e) => {
      showEditIntentDialog(session, intentText, e.currentTarget);
    });
    intentHeader.append(intentText, editBtn);
    intentBox.appendChild(intentHeader);
    container.appendChild(intentBox);

    // Plan
    const plan = session.plan || [];
    if (plan.length > 0) {
      const planSection = document.createElement('div');
      planSection.className = 'plan-section';
      const planHeading = document.createElement('h3');
      planHeading.className = 'plan-heading';
      planHeading.textContent = 'Plan';
      planSection.appendChild(planHeading);

      const planList = document.createElement('ul');
      planList.className = 'plan-list';
      plan.forEach((step) => {
        const li = document.createElement('li');
        li.className = 'plan-step';
        li.textContent = step;
        planList.appendChild(li);
      });
      planSection.appendChild(planList);
      container.appendChild(planSection);
    }

    // Hint
    const hint = document.createElement('p');
    hint.className = 'navigate-hint';
    hint.textContent = 'Use the address bar to navigate.';
    container.appendChild(hint);

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'session-actions';

    // Complete button
    const btn = document.createElement('button');
    btn.className = 'complete-btn';
    btn.textContent = 'Complete session';
    btn.addEventListener('click', (e) => showConfirmEndDialog(container, session, e.currentTarget));
    actions.appendChild(btn);

    container.appendChild(actions);
  }

  // ── Confirmation dialog ─────────────────────────────────────────────

  function showConfirmEndDialog(container, session, trigger) {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';

    const h3 = document.createElement('h3');
    h3.textContent = 'End session?';

    const p = document.createElement('p');
    const elapsed = Math.round((Date.now() - session.startTime) / 60000);
    const events = Array.isArray(session.events) ? session.events : [];
    const drifts = events.filter(e => e.actionType === 'OVERRIDE').length;
    p.textContent = `You've been working for ${elapsed} minutes with ${drifts} drift${drifts !== 1 ? 's' : ''}. Are you sure you want to end this session?`;

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'complete-btn';
    cancelBtn.textContent = 'Cancel';

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = 'End session';

    actions.append(cancelBtn, confirmBtn);
    dialog.append(h3, p, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const { closeModal } = setupModalDialog({ overlay, dialog, heading: h3, trigger });

    cancelBtn.addEventListener('click', () => closeModal());
    confirmBtn.addEventListener('click', () => closeModal(() => endSession(container, session)));
  }

  function showEditIntentDialog(session, intentTextElement, trigger) {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';

    const h3 = document.createElement('h3');
    h3.textContent = 'Edit intent';

    const textarea = document.createElement('textarea');
    textarea.className = 'edit-intent-textarea';
    textarea.value = session.intent;
    textarea.rows = 3;
    textarea.maxLength = 250;

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'complete-btn';
    cancelBtn.textContent = 'Cancel';

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';

    actions.append(cancelBtn, saveBtn);
    dialog.append(h3, textarea, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const { closeModal } = setupModalDialog({ overlay, dialog, heading: h3, trigger });

    cancelBtn.addEventListener('click', () => closeModal());
    saveBtn.addEventListener('click', () => {
      const newIntent = textarea.value.trim();
      if (newIntent && newIntent !== session.intent) {
        chrome.storage.local.get(['activeSession'], (result) => {
          const currentSession = result.activeSession;
          if (currentSession) {
            currentSession.intent = newIntent;
            chrome.storage.local.set({ activeSession: currentSession });
          }
        });
        intentTextElement.textContent = newIntent;
      }
      closeModal();
    });
  }

  // ── Session summary ─────────────────────────────────────────────────

  function endSession(container, session) {
    if (timerInterval) clearInterval(timerInterval);

    chrome.runtime.sendMessage({ type: 'END_ACTIVE_SESSION' }, (response) => {
      chrome.runtime.sendMessage({ type: 'SESSION_CLEARED' }, () => {
        const endedSession = (response && response.session) ? response.session : session;
        showSummary(container, endedSession);
      });
    });
  }

  function showSummary(container, session) {
    container.textContent = '';

    const header = document.createElement('div');
    header.className = 'header';
    const h1 = document.createElement('h1');
    h1.textContent = 'Session complete';
    header.appendChild(h1);
    container.appendChild(header);

    // Stats
    const stats = document.createElement('div');
    stats.className = 'summary-stats';

    const events = Array.isArray(session.events) ? session.events : [];
    const duration = Math.round((session.endTime - session.startTime) / 60000);
    const drifts = events.filter(e => e.actionType === 'OVERRIDE').length;
    const pageLoads = events.filter(e => e.actionType === 'PAGE_LOAD').length;

    const statItems = [
      { label: 'Duration', value: `${duration} min` },
      { label: 'Pages visited', value: String(pageLoads) },
      { label: 'Drift overrides', value: String(drifts) },
    ];

    if (session.timeBudget) {
      const diff = duration - session.timeBudget;
      statItems.push({
        label: 'Budget',
        value: diff <= 0 ? `${Math.abs(diff)} min under` : `${diff} min over`
      });
    }

    statItems.forEach(item => {
      const row = document.createElement('div');
      row.className = 'stat-row';
      const label = document.createElement('span');
      label.className = 'stat-label';
      label.textContent = item.label;
      const value = document.createElement('span');
      value.className = 'stat-value';
      value.textContent = item.value;
      row.append(label, value);
      stats.appendChild(row);
    });

    container.appendChild(stats);

    // Intent recall
    const intentBox = document.createElement('div');
    intentBox.className = 'intent-display';
    const intentText = document.createElement('p');
    intentText.className = 'intent-text';
    intentText.textContent = session.intent;
    intentBox.appendChild(intentText);
    container.appendChild(intentBox);

    // Override reflections (if any)
    const overrides = events.filter(e => e.actionType === 'OVERRIDE' && e.reflection);
    if (overrides.length > 0) {
      const reflSection = document.createElement('div');
      reflSection.className = 'plan-section';
      const reflTitle = document.createElement('h3');
      reflTitle.className = 'plan-heading';
      reflTitle.textContent = 'Reflections';
      reflSection.appendChild(reflTitle);

      overrides.forEach(o => {
        const p = document.createElement('p');
        p.className = 'reflection-text';
        p.textContent = o.reflection;
        reflSection.appendChild(p);
      });
      container.appendChild(reflSection);
    }

    const skipBtn = document.createElement('button');
    skipBtn.className = 'complete-btn';
    skipBtn.textContent = 'Start new session';
    skipBtn.addEventListener('click', () => showNewSessionForm(container));
    container.appendChild(skipBtn);
  }

  // ── Onboarding wizard ────────────────────────────────────────────────

  function showOnboardingWizard(container) {
    function showStep1() {
      container.textContent = '';

      const header = document.createElement('div');
      header.className = 'header onboarding-header';

      const h1 = document.createElement('h1');
      h1.textContent = 'WELCOME TO INTENTLOCK';

      const desc = document.createElement('p');
      desc.textContent = 'IntentLock is a minimalist tool designed to keep you focused. Before you start browsing, you declare your intent. If you drift off-task, the extension intervenes to help you stay aligned.';

      header.append(h1, desc);
      container.appendChild(header);

      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'primary-btn onboarding-btn';
      nextBtn.textContent = 'NEXT';
      nextBtn.addEventListener('click', showStep2);
      container.appendChild(nextBtn);
    }

    function showStep2() {
      container.textContent = '';

      const header = document.createElement('div');
      header.className = 'header onboarding-header';

      const h1 = document.createElement('h1');
      h1.textContent = 'ENABLE AI-POWERED ALIGNMENT';

      const desc = document.createElement('p');
      desc.textContent = 'Choose a provider for semantic drift detection and plan generation. Use Gemini from Google AI Studio, a local Ollama/LM Studio server, or skip to use heuristics only.';

      header.append(h1, desc);
      container.appendChild(header);

      const providerGroup = document.createElement('div');
      providerGroup.className = 'input-group onboarding-input-group';

      const providerLabel = document.createElement('label');
      providerLabel.setAttribute('for', 'onboarding-provider');
      providerLabel.textContent = 'Provider';

      const providerSelect = document.createElement('select');
      providerSelect.id = 'onboarding-provider';
      PROVIDER_LIST.forEach((provider) => {
        const option = document.createElement('option');
        option.value = provider.id;
        option.textContent = provider.label;
        providerSelect.appendChild(option);
      });
      providerGroup.append(providerLabel, providerSelect);
      container.appendChild(providerGroup);

      const inputGroup = document.createElement('div');
      inputGroup.className = 'input-group onboarding-input-group';
      inputGroup.id = 'onboarding-key-group';

      const label = document.createElement('label');
      label.setAttribute('for', 'onboarding-api-key');
      label.textContent = 'API Key';

      const input = document.createElement('input');
      input.type = 'password';
      input.id = 'onboarding-api-key';
      input.placeholder = 'sk-...';
      input.autocomplete = 'new-password';

      inputGroup.append(label, input);
      container.appendChild(inputGroup);

      function updateOnboardingProviderUI() {
        const provider = getProvider(providerSelect.value);
        input.placeholder = provider.keyPlaceholder;
        const needsKey = provider.requiresApiKey;
        inputGroup.classList.toggle('hidden', !needsKey);
      }

      providerSelect.addEventListener('change', updateOnboardingProviderUI);
      updateOnboardingProviderUI();

      const securityNotice = document.createElement('p');
      securityNotice.className = 'security-notice';
      securityNotice.textContent = 'For security, your key is kept in secure session memory and cleared when the browser is closed.';
      container.appendChild(securityNotice);

      const actionsRow = document.createElement('div');
      actionsRow.className = 'onboarding-actions';

      const skipBtn = document.createElement('button');
      skipBtn.type = 'button';
      skipBtn.className = 'complete-btn onboarding-skip-btn';
      skipBtn.textContent = 'SKIP';
      skipBtn.addEventListener('click', finishOnboarding);

      const lockInBtn = document.createElement('button');
      lockInBtn.type = 'button';
      lockInBtn.className = 'primary-btn onboarding-lock-btn';
      lockInBtn.textContent = 'LOCK IN';
      lockInBtn.addEventListener('click', () => {
        const providerId = providerSelect.value || DEFAULT_PROVIDER_ID;
        const provider = getProvider(providerId);
        const apiKey = input.value.trim();
        const providerConfig = getDefaultProviderConfig(providerId);

        if (provider.requiresApiKey) {
          const keyError = validateApiKey(providerId, apiKey);
          if (keyError) {
            setFieldError(input, keyError);
            return;
          }
        }

        const saveProvider = () => {
          chrome.storage.local.set({ llmProviderConfig: providerConfig }, () => {
            chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' }, () => {
              if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError);
              finishOnboarding();
            });
          });
        };

        if (apiKey) {
          const storageArea = chrome.storage.session || chrome.storage.local;
          storageArea.set({ llmApiKey: apiKey }, saveProvider);
        } else {
          saveProvider();
        }
      });

      actionsRow.append(skipBtn, lockInBtn);
      container.appendChild(actionsRow);

      input.focus();
      input.addEventListener('input', () => {
        clearFieldError(input);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          lockInBtn.click();
        }
      });
    }

    function finishOnboarding() {
      chrome.storage.local.set({ hasSeenOnboarding: true }, () => {
        if (chrome.runtime.lastError) console.error(chrome.runtime.lastError);
        showNewSessionForm(container);
      });
    }

    showStep1();
  }

  // ── New session form (post-session) ─────────────────────────────────

  function showNewSessionForm(container) {
    if (timerInterval) clearInterval(timerInterval);
    container.textContent = '';

    const header = document.createElement('div');
    header.className = 'header';
    const h1 = document.createElement('h1');
    h1.textContent = 'IntentLock';
    const p = document.createElement('p');
    p.textContent = 'Declare what you intend to do.';
    header.append(h1, p);
    container.appendChild(header);

    const form = document.createElement('form');
    form.id = 'intent-form';
    form.noValidate = true;

    const intentGroup = document.createElement('div');
    intentGroup.className = 'input-group';
    const intentLabel = document.createElement('label');
    intentLabel.setAttribute('for', 'intent-input');
    intentLabel.textContent = 'Intent';
    const intentInput = document.createElement('textarea');
    intentInput.id = 'intent-input';
    intentInput.placeholder = 'Research Python decorators for the new module...';
    intentInput.required = true;
    intentInput.autofocus = true;
    intentInput.maxLength = 250;
    intentGroup.append(intentLabel, intentInput);

    const timeGroup = document.createElement('div');
    timeGroup.className = 'input-group';
    const timeLabel = document.createElement('label');
    timeLabel.setAttribute('for', 'time-budget');
    timeLabel.textContent = 'Time budget (minutes)';
    const timeInput = document.createElement('input');
    timeInput.type = 'text';
    timeInput.inputMode = 'numeric';
    timeInput.pattern = '[0-9]*';
    timeInput.id = 'time-budget';
    timeInput.autocomplete = 'off';
    timeInput.placeholder = '30';
    timeGroup.append(timeLabel, timeInput);

    const btn = document.createElement('button');
    btn.type = 'submit';
    btn.id = 'start-btn';
    btn.textContent = 'Lock in';

    form.append(intentGroup, timeGroup, btn);
    container.appendChild(form);

    getLlmConfig().then((config) => {
      if (!isLlmConfigured(config)) {
        const apiNotice = document.createElement('div');
        apiNotice.className = 'api-notice';
        const noticeText = document.createElement('p');
        noticeText.textContent = 'Configure an LLM provider in Settings to enable AI-powered drift detection and plan generation.';
        const noticeBtn = document.createElement('button');
        noticeBtn.className = 'complete-btn';
        noticeBtn.textContent = 'Open settings';
        noticeBtn.addEventListener('click', () => {
          chrome.runtime.openOptionsPage();
        });
        apiNotice.append(noticeText, noticeBtn);
        if (form && form.parentNode === container) {
          container.insertBefore(apiNotice, form);
        }
      }
    });

    const statusMsg = document.createElement('div');
    statusMsg.id = 'status-message';
    statusMsg.className = 'hidden';
    container.appendChild(statusMsg);

    // Keyboard shortcuts button
    const shortcutsBtn = document.createElement('button');
    shortcutsBtn.className = 'shortcuts-btn';
    shortcutsBtn.type = 'button';
    shortcutsBtn.setAttribute('aria-label', 'Keyboard shortcuts');
    shortcutsBtn.textContent = '?';
    shortcutsBtn.addEventListener('click', (e) => showShortcutsModal(e.currentTarget));
    container.appendChild(shortcutsBtn);

    intentInput.addEventListener('input', () => {
      clearFieldError(intentInput);
    });

    bindForm();
  }

  // ── Keyboard shortcuts modal ─────────────────────────────────────────

  function showShortcutsModal(trigger) {
    const modal = document.createElement('div');
    modal.className = 'shortcuts-modal';

    const content = document.createElement('div');
    content.className = 'shortcuts-content';

    const h3 = document.createElement('h3');
    h3.textContent = 'Keyboard Shortcuts';
    content.appendChild(h3);

    const shortcuts = [
      { keys: ['Ctrl', 'Shift', 'L'], desc: 'Start/End session' },
      { keys: ['Tab'], desc: 'Navigate form fields' },
      { keys: ['Enter'], desc: 'Submit form' },
      { keys: ['Esc'], desc: 'Close modal' }
    ];

    shortcuts.forEach(shortcut => {
      const row = document.createElement('div');
      row.className = 'shortcut-row';

      const keys = document.createElement('div');
      keys.className = 'shortcut-keys';
      shortcut.keys.forEach(key => {
        const kbd = document.createElement('span');
        kbd.className = 'shortcut-key';
        kbd.textContent = key;
        keys.appendChild(kbd);
      });

      const desc = document.createElement('span');
      desc.className = 'shortcut-desc';
      desc.textContent = shortcut.desc;

      row.append(keys, desc);
      content.appendChild(row);
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'complete-btn';
    closeBtn.textContent = 'Close';
    content.appendChild(closeBtn);

    modal.appendChild(content);
    document.body.appendChild(modal);

    const { closeModal } = setupModalDialog({ overlay: modal, dialog: content, heading: h3, trigger });

    closeBtn.addEventListener('click', () => closeModal());

    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
  }

  // ── Form binding ────────────────────────────────────────────────────

  function bindForm() {
    const form = document.getElementById('intent-form');
    if (!form) return;

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const intentInput = document.getElementById('intent-input');
      const timeBudgetInput = document.getElementById('time-budget');
      const startBtn = document.getElementById('start-btn');
      const intent = intentInput.value.trim();
      const timeBudget = parseInt(timeBudgetInput.value, 10);

      if (!intent) {
        setFieldError(intentInput, 'Please declare your intent.');
        return;
      }

      if (!isNaN(timeBudget) && (timeBudget < 1 || timeBudget > 480)) {
        const msg = document.getElementById('status-message');
        msg.textContent = 'Time budget must be between 1 and 480 minutes.';
        msg.classList.remove('hidden');
        msg.style.display = 'block';
        msg.style.opacity = '1';
        timeBudgetInput.focus();
        return;
      }

      startBtn.disabled = true;
      startBtn.textContent = 'Generating plan...';

      const sessionData = {
        id: crypto.randomUUID(),
        intent: intent,
        startTime: Date.now(),
        timeBudget: isNaN(timeBudget) ? null : timeBudget,
        isActive: true,
        events: [],
        plan: []
      };

      generateIntentPlan(intent).then(plan => {
        sessionData.plan = plan;
        chrome.storage.local.set({ activeSession: sessionData }, () => {
          chrome.runtime.sendMessage({ type: 'SESSION_STARTED', session: sessionData }, () => {
            if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError);
            showActiveState(sessionData);
          });
        });
      });
    });
  }
});
