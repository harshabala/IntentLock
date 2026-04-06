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

  chrome.storage.local.get(['activeSession', 'breakUntil', 'onboardingComplete'], (result) => {
    if (!result.onboardingComplete) {
      showOnboarding();
    } else if (result.breakUntil && Date.now() < result.breakUntil) {
      showBreakState(result.breakUntil);
    } else if (result.activeSession && result.activeSession.isActive) {
      showActiveState(result.activeSession);
    } else {
      loadQuickIntents();
    }
  });

  bindForm();

  // ── Onboarding ──────────────────────────────────────────────────────

  function showOnboarding() {
    const container = document.querySelector('.lock-container');
    container.textContent = '';

    const steps = [
      {
        title: 'Welcome to IntentLock',
        description: 'Declare your intent before browsing. Stay focused. Get things done.',
        icon: '🔒'
      },
      {
        title: 'Declare Your Intent',
        description: 'Before opening tabs, state what you intend to accomplish. Set an optional time budget.',
        icon: '📝'
      },
      {
        title: 'Stay On Track',
        description: 'The extension monitors your browsing. If you drift, you\'ll be interrupted and asked to reflect.',
        icon: '🎯'
      },
      {
        title: 'Review & Improve',
        description: 'Track your sessions, see patterns, and build better browsing habits over time.',
        icon: '📊'
      }
    ];

    let currentStep = 0;
    let firstRender = true;
    let transitioning = false;

    function buildStepDOM() {
      container.textContent = '';

      const step = steps[currentStep];

      const header = document.createElement('div');
      header.className = 'header';

      const icon = document.createElement('div');
      icon.className = 'onboarding-icon';
      icon.textContent = step.icon;

      const h1 = document.createElement('h1');
      h1.textContent = step.title;

      const p = document.createElement('p');
      p.textContent = step.description;

      header.append(icon, h1, p);
      container.appendChild(header);

      // Progress dots
      const dots = document.createElement('div');
      dots.className = 'onboarding-dots';
      steps.forEach((_, i) => {
        const dot = document.createElement('span');
        dot.className = 'onboarding-dot' + (i === currentStep ? ' active' : '');
        dots.appendChild(dot);
      });
      container.appendChild(dots);

      // Navigation
      const nav = document.createElement('div');
      nav.className = 'onboarding-nav';

      if (currentStep > 0) {
        const prevBtn = document.createElement('button');
        prevBtn.className = 'complete-btn';
        prevBtn.textContent = 'Back';
        prevBtn.addEventListener('click', () => {
          currentStep--;
          renderStep();
        });
        nav.appendChild(prevBtn);
      }

      const nextBtn = document.createElement('button');
      nextBtn.textContent = currentStep === steps.length - 1 ? 'Get Started' : 'Next';
      nextBtn.addEventListener('click', () => {
        if (currentStep === steps.length - 1) {
          chrome.storage.local.set({ onboardingComplete: true }, () => {
            loadQuickIntents();
          });
        } else {
          currentStep++;
          renderStep();
        }
      });
      nav.appendChild(nextBtn);

      container.appendChild(nav);
    }

    function renderStep() {
      if (transitioning) return;

      if (firstRender || reducedMotion) {
        firstRender = false;
        buildStepDOM();
        return;
      }

      transitioning = true;
      container.style.transition = 'opacity 200ms cubic-bezier(0.2, 0, 0, 1)';
      container.style.opacity = '0';

      setTimeout(() => {
        buildStepDOM();
        container.offsetHeight; // force reflow
        container.style.opacity = '1';
        transitioning = false;
      }, 200);
    }

    renderStep();
  }

  // ── Live session timer ──────────────────────────────────────────────

  let timerInterval = null;

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
      let elapsed = Date.now() - session.startTime;
      // Subtract paused time
      if (session.pausedTime) {
        elapsed -= session.pausedTime;
      }
      // If currently paused, subtract current pause duration
      if (session.isPaused && session.pausedAt) {
        elapsed -= (Date.now() - session.pausedAt);
      }
      return elapsed;
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

  // ── Active session state ────────────────────────────────────────────

  function showActiveState(session) {
    if (timerInterval) clearInterval(timerInterval);
    const container = document.querySelector('.lock-container');
    container.textContent = '';

    // Header
    const header = document.createElement('div');
    header.className = 'header';
    const h1 = document.createElement('h1');
    h1.textContent = session.isPaused ? 'Session paused' : 'Session locked';
    const label = document.createElement('p');
    label.className = 'intent-active-label';
    label.textContent = session.isPaused ? 'Intent on hold' : 'Intent active';
    header.append(h1, label);
    container.appendChild(header);

    // Pause indicator
    if (session.isPaused) {
      const pauseDiv = document.createElement('div');
      pauseDiv.className = 'session-paused';
      const pauseLabel = document.createElement('div');
      pauseLabel.className = 'pause-label';
      pauseLabel.textContent = 'Paused since';
      const pauseTime = document.createElement('div');
      pauseTime.className = 'pause-time';
      pauseTime.textContent = new Date(session.pausedAt).toLocaleTimeString();
      pauseDiv.append(pauseLabel, pauseTime);
      container.appendChild(pauseDiv);
    }

    // Timer
    createTimer(session, container);

    // Real-time stats
    const statsDiv = document.createElement('div');
    statsDiv.className = 'session-stats';

    const pageLoads = session.events.filter(e => e.actionType === 'PAGE_LOAD').length;
    const tabSwitches = session.events.filter(e => e.actionType === 'TAB_SWITCH').length;
    const drifts = session.events.filter(e => e.actionType === 'OVERRIDE').length;

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

    // Pause/Resume button
    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'complete-btn';
    pauseBtn.textContent = session.isPaused ? 'Resume session' : 'Pause session';
    pauseBtn.addEventListener('click', () => {
      if (session.isPaused) {
        // Resume
        session.isPaused = false;
        session.pausedTime = (session.pausedTime || 0) + (Date.now() - session.pausedAt);
        delete session.pausedAt;
      } else {
        // Pause
        session.isPaused = true;
        session.pausedAt = Date.now();
      }
      chrome.storage.local.set({ activeSession: session }, () => {
        showActiveState(session);
      });
    });
    actions.appendChild(pauseBtn);

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
    const drifts = session.events.filter(e => e.actionType === 'OVERRIDE').length;
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
        session.intent = newIntent;
        intentTextElement.textContent = newIntent;
        chrome.storage.local.set({ activeSession: session });
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
        history.push({
          id: s.id,
          intent: s.intent,
          startTime: s.startTime,
          endTime: s.endTime,
          timeBudget: s.timeBudget,
          driftCount: s.events.filter(e => e.actionType === 'OVERRIDE').length,
          totalEvents: s.events.length,
          events: s.events
        });
        // Keep last 100 sessions
        if (history.length > 100) history.shift();

        chrome.storage.local.set({ activeSession: s, sessionHistory: history }, () => {
          chrome.runtime.sendMessage({ type: 'SESSION_CLEARED' }, () => {
            showSummary(container, s);
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

    const duration = Math.round((session.endTime - session.startTime) / 60000);
    const drifts = session.events.filter(e => e.actionType === 'OVERRIDE').length;
    const pageLoads = session.events.filter(e => e.actionType === 'PAGE_LOAD').length;

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
    const overrides = session.events.filter(e => e.actionType === 'OVERRIDE' && e.reflection);
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

    // Break prompt
    const breakSection = document.createElement('div');
    breakSection.className = 'break-section';

    const breakLabel = document.createElement('p');
    breakLabel.className = 'plan-heading';
    breakLabel.textContent = 'Take a break';
    breakSection.appendChild(breakLabel);

    const breakBtns = document.createElement('div');
    breakBtns.className = 'break-btns';

    const breakDurations = [
      { label: '3 min', minutes: 3 },
      { label: '5 min', minutes: 5 },
      { label: '10 min', minutes: 10 },
      { label: '15 min', minutes: 15 }
    ];

    breakDurations.forEach(dur => {
      const btn = document.createElement('button');
      btn.className = 'complete-btn break-duration-btn';
      btn.textContent = dur.label;
      btn.addEventListener('click', () => {
        const breakUntil = Date.now() + dur.minutes * 60000;
        chrome.storage.local.set({ breakUntil }, () => {
          showBreakState(breakUntil);
        });
      });
      breakBtns.appendChild(btn);
    });

    breakSection.appendChild(breakBtns);
    container.appendChild(breakSection);

    const skipBtn = document.createElement('button');
    skipBtn.className = 'complete-btn';
    skipBtn.textContent = 'Start new session';
    skipBtn.style.marginTop = '8px';
    skipBtn.addEventListener('click', () => showNewSessionForm(container));
    container.appendChild(skipBtn);
  }

  // ── Break state ─────────────────────────────────────────────────────

  function showBreakState(breakUntil) {
    if (timerInterval) clearInterval(timerInterval);
    const container = document.querySelector('.lock-container');
    container.textContent = '';

    const header = document.createElement('div');
    header.className = 'header';
    const h1 = document.createElement('h1');
    h1.textContent = 'Break';
    const p = document.createElement('p');
    p.textContent = 'Step away. Breathe. Come back sharper.';
    header.append(h1, p);
    container.appendChild(header);

    const countdownEl = document.createElement('div');
    countdownEl.className = 'break-countdown';
    container.appendChild(countdownEl);

    function tickBreak() {
      const remaining = breakUntil - Date.now();
      if (remaining <= 0) {
        clearInterval(timerInterval);
        chrome.storage.local.remove(['breakUntil'], () => {
          showNewSessionForm(container);
        });
        return;
      }
      countdownEl.textContent = formatTime(remaining);
    }

    tickBreak();
    timerInterval = setInterval(tickBreak, 1000);

    const skipBtn = document.createElement('button');
    skipBtn.className = 'complete-btn';
    skipBtn.textContent = 'Skip break';
    skipBtn.style.marginTop = '24px';
    skipBtn.addEventListener('click', () => {
      if (timerInterval) clearInterval(timerInterval);
      chrome.storage.local.remove(['breakUntil'], () => {
        showNewSessionForm(container);
      });
    });
    container.appendChild(skipBtn);
  }

  // ── Quick intents ───────────────────────────────────────────────────

  function loadQuickIntents() {
    chrome.storage.local.get(['quickIntents'], (result) => {
      const intents = result.quickIntents || [];
      if (intents.length === 0) return;

      const container = document.querySelector('.lock-container');
      const form = document.getElementById('intent-form');
      if (!form) return;

      const quickSection = document.createElement('div');
      quickSection.className = 'quick-intents';

      const quickLabel = document.createElement('p');
      quickLabel.className = 'plan-heading';
      quickLabel.textContent = 'Quick start';
      quickSection.appendChild(quickLabel);

      intents.forEach(qi => {
        const btn = document.createElement('button');
        btn.className = 'quick-intent-btn';
        btn.textContent = qi.intent.length > 50 ? qi.intent.slice(0, 50) + '...' : qi.intent;
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          document.getElementById('intent-input').value = qi.intent;
          if (qi.timeBudget) document.getElementById('time-budget').value = qi.timeBudget;
        });
        quickSection.appendChild(btn);
      });

      // Insert before the form
      container.insertBefore(quickSection, form);
    });
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

    // Check for API key
    chrome.storage.local.get(['openaiApiKey'], (result) => {
      if (!result.openaiApiKey) {
        const apiNotice = document.createElement('div');
        apiNotice.className = 'api-notice';
        const noticeText = document.createElement('p');
        noticeText.textContent = 'Add an OpenAI API key in Settings to enable AI-powered drift detection.';
        const noticeBtn = document.createElement('button');
        noticeBtn.className = 'complete-btn';
        noticeBtn.textContent = 'Open Settings';
        noticeBtn.addEventListener('click', () => {
          chrome.runtime.openOptionsPage();
        });
        apiNotice.append(noticeText, noticeBtn);
        container.appendChild(apiNotice);
      }
    });

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
    timeInput.type = 'number';
    timeInput.id = 'time-budget';
    timeInput.min = '1';
    timeInput.max = '480';
    timeInput.placeholder = '30';
    timeGroup.append(timeLabel, timeInput);

    // Tags
    const tagsGroup = document.createElement('div');
    tagsGroup.className = 'input-group';
    const tagsLabel = document.createElement('label');
    tagsLabel.textContent = 'Category (optional)';
    const tagsContainer = document.createElement('div');
    tagsContainer.className = 'tags-container';
    tagsContainer.id = 'tags-container';

    const categories = ['Work', 'Learning', 'Research', 'Creative', 'Admin', 'Personal'];
    categories.forEach(cat => {
      const tag = document.createElement('button');
      tag.type = 'button';
      tag.className = 'tag';
      tag.textContent = cat;
      tag.dataset.category = cat;
      tag.addEventListener('click', () => {
        // Toggle selection
        tagsContainer.querySelectorAll('.tag').forEach(t => t.classList.remove('selected'));
        tag.classList.add('selected');
      });
      tagsContainer.appendChild(tag);
    });

    tagsGroup.append(tagsLabel, tagsContainer);

    const btn = document.createElement('button');
    btn.type = 'submit';
    btn.id = 'start-btn';
    btn.textContent = 'Lock in';

    // Save as quick intent toggle
    const saveRow = document.createElement('div');
    saveRow.className = 'toggle-row';
    saveRow.style.marginTop = '16px';
    const saveCheck = document.createElement('input');
    saveCheck.type = 'checkbox';
    saveCheck.id = 'save-quick';
    const saveLabel = document.createElement('label');
    saveLabel.setAttribute('for', 'save-quick');
    saveLabel.textContent = 'Save as quick intent';
    saveRow.append(saveCheck, saveLabel);

    form.append(intentGroup, timeGroup, tagsGroup, btn, saveRow);
    container.appendChild(form);

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

    // Load quick intents
    chrome.storage.local.get(['quickIntents'], (result) => {
      const intents = result.quickIntents || [];
      if (intents.length > 0) {
        const quickSection = document.createElement('div');
        quickSection.className = 'quick-intents';
        const quickLabel = document.createElement('p');
        quickLabel.className = 'plan-heading';
        quickLabel.textContent = 'Quick start';
        quickSection.appendChild(quickLabel);

        intents.forEach(qi => {
          const qBtn = document.createElement('button');
          qBtn.className = 'quick-intent-btn';
          qBtn.type = 'button';
          qBtn.textContent = qi.intent.length > 50 ? qi.intent.slice(0, 50) + '...' : qi.intent;
          qBtn.addEventListener('click', (e) => {
            e.preventDefault();
            intentInput.value = qi.intent;
            if (qi.timeBudget) timeInput.value = qi.timeBudget;
            // Select category if saved
            if (qi.category) {
              tagsContainer.querySelectorAll('.tag').forEach(t => {
                if (t.dataset.category === qi.category) {
                  t.classList.add('selected');
                } else {
                  t.classList.remove('selected');
                }
              });
            }
          });
          quickSection.appendChild(qBtn);
        });

        container.insertBefore(quickSection, form);
      }
    });

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
      const saveQuick = document.getElementById('save-quick');
      const intent = intentInput.value.trim();
      const timeBudget = parseInt(timeBudgetInput.value, 10);

      // Get selected category
      const selectedTag = document.querySelector('.tag.selected');
      const category = selectedTag ? selectedTag.dataset.category : null;

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

      startBtn.disabled = true;
      startBtn.textContent = 'Generating plan...';

      // Save as quick intent if checked
      if (saveQuick && saveQuick.checked) {
        chrome.storage.local.get(['quickIntents'], (result) => {
          const intents = result.quickIntents || [];
          // Avoid duplicates
          if (!intents.some(qi => qi.intent === intent)) {
            intents.push({ 
              intent, 
              timeBudget: isNaN(timeBudget) ? null : timeBudget,
              category: category
            });
            // Keep max 10
            if (intents.length > 10) intents.shift();
            chrome.storage.local.set({ quickIntents: intents });
          }
        });
      }

      const sessionData = {
        id: crypto.randomUUID(),
        intent: intent,
        startTime: Date.now(),
        timeBudget: isNaN(timeBudget) ? null : timeBudget,
        isActive: true,
        events: [],
        plan: [],
        category: category,
        isPaused: false,
        pausedTime: 0
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
