import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('manifest version is 1.6.0', async () => {
  const manifest = JSON.parse(await text('manifest.json'));
  assert.equal(manifest.version, '1.6.0');
});

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
    'onboarding.js',
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

test('onboarding wizard lives in onboarding.js', async () => {
  const code = await text('onboarding.js');
  assert.match(code, /export function showOnboardingWizard/);
  const newtab = await text('newtab.js');
  assert.match(newtab, /from '\.\/onboarding\.js'/);
  assert.equal(newtab.includes('function showOnboardingWizard'), false);
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

test('tracking-disabled paths guard content and background work', async () => {
  const content = await text('content.js');
  const background = await text('background.js');
  const providers = await text('providers.js');
  assert.match(content, /trackingEnabled/);
  assert.match(background, /trackingEnabled.*?false/s);
  assert.match(providers, /tracking_disabled/);
});

test('newtab.js enforces maxLength on dynamically created textareas', async () => {
  const code = await text('newtab.js');

  // Verify edit intent textarea has maxLength set
  assert.ok(code.includes('.maxLength = 250') || code.includes('.maxLength=250'), 'edit intent textarea should set maxLength');

  // Verify dynamic intentInput in showNewSessionForm has maxLength set
  assert.match(code, /intentInput\.maxLength\s*=\s*\d+/);
});

test('declare form is intent plus optional minutes', async () => {
  const code = await text('newtab.js');
  assert.match(code, /Lock in/);
  assert.match(code, /Enter your task/);
  assert.equal(code.includes('Generating plan...'), false);
  assert.equal(code.includes('Complete session'), false);
  assert.match(code, /End session/);
  const start = code.indexOf('function showNewSessionForm');
  assert.ok(start >= 0, 'showNewSessionForm must exist');
  const rest = code.slice(start + 'function showNewSessionForm'.length);
  const nextFn = rest.search(/\n  function /);
  const formFn = nextFn === -1 ? code.slice(start) : code.slice(start, start + 'function showNewSessionForm'.length + nextFn);
  assert.ok(formFn.length > 50, 'showNewSessionForm body must be extracted');
  assert.match(formFn, /Lock in/);
  assert.equal(formFn.includes('intent-preset'), false);
  assert.equal(formFn.includes('session-strictness'), false);
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

test('repository includes an MIT LICENSE with the project copyright holder', async () => {
  const license = await text('LICENSE');
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) 2026 Harsha Balakrishnan/);
  assert.match(license, /Permission is hereby granted, free of charge/);
});

test('onboarding wizard does not collect an API key', async () => {
  const wizard = await text('onboarding.js');
  assert.equal(wizard.includes('api-key-input'), false);
  assert.equal(wizard.includes('CHOOSE YOUR DETECTION MODE'), false);
  assert.equal(wizard.includes('provider-select'), false);
  assert.match(wizard, /Welcome to IntentLock/);
  assert.match(wizard, /Set your default policy/);
  assert.match(wizard, /Add an AI provider later in Settings/);
  assert.match(wizard, /id=['"]onboarding-category['"]/);
  assert.match(wizard, /id=['"]onboarding-strictness['"]/);
  assert.equal(/\bSKIP\b/.test(wizard), false);
});

test('LLM provider fields remain on the options page', async () => {
  const html = await text('options.html');
  assert.match(html, /id=["']provider-select["']/);
  assert.match(html, /id=["']api-key-group["']/);
});

test('README tells a novice how to install from a release zip', async () => {
  const readme = await text('README.md');
  assert.match(readme, /Releases/);
  assert.match(readme, /Load unpacked/);
  assert.match(readme, /MIT/);
  assert.match(readme, /docs\/privacy-policy\.md/);
  assert.match(readme, /Settings/);
  assert.equal(readme.includes('**2 — LLM setup**'), false);
});

test('privacy site page exists for Chrome Web Store hosting', async () => {
  const html = await text('docs/site/privacy.html');
  assert.match(html, /<h1[^>]*>Privacy Policy<\/h1>/);
  assert.match(html, /chrome.storage/);
  assert.match(html, /Ollama/);
  assert.match(html, /does not operate an intermediary/);
  const workflow = await text('.github/workflows/pages.yml');
  assert.match(workflow, /peaceiris\/actions-gh-pages@v4/);
  assert.match(workflow, /docs\/site/);
});

test('store listing pack has CWS fields and a five-shot plan', async () => {
  const listing = await text('store/LISTING.md');
  assert.ok(listing.split('## Short description')[1].trim().split('\n')[0].length <= 132);
  assert.match(listing, /https:\/\/harshabala\.github\.io\/IntentLock\/privacy\.html/);
  assert.match(listing, /Load unpacked/);
  const shots = await text('store/screenshots/README.md');
  assert.match(shots, /1280x800/);
  assert.match(shots, /new tab intent form/);
  assert.match(shots, /intervention/);
  assert.match(shots, /settings/);
});

test('overlay copy uses sentence-case lock language', async () => {
  const js = await text('intervention-overlay.js');
  const html = await text('intervention.html');
  for (const src of [js, html]) {
    assert.match(src, /Close this tab/);
    assert.match(src, /Continue anyway/);
    assert.match(src, /End session/);
    assert.equal(src.includes('Override & continue'), false);
    assert.equal(/text-transform:\s*uppercase/.test(src), false);
  }
  assert.match(js, /overlayEnter|scale\(0\.98\)/);
});

test('visualized value tokens and no glass kit', async () => {
  const css = await text('newtab.css') + '\n' + await text('intervention.css');
  assert.match(css, /--bg-white:\s*#ffffff/);
  assert.match(css, /--fg-black:\s*#000000/);
  assert.match(css, /--corner-radius:\s*2px/);
  assert.match(css, /IBM Plex Mono/);
  assert.match(css, /Source Serif 4/);
  assert.equal(/backdrop-filter/.test(css), false);
  assert.equal(/linear-gradient/.test(css), false);
  assert.equal(/pulseRing|subtlePulse|intentSpin/.test(css), false);
  assert.equal(/animation:[^;}]*\binfinite\b/.test(css), false);
  assert.equal(/text-transform:\s*uppercase/.test(css), false);
  assert.equal(/transition:\s*all/.test(css), false);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /\.tracking-toggle-hit\s*\{[^}]*min-width:\s*44px/s);
});
