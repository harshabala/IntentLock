import {
  INTENT_CATEGORIES,
  buildDefaultPolicy,
} from './heuristic-policy.js';

export function showOnboardingWizard(container, { showNewSessionForm, isDeletionInProgress }) {
  function showStep1() {
    container.textContent = '';

    const header = document.createElement('div');
    header.className = 'header onboarding-header';

    const h1 = document.createElement('h1');
    h1.textContent = 'Declare your intent.';

    const desc = document.createElement('p');
    desc.textContent = 'Declare an intent before you browse. If you drift, IntentLock locks the page until you reflect or leave.';

    header.append(h1, desc);
    container.appendChild(header);

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'primary-btn onboarding-btn';
    nextBtn.textContent = 'Continue';
    nextBtn.addEventListener('click', showStep3);
    container.appendChild(nextBtn);
  }

  function showStep3() {
    container.textContent = '';

    const header = document.createElement('div');
    header.className = 'header onboarding-header';
    const h1 = document.createElement('h1');
    h1.textContent = 'Set your default policy';
    const desc = document.createElement('p');
    desc.textContent = 'Heuristics work with no API key. Add an AI provider later in Settings.';
    header.append(h1, desc);
    container.appendChild(header);

    // Intent category selector
    const categoryGroup = document.createElement('div');
    categoryGroup.className = 'input-group onboarding-input-group';
    const categoryLabel = document.createElement('label');
    categoryLabel.setAttribute('for', 'onboarding-category');
    categoryLabel.textContent = 'Default intent type';
    const categorySelect = document.createElement('select');
    categorySelect.id='onboarding-category';
    INTENT_CATEGORIES.forEach(cat => {
      const option = document.createElement('option');
      option.value = cat.id;
      option.textContent = cat.label;
      if (cat.id === 'deep_work') option.selected = true;
      categorySelect.appendChild(option);
    });
    categoryGroup.append(categoryLabel, categorySelect);
    container.appendChild(categoryGroup);

    // Strictness selector
    const strictnessGroup = document.createElement('div');
    strictnessGroup.className = 'input-group onboarding-input-group';
    const strictnessLabel = document.createElement('label');
    strictnessLabel.setAttribute('for', 'onboarding-strictness');
    strictnessLabel.textContent = 'Strictness';
    const strictnessSelect = document.createElement('select');
    strictnessSelect.id='onboarding-strictness';
    [
      { value: 'relaxed', text: 'Relaxed — only block short video' },
      { value: 'balanced', text: 'Balanced — block social, short video, streaming' },
      { value: 'strict', text: 'Strict — block social, video, gaming, forums' },
    ].forEach(({ value, text }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      if (value === 'balanced') option.selected = true;
      strictnessSelect.appendChild(option);
    });
    strictnessGroup.append(strictnessLabel, strictnessSelect);
    container.appendChild(strictnessGroup);

    const statusEl = document.createElement('p');
    statusEl.className = 'onboarding-status hidden';
    statusEl.setAttribute('role', 'alert');
    statusEl.setAttribute('aria-live', 'polite');
    container.appendChild(statusEl);

    const actionsRow = document.createElement('div');
    actionsRow.className = 'onboarding-actions';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'primary-btn onboarding-lock-btn';
    saveBtn.textContent = 'Save policy';
    saveBtn.addEventListener('click', () => {
      const policy = buildDefaultPolicy(categorySelect.value, strictnessSelect.value);
      policy.setupCompleted = true;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      if (isDeletionInProgress()) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save policy';
        return;
      }
      chrome.storage.local.set({ heuristicPolicy: policy, hasSeenOnboarding: true }, () => {
        if (isDeletionInProgress()) return;
        if (chrome.runtime.lastError) {
          statusEl.textContent = 'Could not save policy. You can set this later in Settings.';
          statusEl.classList.remove('hidden');
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save policy';
          return;
        }
        chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' }, () => {
          void chrome.runtime.lastError;
        });
        showNewSessionForm(container);
      });
    });

    actionsRow.append(saveBtn);
    container.appendChild(actionsRow);
    categorySelect.focus();
  }

  showStep1();
}
