import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {
  INTENT_CATEGORIES,
  buildDefaultPolicy,
} from '../heuristic-policy.js';
import { createClassicContext } from './helpers/load-classic-script.mjs';
import { createOverlayDocument } from './helpers/overlay-dom.mjs';

function buttonByText(root, text) {
  return root.querySelectorAll('button').find((el) => el.textContent === text) || null;
}

async function loadOnboardingWizard(globals) {
  let code = await readFile(new URL('../onboarding.js', import.meta.url), 'utf8');
  code = code.replace(/import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/heuristic-policy\.js['"]\s*;\s*/, '');
  code = code.replace(/export\s+function\s+showOnboardingWizard/, 'function showOnboardingWizard');
  const context = createClassicContext({
    INTENT_CATEGORIES,
    buildDefaultPolicy,
    ...globals,
  });
  vm.runInContext(code, context, { filename: 'onboarding.js' });
  return context;
}

test('onboarding Continue then Save shows lock rehearsal, Got it opens the session form', async () => {
  const { document } = createOverlayDocument();
  let stored = null;
  const chrome = {
    storage: {
      local: {
        set(items, callback) {
          stored = items;
          callback();
        },
      },
    },
    runtime: {
      lastError: undefined,
      sendMessage(_msg, callback) {
        if (callback) callback();
      },
    },
  };

  const { showOnboardingWizard } = await loadOnboardingWizard({ document, chrome });
  assert.equal(typeof showOnboardingWizard, 'function');

  const container = document.createElement('div');
  document.body.appendChild(container);

  let showNewSessionFormCalls = 0;
  const showNewSessionForm = (el) => {
    showNewSessionFormCalls += 1;
    el.textContent = '';
    const input = document.createElement('textarea');
    input.id = 'intent-input';
    el.appendChild(input);
  };

  showOnboardingWizard(container, {
    showNewSessionForm,
    isDeletionInProgress: () => false,
  });

  const continueBtn = buttonByText(container, 'Continue');
  assert.ok(continueBtn, 'step 1 Continue must exist');
  continueBtn.click();

  const saveBtn = buttonByText(container, 'Save and continue');
  assert.ok(saveBtn, 'step 2 Save and continue must exist');
  saveBtn.click();

  assert.equal(stored?.hasSeenOnboarding, true);
  const rehearsalHeading = container.querySelectorAll('h1').find((el) => el.textContent === 'This is the lock.');
  assert.ok(rehearsalHeading, 'rehearsal heading This is the lock. must render');

  const gotIt = buttonByText(container, 'Got it');
  assert.ok(gotIt, 'Got it must exist');
  gotIt.click();

  assert.equal(showNewSessionFormCalls, 1);
  assert.ok(container.querySelector('#intent-input'), 'intent-input must appear after Got it');
});
