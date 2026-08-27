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

import { generateIntentPlan } from './llm.js';
import { getLlmConfig, isLlmConfigured } from './providers.js';
import { mergePolicyWithIntent } from './heuristic-policy.js';
import { logError, ERROR_TYPES } from './error-log.js';
import { sanitizeSessionHistory } from './privacy-utils.js';
import {
  ON_INTENT_METHOD_COPY,
  PRIVACY_COPY,
} from './session-metrics.js';
import { beginStorageDeletion, endStorageDeletion } from './storage-queue.js';
import { showOnboardingWizard } from './onboarding.js';

let dataDeletionInProgress = false;
let cachedHeuristicPolicy = null;

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'DATA_DELETION_STARTED') {
    dataDeletionInProgress = true;
    beginStorageDeletion();
  }
  if (message?.type === 'DATA_DELETED') {
    dataDeletionInProgress = false;
    endStorageDeletion();
  }
});

function sanitizeStoredHistory(rawHistory) {
  const raw = Array.isArray(rawHistory) ? rawHistory : [];
  const sanitized = sanitizeSessionHistory(raw);
  return sanitized;
}

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

  const wantReport = new URLSearchParams(location.search).get('report') === 'last';

  chrome.storage.local.get(['activeSession', 'hasSeenOnboarding', 'sessionHistory', 'heuristicPolicy'], (result) => {
    cachedHeuristicPolicy = result.heuristicPolicy || null;
    const container = document.querySelector('.lock-container');
    if (result.activeSession && result.activeSession.isActive) {
      showActiveState(result.activeSession);
      return;
    }
    if (wantReport) {
      const history = sanitizeStoredHistory(result.sessionHistory);
      const last = history.length > 0 ? history[history.length - 1] : null;
      if (last) {
        showSummary(container, last);
        return;
      }
    }
    if (!result.hasSeenOnboarding) {
      showOnboardingWizard(container, {
        showNewSessionForm,
        isDeletionInProgress: () => dataDeletionInProgress,
      });
    } else {
      showNewSessionForm(container);
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && Object.prototype.hasOwnProperty.call(changes, 'heuristicPolicy')) {
      cachedHeuristicPolicy = changes.heuristicPolicy.newValue || null;
    }
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
        
        const oldSession = changes.activeSession.oldValue;
        if (oldSession && oldSession.isActive) {
          chrome.storage.local.get(['sessionHistory'], (result) => {
            const history = sanitizeStoredHistory(result.sessionHistory);
            const lastSession = history.find(h => h.id === oldSession.id);
            if (lastSession) {
              const endedSession = {
                ...oldSession,
                isActive: false,
                endTime: lastSession.endTime || Date.now()
              };
              showSummary(document.querySelector('.lock-container'), endedSession);
            } else {
              showNewSessionForm(document.querySelector('.lock-container'));
            }
          });
        } else {
          showNewSessionForm(document.querySelector('.lock-container'));
        }
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

    const header = document.createElement('div');
    header.className = 'header';
    const intentQuote = document.createElement('p');
    intentQuote.className = 'intent-quote intent-statement';
    intentQuote.textContent = session.intent;
    header.appendChild(intentQuote);
    container.appendChild(header);

    createTimer(session, container);

    const actions = document.createElement('div');
    actions.className = 'session-actions';

    const btn = document.createElement('button');
    btn.className = 'complete-btn';
    btn.textContent = 'End session';
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
    const overrides = typeof session.overrideCount === 'number'
      ? session.overrideCount
      : events.filter(e => e.actionType === 'OVERRIDE').length;
    p.textContent = `${elapsed} minutes. ${overrides} override${overrides !== 1 ? 's' : ''}. End this session?`;

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

  // ── Session summary ─────────────────────────────────────────────────

  function endSession(container, session) {
    if (timerInterval) clearInterval(timerInterval);

    chrome.runtime.sendMessage({ type: 'END_ACTIVE_SESSION', sessionId: session.id }, (response) => {
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
    h1.textContent = 'Session report';
    header.appendChild(h1);
    container.appendChild(header);

    // Intent
    const intentBox = document.createElement('div');
    intentBox.className = 'intent-display';
    const intentText = document.createElement('p');
    intentText.className = 'intent-text';
    intentText.textContent = session.intent || '—';
    intentBox.appendChild(intentText);
    container.appendChild(intentBox);

    const events = Array.isArray(session.events) ? session.events : [];
    const storedOverrides = Array.isArray(session.overrides) ? session.overrides : [];
    const eventOverrides = events.filter(e => e.actionType === 'OVERRIDE');
    const overrideRecords = storedOverrides.length > 0 ? storedOverrides : eventOverrides;
    const durationMin = Math.max(
      0,
      Math.round(((session.endTime || Date.now()) - (session.startTime || Date.now())) / 60000)
    );
    const ratio =
      typeof session.onIntentRatio === 'number'
        ? session.onIntentRatio
        : null;
    const activeMin = Math.round((session.activeMs || 0) / 60000);
    const alignedMin = Math.round((session.alignedActiveMs || 0) / 60000);
    const interventions =
      typeof session.interventionCount === 'number'
        ? session.interventionCount
        : 0;
    const overridesCount =
      typeof session.overrideCount === 'number'
        ? session.overrideCount
        : overrideRecords.length;

    // Hero on-intent %
    const hero = document.createElement('div');
    hero.className = 'summary-stats';
    hero.style.textAlign = 'center';
    const heroValue = document.createElement('div');
    heroValue.className = 'stat-value';
    heroValue.style.fontSize = '2.4rem';
    heroValue.style.fontWeight = '600';
    heroValue.textContent = ratio == null ? '—' : `${Math.round(ratio * 100)}%`;
    const heroLabel = document.createElement('div');
    heroLabel.className = 'stat-label';
    heroLabel.textContent = 'On-intent';
    const heroLine = document.createElement('p');
    heroLine.className = 'field-hint';
    heroLine.style.marginTop = '8px';
    if (ratio == null) {
      heroLine.textContent =
        'Not enough activity data to score this session.';
    } else {
      heroLine.textContent = `${alignedMin} of ${activeMin} minutes matched your intent.`;
    }
    const method = document.createElement('p');
    method.className = 'field-hint';
    method.style.fontSize = '0.75rem';
    method.style.opacity = '0.8';
    method.textContent = ON_INTENT_METHOD_COPY;
    hero.append(heroValue, heroLabel, heroLine, method);
    container.appendChild(hero);

    // Stats
    const stats = document.createElement('div');
    stats.className = 'summary-stats';

    const statItems = [
      { label: 'Duration', value: `${durationMin} min` },
      { label: 'Interventions', value: String(interventions) },
      { label: 'Overrides', value: String(overridesCount) },
    ];

    if (session.timeBudget) {
      const diff = durationMin - session.timeBudget;
      statItems.push({
        label: 'Budget',
        value: diff <= 0 ? `${Math.abs(diff)} min under` : `${diff} min over`,
      });
    }

    statItems.forEach((item) => {
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

    // Top domains from metrics (prefer) or override fallback
    const domains =
      Array.isArray(session.topDomains) && session.topDomains.length > 0
        ? session.topDomains
        : null;
    if (domains) {
      const section = document.createElement('div');
      section.className = 'plan-section';
      const title = document.createElement('h3');
      title.className = 'plan-heading';
      title.textContent = 'Top domains';
      section.appendChild(title);
      domains.forEach((d) => {
        const row = document.createElement('div');
        row.className = 'stat-row';
        const name = document.createElement('span');
        name.className = 'stat-label';
        name.textContent = d.hostname;
        const val = document.createElement('span');
        val.className = 'stat-value';
        const mins = Math.max(1, Math.round((d.activeMs || 0) / 60000));
        val.textContent = `${mins}m · ${d.aligned ? 'aligned' : 'drift'}`;
        row.append(name, val);
        section.appendChild(row);
      });
      container.appendChild(section);
    }

    const privacy = document.createElement('p');
    privacy.className = 'field-hint';
    privacy.style.marginTop = '12px';
    privacy.textContent = PRIVACY_COPY;
    container.appendChild(privacy);

    // Mark report viewed → activation metric
    if (session.id) {
      chrome.runtime.sendMessage({ type: 'REPORT_VIEWED', sessionId: session.id }, () => {
        void chrome.runtime.lastError;
      });
    }

    // Override reflections (if any) — prefer session.overrides after sanitization
    const reflections = overrideRecords.filter((o) => o.reflection);
    if (reflections.length > 0) {
      const reflSection = document.createElement('div');
      reflSection.className = 'plan-section';
      const reflTitle = document.createElement('h3');
      reflTitle.className = 'plan-heading';
      reflTitle.textContent = 'Reflections';
      reflSection.appendChild(reflTitle);

      reflections.forEach((o) => {
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

    const histLink = document.createElement('button');
    histLink.className = 'popup-link';
    histLink.textContent = 'View in history';
    histLink.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
    });
    container.appendChild(histLink);
  }

  // ── New session form (post-session) ─────────────────────────────────

  function showNewSessionForm(container) {
    if (timerInterval) clearInterval(timerInterval);
    container.textContent = '';

    const header = document.createElement('div');
    header.className = 'header';
    const h1 = document.createElement('h1');
    h1.textContent = 'What are you trying to achieve?';
    header.appendChild(h1);
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
    intentInput.placeholder = "Enter your task (e.g., 'Write Q3 report')";
    intentInput.required = true;
    intentInput.autofocus = true;
    intentInput.maxLength = 250;
    intentGroup.append(intentLabel, intentInput);

    const timeGroup = document.createElement('div');
    timeGroup.className = 'input-group';
    const timeLabel = document.createElement('label');
    timeLabel.setAttribute('for', 'time-budget');
    timeLabel.textContent = 'Minutes (optional)';
    const timeInput = document.createElement('input');
    timeInput.type = 'text';
    timeInput.inputMode = 'numeric';
    timeInput.pattern = '[0-9]*';
    timeInput.id = 'time-budget';
    timeInput.autocomplete = 'off';
    timeInput.placeholder = '30';
    timeInput.addEventListener('input', () => clearFieldError(timeInput));
    timeGroup.append(timeLabel, timeInput);

    const btn = document.createElement('button');
    btn.type = 'submit';
    btn.id = 'start-btn';
    btn.textContent = 'Lock in';

    form.append(intentGroup, timeGroup, btn);
    container.appendChild(form);

    const statusMsg = document.createElement('div');
    statusMsg.id = 'status-message';
    statusMsg.className = 'hidden';
    container.appendChild(statusMsg);

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

      clearFieldError(timeBudgetInput);

      if (!isNaN(timeBudget) && timeBudgetInput.value.trim() && (timeBudget < 1 || timeBudget > 480)) {
        const budgetError = 'Time budget must be between 1 and 480 minutes.';
        setFieldError(timeBudgetInput, budgetError);
        logError({
          type: ERROR_TYPES.VALIDATION,
          message: budgetError,
          details: { value: timeBudgetInput.value.trim() },
          source: 'session_start',
        });
        return;
      }

      startBtn.disabled = true;
      startBtn.textContent = 'Starting session…';

      const sessionData = {
        id: crypto.randomUUID(),
        intent: intent,
        startTime: Date.now(),
        timeBudget: isNaN(timeBudget) ? null : timeBudget,
        isActive: true,
        events: [],
        plan: []
      };

      if (typeof mergePolicyWithIntent === 'function') {
        sessionData.heuristicPolicy = mergePolicyWithIntent(intent, cachedHeuristicPolicy);
      }

      const startSession = () => {
        if (dataDeletionInProgress) {
          setFieldError(intentInput, 'Data deletion is in progress. Please try again afterward.');
          startBtn.disabled = false;
          startBtn.textContent = 'Lock in';
          return;
        }
        chrome.runtime.sendMessage({ type: 'SESSION_STARTED', session: sessionData }, (response) => {
          if (chrome.runtime.lastError || response?.status !== 'ok') {
            logError({
              type: ERROR_TYPES.RUNTIME,
              message: response?.message || 'Could not start session.',
              details: { error: chrome.runtime.lastError?.message },
              source: 'session_start',
            });
            setFieldError(intentInput, 'Could not start session. See Diagnostics in Settings.');
            startBtn.disabled = false;
            startBtn.textContent = 'Lock in';
            return;
          }
          showActiveState(sessionData);
        });
      };

      startSession();

      getLlmConfig().then((config) => {
        if (!isLlmConfigured(config)) return null;
        return generateIntentPlan(intent);
      }).then((result) => {
        if (!result) return;
        if (result.error) {
          logError({
            type: ERROR_TYPES.RUNTIME,
            message: result.error.message,
            source: 'session_start',
          });
        }
      }).catch((err) => {
        logError({
          type: ERROR_TYPES.RUNTIME,
          message: 'Unexpected error while generating a session plan.',
          details: { error: err.message },
          source: 'session_start',
        });
      });
    });
  }
});
