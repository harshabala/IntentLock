import { captureStorageEpoch, mutateStorage } from './storage-client.js';
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
    nextBtn.addEventListener('click', showStep2);
    container.appendChild(nextBtn);
  }

  function showStep2() {
    container.textContent = '';

    const header = document.createElement('div');
    header.className = 'header onboarding-header';
    const h1 = document.createElement('h1');
    h1.textContent = 'How hard should the lock be?';
    const desc = document.createElement('p');
    desc.textContent = 'Works on this device with no account. You can add optional AI later in Settings.';
    header.append(h1, desc);
    container.appendChild(header);

    // Intent category selector
    const categoryGroup = document.createElement('div');
    categoryGroup.className = 'input-group onboarding-input-group';
    const categoryLabel = document.createElement('label');
    categoryLabel.setAttribute('for', 'onboarding-category');
    categoryLabel.textContent = 'What kind of work is this usually?';
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
    strictnessLabel.textContent = 'How often should it lock?';
    const strictnessSelect = document.createElement('select');
    strictnessSelect.id='onboarding-strictness';
    [
      { value: 'relaxed', text: 'Relaxed — only lock short video' },
      { value: 'balanced', text: 'Balanced — lock social, short video, streaming' },
      { value: 'strict', text: 'Strict — lock social, video, gaming, forums' },
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
    saveBtn.textContent = 'Save and continue';
    saveBtn.addEventListener('click', () => {
      const epoch = captureStorageEpoch();
      epoch.catch(() => {});
      const policy = buildDefaultPolicy(categorySelect.value, strictnessSelect.value);
      policy.setupCompleted = true;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      if (isDeletionInProgress()) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save and continue';
        return;
      }
      mutateStorage('onboarding', { category: categorySelect.value, strictness: strictnessSelect.value }, epoch).then(() => {
        chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' }, () => { void chrome.runtime.lastError; });
        showLockRehearsal();
      }, error => {
        statusEl.textContent = error.message;
        statusEl.classList.remove('hidden');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save and continue';
      });
    });

    actionsRow.append(saveBtn);
    container.appendChild(actionsRow);
    categorySelect.focus();
  }

  function showLockRehearsal() {
    container.textContent = '';

    const header = document.createElement('div');
    header.className = 'header onboarding-header';
    const h1 = document.createElement('h1');
    h1.textContent = 'This is the lock.';
    const desc = document.createElement('p');
    desc.textContent = 'When you drift, the page looks like this. Write why to continue, or leave.';
    header.append(h1, desc);
    container.appendChild(header);

    const card = document.createElement('div');
    card.className = 'lock-rehearsal rehearsal-lock';

    const lockHeading = document.createElement('h1');
    lockHeading.textContent = 'You are drifting from your intent.';
    card.appendChild(lockHeading);

    const actions = document.createElement('div');
    actions.className = 'lock-rehearsal-actions';

    const gotIt = document.createElement('button');
    gotIt.type = 'button';
    gotIt.className = 'primary-btn btn--primary';
    gotIt.textContent = 'Got it';
    gotIt.addEventListener('click', () => showNewSessionForm(container));

    const continueBtn = document.createElement('button');
    continueBtn.type = 'button';
    continueBtn.className = 'override-btn btn--ghost';
    continueBtn.textContent = 'Continue anyway';
    continueBtn.disabled = true;

    actions.append(gotIt, continueBtn);
    card.appendChild(actions);
    container.appendChild(card);
    gotIt.focus();
  }

  showStep1();
}
