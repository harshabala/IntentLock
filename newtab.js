import { generateIntentPlan } from './llm.js';

document.addEventListener('DOMContentLoaded', () => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

  let timerInterval = null;

  chrome.storage.local.get(['activeSession'], (result) => {
    if (result.activeSession && result.activeSession.isActive) {
      showActiveState(result.activeSession);
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
    editBtn.addEventListener('click', () => {
      showEditIntentDialog(session, intentText);
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
    btn.addEventListener('click', () => showConfirmEndDialog(container, session));
    actions.appendChild(btn);

    container.appendChild(actions);
  }

  // ── Confirmation dialog ─────────────────────────────────────────────

  function showConfirmEndDialog(container, session) {
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
    cancelBtn.addEventListener('click', () => {
      closeOverlay(overlay);
    });

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = 'End session';
    confirmBtn.addEventListener('click', () => {
      closeOverlay(overlay, () => endSession(container, session));
    });

    actions.append(cancelBtn, confirmBtn);
    dialog.append(h3, p, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  }

  function showEditIntentDialog(session, intentTextElement) {
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

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'complete-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      closeOverlay(overlay);
    });

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
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
      closeOverlay(overlay);
    });

    actions.append(cancelBtn, saveBtn);
    dialog.append(h3, textarea, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    textarea.focus();
  }

  // ── Session summary ─────────────────────────────────────────────────

  function endSession(container, session) {
    if (timerInterval) clearInterval(timerInterval);

    chrome.storage.local.get(['activeSession'], (result) => {
      const s = result.activeSession;
      if (!s) return;

      s.isActive = false;
      s.endTime = Date.now();

      // Save to history
      chrome.storage.local.get(['sessionHistory'], (histResult) => {
        const history = histResult.sessionHistory || [];
        history.push(createHistoryEntry(s));
        // Keep last 100 sessions
        if (history.length > 100) history.shift();

        chrome.storage.local.set({ sessionHistory: history }, () => {
          chrome.storage.local.remove(['activeSession', 'interventionState'], () => {
            chrome.runtime.sendMessage({ type: 'SESSION_CLEARED' }, () => {
              showSummary(container, s);
            });
          });
        });
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

    // Check for API key
    const getApiKeyFromStorage = (callback) => {
      if (chrome.storage.session) {
        chrome.storage.session.get(['openaiApiKey'], (sessionResult) => {
          if (sessionResult && sessionResult.openaiApiKey) {
            callback(sessionResult.openaiApiKey);
          } else {
            chrome.storage.local.get(['openaiApiKey'], (localResult) => {
              callback(localResult ? localResult.openaiApiKey || null : null);
            });
          }
        });
      } else {
        chrome.storage.local.get(['openaiApiKey'], (localResult) => {
          callback(localResult ? localResult.openaiApiKey || null : null);
        });
      }
    };

    getApiKeyFromStorage((apiKey) => {
      if (!apiKey) {
        const apiNotice = document.createElement('div');
        apiNotice.className = 'api-notice';
        const noticeText = document.createElement('p');
        noticeText.textContent = 'Add an OpenAI API key in Settings to enable AI-powered drift detection.';
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
    shortcutsBtn.innerHTML = '?';
    shortcutsBtn.addEventListener('click', showShortcutsModal);
    container.appendChild(shortcutsBtn);

    bindForm();
  }

  // ── Keyboard shortcuts modal ─────────────────────────────────────────

  function showShortcutsModal() {
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
    closeBtn.addEventListener('click', () => {
      closeOverlay(modal);
    });
    content.appendChild(closeBtn);

    modal.appendChild(content);
    document.body.appendChild(modal);

    // Close on escape
    const handleEsc = (e) => {
      if (e.key === 'Escape') {
        closeOverlay(modal, () => document.removeEventListener('keydown', handleEsc));
      }
    };
    document.addEventListener('keydown', handleEsc);

    // Close on overlay click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeOverlay(modal, () => document.removeEventListener('keydown', handleEsc));
      }
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
        const msg = document.getElementById('status-message');
        msg.textContent = 'Please declare your intent.';
        msg.classList.remove('hidden');
        msg.style.display = 'block';
        if (reducedMotion) {
          msg.style.opacity = '1';
        } else {
          msg.style.opacity = '0';
          msg.style.transition = 'opacity 200ms cubic-bezier(0.2, 0, 0, 1)';
          msg.offsetHeight;
          msg.style.opacity = '1';
        }
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
