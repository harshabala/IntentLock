import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('manifest references only present extension assets and minimum V1 permissions', async () => {
  const manifest = JSON.parse(await text('manifest.json'));

  for (const iconPath of Object.values(manifest.icons || {})) {
    await assert.doesNotReject(
      access(new URL(iconPath, root), constants.R_OK),
      `missing icon asset: ${iconPath}`,
    );
  }

  assert.deepEqual(
    manifest.permissions,
    ['tabs', 'storage', 'idle', 'tabGroups', 'alarms'],
  );

  assert.deepEqual(
    [...manifest.host_permissions].sort(),
    ['http://*/*', 'https://*/*'],
  );

  assert.deepEqual(
    [...manifest.content_scripts[0].matches].sort(),
    ['http://*/*', 'https://*/*'],
  );

  assert.deepEqual(
    manifest.content_scripts[0].js,
    ['page-tracker.js', 'intervention-overlay.js', 'content.js'],
  );
  assert.equal('type' in manifest.content_scripts[0], false);
});

test('all extension javascript files parse', async () => {
  for (const file of [
    'background.js',
    'content.js',
    'page-tracker.js',
    'intervention-overlay.js',
    'drift.js',
    'history.js',
    'intervention.js',
    'llm.js',
    'providers.js',
    'error-log.js',
    'diagnostics.js',
    'newtab.js',
    'options.js',
    'popup.js',
    'storage-queue.js',
  ]) {
    const result = spawnSync(process.execPath, ['--check', file], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${file} failed to parse:\n${result.stderr}`);
  }
});

test('V1 UI avoids non-goal habit tracking and analytics surfaces', async () => {
  const files = {
    'history.html': await text('history.html'),
    'history.js': await text('history.js'),
    'newtab.js': await text('newtab.js'),
    'options.html': await text('options.html'),
    'options.js': await text('options.js'),
  };
  // diagnostics.* intentionally excluded — uses "category" for error log typing

  const combined = Object.values(files).join('\n').toLowerCase();
  for (const forbidden of [
    'goals',
    'favorite',
    'patterns',
    'quick start',
    'build better browsing habits',
  ]) {
    assert.equal(combined.includes(forbidden), false, `found out-of-scope copy: ${forbidden}`);
  }
});

test('newtab.js contains showOnboardingWizard function', async () => {
  const code = await text('newtab.js');
  assert.match(code, /function\s+showOnboardingWizard/);
});

test('newtab.html contains intent-input textarea with maxlength attribute', async () => {
  const html = await text('newtab.html');
  const match = html.match(/<textarea[^>]*id=["']intent-input["'][^>]*maxlength=["'](\d+)["']/i) ||
                html.match(/<textarea[^>]*maxlength=["'](\d+)["'][^>]*id=["']intent-input["']/i);
  assert.ok(match, 'textarea with id="intent-input" must have a maxlength attribute');
  const limit = parseInt(match[1], 10);
  assert.ok(!isNaN(limit) && limit > 0, `maxlength limit should be a valid positive integer, got ${limit}`);
});

test('options tracking toggle meets 44px minimum touch target', async () => {
  const css = await text('newtab.css');
  const html = await text('options.html');

  assert.match(html, /class=["']tracking-toggle-hit["']/);
  assert.match(html, /id=["']tracking-toggle["']/);

  const hitTargetBlock = css.match(/\.tracking-toggle-hit\s*\{([^}]+)\}/);
  assert.ok(hitTargetBlock, 'tracking-toggle-hit styles required');
  assert.match(hitTargetBlock[1], /min-width:\s*44px/);
  assert.match(hitTargetBlock[1], /min-height:\s*44px/);
});

test('diagnostics page exposes copyable error log UI', async () => {
  const html = await text('diagnostics.html');
  assert.match(html, /id=["']copy-log-btn["']/);
  assert.match(html, /id=["']error-log-list["']/);
  assert.match(html, /diagnostics\.js/);
});

test('diagnostics deletion lifecycle preserves the generation and handles failures', async () => {
  const diagnostics = await text('diagnostics.js');

  assert.match(diagnostics, /DATA_DELETION_STARTED[\s\S]*beginStorageDeletion\(message\.generation\)/);
  assert.match(diagnostics, /DATA_DELETED[\s\S]*endStorageDeletion\(message\.generation\)/);
  assert.match(diagnostics, /DATA_DELETION_FAILED[\s\S]*endStorageDeletion\(message\.generation\)/);
});

test('provider-save failures surface and restore UI controls', async () => {
  const options = await text('options.js');
  const newtab = await text('newtab.js');
  const optionsProviderSave = options.slice(
    options.indexOf("saveProviderBtn.addEventListener('click'")
  );
  const heuristicsSave = newtab.slice(
    newtab.indexOf('if (heuristicsInput.checked)'),
    newtab.indexOf('const providerId =', newtab.indexOf('if (heuristicsInput.checked)')),
  );
  const providerSave = newtab.slice(newtab.indexOf('const saveProvider ='));

  assert.match(optionsProviderSave, /saveProviderBtn\.disabled\s*=\s*true/);
  assert.match(options, /function\s+showProviderStorageError/);
  assert.match(optionsProviderSave, /if \(!savedConfig\) \{[\s\S]*failProviderSave\(/);
  assert.match(optionsProviderSave, /if \(!savedKey\) \{[\s\S]*failProviderSave\(/);
  assert.match(optionsProviderSave, /saveProviderBtn\.disabled\s*=\s*false/);
  assert.match(heuristicsSave, /if \(!saved\) \{[\s\S]*failOnboardingStorage\(/);
  assert.match(heuristicsSave, /if \(!cleared\) \{[\s\S]*failOnboardingStorage\(/);
  assert.match(providerSave, /if \(!saved\) \{[\s\S]*failSetup\(/);
  assert.match(providerSave, /if \(!cleared\) \{[\s\S]*failSetup\(/);
  assert.match(newtab, /resetContinueButton\(\)/);
});

test('options.html includes privacy note and diagnostics access', async () => {
  const html = await text('options.html');
  assert.match(html, /privacy-note/);
  assert.match(html, /id=["']open-diagnostics-btn["']/);
});

test('options.html exposes multi-provider LLM settings', async () => {
  const html = await text('options.html');
  assert.match(html, /id=["']provider-select["']/);
  assert.match(html, /id=["']model-input["']/);
  assert.match(html, /id=["']base-url-input["']/);
  assert.match(html, /id=["']custom-provider-fields["']/);
});

test('options page uses progressive disclosure for cloud LLM settings', async () => {
  const html = await text('options.html');
  const js = await text('options.js');
  const css = await text('newtab.css');

  assert.match(html, /id=["']provider-advanced-disclosure["']/);
  assert.match(html, /id=["']provider-advanced-toggle["']/);
  assert.match(html, /id=["']provider-model-fields["']/);
  assert.match(html, /aria-controls=["']provider-model-fields["']/);
  assert.match(html, /aria-expanded=["']false["']/);

  const providerIdx = html.indexOf('id="provider-select"');
  const apiKeyIdx = html.indexOf('id="api-key-group"');
  const advancedIdx = html.indexOf('id="provider-advanced-disclosure"');
  const modelFieldsIdx = html.indexOf('id="provider-model-fields"');
  assert.ok(providerIdx < apiKeyIdx, 'provider select should precede API key for cloud defaults');
  assert.ok(apiKeyIdx < advancedIdx, 'API key should precede advanced disclosure');
  assert.ok(advancedIdx < modelFieldsIdx, 'advanced toggle should precede model fields');

  assert.match(js, /function\s+isCloudProvider/);
  assert.match(js, /providerAdvancedOpen/);
  assert.match(js, /providerAdvancedDisclosure\.classList\.toggle\(\s*['"]hidden['"],\s*!cloudProvider\)/);

  assert.match(css, /\.disclosure-toggle/);
  assert.match(css, /aria-expanded/);
});

test('delete-all-data flow does not recreate provider configuration', async () => {
  const options = await text('options.js');
  const background = await text('background.js');
  assert.match(options, /type:\s*['"]DELETE_ALL_DATA['"]/);
  assert.match(background, /function\s+storageClear/);
  assert.match(background, /beginStorageDeletion/);
  assert.match(options, /All data deleted/);
  assert.doesNotMatch(background, /if \(!localRes\?\.llmProviderConfig\)\s*\{[\s\S]*llmProviderConfig:/);
});

test('privacy boundary disclosures and key handling match runtime behavior', async () => {
  const options = await text('options.js');
  const providers = await text('providers.js');
  const newtab = await text('newtab.js');
  const html = await text('options.html');

  assert.doesNotMatch(providers, /localRes\?\.llmApiKey|localRes\?\.openaiApiKey/);
  assert.doesNotMatch(options, /chrome\.storage\.local\.set\(\{\s*llmApiKey/);
  assert.doesNotMatch(newtab, /chrome\.storage\.local\.set\(\{\s*llmApiKey/);
  assert.match(options, /verbatim declared intent/i);
  assert.match(options, /query-auth/i);
  assert.match(html, /downloaded exports|clipboard/i);
});

test('tracking-disabled paths guard content and background work', async () => {
  const content = await text('content.js');
  const background = await text('background.js');
  const providers = await text('providers.js');
  assert.match(content, /trackingEnabled/);
  assert.match(background, /trackingEnabled.*?false/s);
  assert.match(providers, /tracking_disabled/);
});

test('session lifecycle callers require confirmed background success', async () => {
  const background = await text('background.js');
  const newtab = await text('newtab.js');
  const popup = await text('popup.js');

  assert.match(background, /UPDATE_SESSION_INTENT/);
  assert.match(background, /trackingEnabled.*?false/s);
  assert.match(newtab, /type:\s*['"]UPDATE_SESSION_INTENT['"]/);
  assert.match(newtab, /response\?\.status\s*!==\s*['"]ok['"]\s*\|\|\s*!response\?\.session/);
  assert.match(popup, /response\?\.status\s*!==\s*['"]ok['"]\s*\|\|\s*!response\?\.session/);
});

test('lifecycle cleanup writes remain serialized through the session queue', async () => {
  const background = await text('background.js');

  assert.match(background, /function ungroupTabs\(\)[\s\S]*?enqueueSessionMutation/);
  assert.doesNotMatch(background, /chrome\.storage\.local\.remove\(['"]sessionTabGroupId['"]\)/);
  assert.doesNotMatch(background, /chrome\.storage\.local\.set\(\{\s*lastIdleTime:\s*0/);
  assert.doesNotMatch(background, /chrome\.storage\.local\.set\(\{\s*overrideCooldowns:/);
});

test('ended-session cleanup failures still show the completed report with a warning', async () => {
  const newtab = await text('newtab.js');
  const popup = await text('popup.js');

  assert.match(newtab, /showSummary\(\s*container,\s*response\.session,[\s\S]*?cleanup/);
  assert.match(newtab, /cleanupWarning/);
  assert.match(newtab, /response\.session\.cleanupWarning/);
  assert.match(popup, /report=last&cleanup=warning/);
  assert.match(popup, /response\.session\.cleanupWarning/);
  assert.doesNotMatch(newtab, /showEndSessionFailure\(container,\s*response\.session,[\s\S]*?clearResponse/);
  assert.doesNotMatch(popup, /showEndSessionFailure\(clearResponse/);
});

test('message session mutations preserve their request generation', async () => {
  const background = await text('background.js');

  assert.match(background, /handleSessionStart\(message\.session,\s*requestGeneration\)/);
  assert.match(background, /updateSessionIntent\(message\.intent,\s*message\.sessionId,\s*requestGeneration\)/);
  assert.match(background, /handleOverride\(message\.sessionData,\s*requestGeneration\)/);
  assert.match(background, /handleInterventionTransition\(message,\s*sender,\s*requestGeneration\)/);
  assert.match(background, /handleContentEvent\(message\.payload,\s*sender\.tab\?\.id,\s*requestGeneration\)/);
  assert.match(background, /endActiveSession\(\s*message\.reflection,\s*null,\s*message\.sessionId \|\| null,\s*requestGeneration,?\s*\)/);
});

test('config rejection resets its cache and event callers handle reload failures', async () => {
  const background = await text('background.js');

  assert.match(background, /configPromise[\s\S]*?catch\([\s\S]*?configPromise\s*=\s*null/);
  assert.match(background, /loadConfig\(\)\.catch\(/);
  assert.match(background, /chrome\.alarms\.onAlarm[\s\S]*?loadConfig\(\)\.then[\s\S]*?\.catch\(/);
  assert.match(background, /chrome\.tabs\.onUpdated[\s\S]*?loadConfig\(\)\.then[\s\S]*?\.catch\(/);
  assert.match(background, /chrome\.tabs\.onActivated[\s\S]*?loadConfig\(\)\.then[\s\S]*?\.catch\(/);
});

test('tracking and intervention paths accept only web URLs', async () => {
  const background = await text('background.js');
  const intervention = await text('intervention.js');

  assert.match(background, /new URL\(url\)[\s\S]*?protocol\s*===\s*['"]http:['"][\s\S]*?protocol\s*===\s*['"]https:['"]/);
  assert.match(background, /payload\.url[\s\S]*?isTrackableUrl/);
  assert.match(intervention, /isTrackableUrl\(interventionState\.originalUrl\)/);
});

test('content storage changes re-check tracking before restarting', async () => {
  const content = await text('content.js');

  assert.match(content, /changes\.activeSession[\s\S]*?syncSessionState\(\)/);
  assert.match(content, /newValue\s*===\s*false[\s\S]*?pendingIntervention\s*=\s*null;\s*return;/);
  assert.doesNotMatch(content, /else if \(changes\.activeSession\?\.newValue\?\.isActive[\s\S]*?startTracking\(\)/);
});

test('rehydrated intervention state carries intent and fallback dismissal is idempotent', async () => {
  const background = await text('background.js');
  const intervention = await text('intervention.js');

  assert.match(background, /intent:\s*session\.intent/);
  assert.match(background, /state\.intent\s*\?\?/);
  assert.match(intervention, /dismissalPromise/);
});

test('newtab.js enforces maxLength on dynamically created textareas', async () => {
  const code = await text('newtab.js');

  // Verify edit intent textarea has maxLength set
  assert.ok(code.includes('.maxLength = 250') || code.includes('.maxLength=250'), 'edit intent textarea should set maxLength');

  // Verify dynamic intentInput in showNewSessionForm has maxLength set
  assert.match(code, /intentInput\.maxLength\s*=\s*\d+/);
});

test('newtab.js modal dialogs use shared a11y helper with focus trap', async () => {
  const code = await text('newtab.js');

  assert.match(code, /function\s+setupModalDialog/);
  assert.match(code, /setAttribute\(['"]role['"],\s*['"]dialog['"]\)/);
  assert.match(code, /setAttribute\(['"]aria-modal['"],\s*['"]true['"]\)/);
  assert.match(code, /setAttribute\(['"]aria-labelledby['"],\s*headingId\)/);
  assert.match(code, /e\.key\s*===\s*['"]Escape['"]/);
  assert.match(code, /e\.key\s*!==\s*['"]Tab['"]/);
  assert.match(code, /setupModalDialog\(\{[^}]*overlay[^}]*dialog[^}]*heading[^}]*trigger/);
  assert.match(code, /showConfirmEndDialog\(container,\s*session,\s*e\.currentTarget\)/);
  assert.match(code, /showShortcutsModal\(e\.currentTarget\)/);
});

test('shortcuts button exposes accessible label without innerHTML', async () => {
  const code = await text('newtab.js');

  assert.match(code, /shortcutsBtn\.setAttribute\(['"]aria-label['"],\s*['"]Keyboard shortcuts['"]\)/);
  assert.match(code, /shortcutsBtn\.textContent\s*=\s*['"]\?['"]/);
  assert.equal(code.includes('shortcutsBtn.innerHTML'), false);
});

test('live numeric displays use tabular-nums for stable alignment', async () => {
  const css = await text('newtab.css');

  for (const selector of [
    '.time-remaining',
    '.timer-value',
    '.stat-value',
    '.stat-box .stat-value',
  ]) {
    const escaped = selector.replace(/\./g, '\\.');
    const block = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 's'));
    assert.ok(block, `${selector} styles required`);
    assert.match(block[1], /font-variant-numeric:\s*tabular-nums/);
  }
});

test('custom query-auth disclosure and authoritative storage routing are explicit', async () => {
  const [optionsSource, backgroundSource, newtabSource, storageQueueSource, privacyPolicy, schema, development] = await Promise.all([
    text('options.js'),
    text('background.js'),
    text('newtab.js'),
    text('storage-queue.js'),
    text('docs/privacy-policy.md'),
    text('docs/storage-schema.md'),
    text('docs/development.md'),
  ]);

  assert.match(optionsSource, /getEffectiveAuthType\(providerId,\s*formConfig\)\s*===\s*['"]query['"]/);
  assert.doesNotMatch(backgroundSource, /chrome\.storage\.local\.(set|remove)\s*\(/);
  assert.doesNotMatch(backgroundSource, /chrome\.storage\.session\.(set|remove|clear)\s*\(/);
  assert.doesNotMatch(privacyPolicy, /local-storage fallback/i);
  assert.match(privacyPolicy, /memory-only|must be re-entered/i);
  assert.match(newtabSource, /query authentication|API key.*URL|request URL/i);
  assert.match(storageQueueSource, /runtime\.sendMessage/);
  assert.match(backgroundSource, /STORAGE_MUTATION/);
  assert.doesNotMatch(schema, /local.*llmApiKey.*fallback|local `llmApiKey` fallback/i);
  assert.doesNotMatch(development, /local `llmApiKey` fallback/i);
});
