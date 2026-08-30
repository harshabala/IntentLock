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

test('popup is a compact summary and analytics.html is a week dashboard', async () => {
  await assert.doesNotReject(
    access(new URL('analytics.html', root), constants.R_OK),
    'analytics.html must exist',
  );
  await assert.doesNotReject(
    access(new URL('analytics.js', root), constants.R_OK),
    'analytics.js must exist',
  );

  const popupHtml = await text('popup.html');
  const popupJs = await text('popup.js');
  const analyticsHtml = await text('analytics.html');
  const analyticsJs = await text('analytics.js');
  const packager = await text('scripts/package-release.mjs');
  const css = await text('newtab.css');

  assert.match(popupHtml, /class=["']popup["']/);
  assert.match(popupJs, /End session/);
  assert.match(popupJs, /View stats/);
  assert.match(popupJs, /chrome\.runtime\.getURL\(['"]analytics\.html['"]\)/);
  assert.doesNotMatch(popupJs, /week-glance|summarizeWeek|formatWeekExport|Diagnostics/);
  const popupBlock = css.match(/body\.popup\s*\{([^}]+)\}/);
  assert.ok(popupBlock, 'body.popup width styles required');
  assert.match(popupBlock[1], /width:\s*300px/);

  assert.match(analyticsHtml, /newtab\.css/);
  assert.match(analyticsHtml, /analytics\.js/);
  assert.match(analyticsHtml, /history\.html/);
  assert.match(analyticsJs, /summarizeWeek/);
  assert.doesNotMatch(analyticsJs, /Best day/);

  assert.match(packager, /'analytics\.html'/);
  assert.match(packager, /'analytics\.js'/);
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
    'analytics.js',
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
  assert.match(wizard, /Declare your intent/);
  assert.match(wizard, /Set your default policy/);
  assert.match(wizard, /Add an AI provider later in Settings/);
  assert.match(wizard, /id=['"]onboarding-category['"]/);
  assert.match(wizard, /id=['"]onboarding-strictness['"]/);
  assert.equal(/\bSKIP\b/.test(wizard), false);
});

test('lock copy avoids welcome and on-track coaching', async () => {
  const sources = [
    await text('onboarding.js'),
    await text('newtab.js'),
    await text('intervention-overlay.js'),
    await text('popup.js'),
    await text('options.html'),
  ].join('\n');
  assert.equal(sources.includes('Welcome to IntentLock'), false);
  assert.equal(sources.includes('You stayed on track'), false);
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
  assert.match(workflow, /peaceiris\/actions-gh-pages@329bcc8f12caed2cefe5a5b80781499a6f3b361b/);
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

test('fallback lock actions match overlay pair layout', async () => {
  const css = await text('intervention.css');
  const newtab = await text('newtab.css');
  assert.match(css, /\.intervention-actions\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /\.intervention-actions button\s*\{[^}]*flex:\s*1 1 calc\(50% - 6px\)/s);
  assert.match(css, /\.intervention-actions button\s*\{[^}]*width:\s*auto/s);
  assert.match(css, /\.intervention-actions button\s*\{[^}]*max-width:\s*100%/s);
  assert.match(css, /\.intervention-actions \.end-session-btn\s*\{[^}]*flex:\s*1 1 100%/s);
  assert.doesNotMatch(newtab, /\.override-btn\s*\{\s*margin-top:\s*10px/);
});

function extractNamedFunction(src, name) {
  const start = src.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} must exist`);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`could not extract ${name}`);
}

test('lock reflection textarea sets aria-invalid only after empty Continue', async () => {
  const overlay = await text('intervention-overlay.js');
  const fallback = await text('intervention.js');
  for (const src of [overlay, fallback]) {
    const sync = extractNamedFunction(src, 'syncContinueEnabled');
    assert.doesNotMatch(sync, /aria-invalid/);
    assert.match(src, /if\s*\(!reflection\)\s*\{[\s\S]*?setAttribute\(['"]aria-invalid['"],\s*['"]true['"]\)/);
    const inputHandler = src.match(/addEventListener\(['"]input['"],\s*\(\)\s*=>\s*\{[\s\S]*?\}\s*\)/);
    assert.ok(inputHandler, 'reflection input handler required');
    assert.match(
      inputHandler[0],
      /setAttribute\(['"]aria-invalid['"],\s*['"]false['"]\)|removeAttribute\(['"]aria-invalid['"]\)/,
    );
  }
});

test('fallback stagger-1 has animation none', async () => {
  const css = await text('intervention.css');
  const stagger = css.match(/\.stagger-1[\s\S]*?\{([^}]+)\}/);
  assert.ok(stagger, '.stagger-1 styles required');
  assert.match(stagger[1], /animation:\s*none/);
});

test('fallback lock textarea maxlength is 2000 and continue hint is present', async () => {
  const html = await text('intervention.html');
  const js = await text('intervention.js');
  const css = await text('newtab.css');
  const match = html.match(/<textarea[^>]*id=["']reflection-input["'][^>]*>/i)
    || html.match(/<textarea[^>]*id=["']reflection-input["'][^>]*maxlength=["'](\d+)["']/i);
  assert.ok(match, 'fallback reflection textarea required');
  assert.match(html, /maxlength=["']2000["']/);
  assert.match(html, /Write why to continue\./);
  assert.match(js, /Time budget exceeded\./);
  assert.match(css, /text-underline-offset:\s*0\.2em/);
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

test('Lock in sends SESSION_STARTED without awaiting generateIntentPlan', async () => {
  const code = await text('newtab.js');
  const bind = extractNamedFunction(code, 'bindForm');
  assert.match(bind, /SESSION_STARTED/);
  assert.match(bind, /startSession\s*\(\s*\)/);
  assert.doesNotMatch(bind, /await\s+generateIntentPlan/);
  assert.doesNotMatch(bind, /generateIntentPlan\([\s\S]*?\.finally\s*\(\s*startSession/);
  const planIdx = bind.indexOf('generateIntentPlan');
  const startedIdx = bind.indexOf('SESSION_STARTED');
  const startCallIdx = bind.indexOf('startSession()');
  assert.ok(startedIdx >= 0 && startCallIdx >= 0);
  if (planIdx >= 0) {
    assert.ok(startCallIdx < planIdx, 'SESSION_STARTED path must run before generateIntentPlan');
    assert.match(bind, /isLlmConfigured/);
  }
  assert.match(code, /mergePolicyWithIntent\(/);
});

test('onboarding does not persist providerId none', async () => {
  const code = await text('onboarding.js');
  assert.doesNotMatch(code, /providerId:\s*['"]none['"]/);
  assert.doesNotMatch(code, /llmProviderConfig:\s*\{\s*providerId:/);
});

test('settings do not assign providerSelect to none', async () => {
  const js = await text('options.js');
  assert.doesNotMatch(js, /providerSelect\.value\s*=\s*['"]none['"]/);
  assert.match(js, /function applyStoredConfig[\s\S]*getProvider\(/);
  assert.doesNotMatch(js, /llmProviderConfig:\s*getDefaultProviderConfig\(DEFAULT_PROVIDER_ID\)/);
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

test('popup idle HTML includes Last session when rendering history without active session', async () => {
  const popupJs = await text('popup.js');
  const idle = extractNamedFunction(popupJs, 'renderIdle');
  assert.match(idle, /if \(last\)[\s\S]*Last session/);
  assert.match(idle, /else[\s\S]*No active session\./);
  assert.doesNotMatch(idle, /else[\s\S]*Last session/);
  assert.match(popupJs, /function showConfirmEndDialog/);
  assert.match(popupJs, /End session\?/);
});

test('showSummary uses session.overrides when events is missing', async () => {
  const code = await text('newtab.js');
  const summary = extractNamedFunction(code, 'showSummary');
  const overrideIdx = summary.indexOf('session.overrides');
  assert.ok(overrideIdx >= 0, 'showSummary must read session.overrides');
  const eventsFilterIdx = summary.search(/events\.filter\(\s*(?:e|\()\s*=>\s*e\.actionType\s*===\s*['"]OVERRIDE['"]/);
  if (eventsFilterIdx >= 0) {
    assert.ok(
      overrideIdx < eventsFilterIdx,
      'session.overrides must be preferred before events OVERRIDE fallback',
    );
  }
  assert.match(summary, /o\.reflection|override\.reflection/);
});

test('analytics.html has a new-tab CTA and CSS .popup-link has min-height 44px', async () => {
  const html = await text('analytics.html');
  const css = await text('newtab.css');
  const analyticsJs = await text('analytics.js');
  assert.match(html, /href=["']newtab\.html["']/);
  const block = css.match(/\.popup-link\s*\{([^}]+)\}/);
  assert.ok(block, '.popup-link styles required');
  assert.match(block[1], /min-height:\s*44px/);
  assert.match(block[1], /display:\s*inline-flex/);
  assert.doesNotMatch(block[1], /#[0-9a-fA-F]{3,8}/);
  assert.match(analyticsJs, /chrome\.runtime\.lastError/);
});

test('popup.js and newtab.js do not use #888', async () => {
  const popupJs = await text('popup.js');
  const newtabJs = await text('newtab.js');
  assert.equal(popupJs.includes('#888'), false);
  assert.equal(newtabJs.includes('#888'), false);
  assert.doesNotMatch(popupJs, /font-size:\s*0\.7rem/);
  assert.doesNotMatch(newtabJs, /color:\s*#888/);
});

test('newtab.css category radios are not display none', async () => {
  const css = await text('newtab.css');
  const radioBlock = css.match(/\.category-radios input\[type=["']radio["']\]\s*\{([^}]+)\}/);
  assert.ok(radioBlock, '.category-radios input[type="radio"] styles required');
  assert.doesNotMatch(radioBlock[1], /display:\s*none/);
  assert.match(radioBlock[1], /opacity:\s*0/);
  assert.match(radioBlock[1], /position:\s*absolute/);
  assert.match(radioBlock[1], /width:\s*1px/);
  assert.match(radioBlock[1], /height:\s*1px/);
  assert.match(radioBlock[1], /clip:/);
  const labelBlock = css.match(/\.category-radios label\s*\{([^}]+)\}/);
  assert.ok(labelBlock, '.category-radios label styles required');
  assert.match(labelBlock[1], /min-height:\s*44px/);
});

test('tracking-toggle input does not set outline none without a focus-visible replacement on the hit box', async () => {
  const css = await text('newtab.css');
  const html = await text('options.html');
  assert.match(html, /class=["']tracking-toggle-hit["']/);
  const hitTargetBlock = css.match(/\.tracking-toggle-hit\s*\{([^}]+)\}/);
  assert.ok(hitTargetBlock, 'tracking-toggle-hit styles required');
  assert.match(hitTargetBlock[1], /min-width:\s*44px/);
  assert.match(hitTargetBlock[1], /min-height:\s*44px/);
  const inputBlock = css.match(/\.tracking-toggle-hit input\[type=["']checkbox["']\]\s*\{([^}]+)\}/);
  assert.ok(inputBlock, 'tracking-toggle checkbox styles required');
  const outlineNone = /outline:\s*none/.test(inputBlock[1]);
  const hitFocus = css.match(/\.tracking-toggle-hit(?:\s+input\[type=["']checkbox["']\])?:focus-visible\s*\{([^}]+)\}/);
  if (outlineNone) {
    assert.ok(hitFocus, 'outline:none requires :focus-visible on the tracking hit box');
    assert.match(hitFocus[1], /outline:\s*(?!none\b)/);
  }
});

test('popup/options/analytics/intervention HTML include viewport meta', async () => {
  const pages = ['popup.html', 'options.html', 'analytics.html', 'intervention.html', 'history.html', 'diagnostics.html'];
  for (const page of pages) {
    const html = await text(page);
    assert.match(
      html,
      /<meta\s+name=["']viewport["']\s+content=["']width=device-width,\s*initial-scale=1(?:\.0)?["']\s*\/?>/i,
      `${page} needs viewport meta`,
    );
  }
});

test('history search has a for-linked label and filter buttons expose aria-pressed', async () => {
  const html = await text('history.html');
  const optionsHtml = await text('options.html');
  const optionsJs = await text('options.js');
  const historyJs = await text('history.js');
  assert.match(html, /<label[^>]*for=["']history-search["']/);
  assert.match(html, /filter-btn active[^>]*aria-pressed=["']true["']/);
  assert.match(optionsHtml, /theme-btn[^>]*aria-pressed=/);
  assert.match(optionsJs, /setAttribute\(\s*['"]aria-pressed['"]/);
  assert.match(historyJs, /setAttribute\(\s*['"]aria-pressed['"]/);
});

test('history-meta diagnostics-meta tabular-nums and h1 intent-statement text-wrap balance', async () => {
  const css = await text('newtab.css');
  for (const selector of ['.history-meta', '.diagnostics-meta']) {
    const escaped = selector.replace(/\./g, '\\.');
    const block = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
    assert.ok(block, `${selector} styles required`);
    assert.match(block[1], /font-variant-numeric:\s*tabular-nums/);
  }
  assert.match(css, /h1[\s\S]*?text-wrap:\s*balance/);
  assert.match(css, /\.intent-statement[\s\S]*?text-wrap:\s*balance/);
});

test('theme auto applies theme-dark when matchMedia prefers dark', async () => {
  const options = await text('options.js');
  const newtab = await text('newtab.js');
  for (const src of [options, newtab]) {
    assert.match(src, /matchMedia\(\s*['"]\(prefers-color-scheme:\s*dark\)['"]\s*\)/);
    assert.match(src, /theme-dark/);
  }
  const apply = extractNamedFunction(options, 'applyTheme');
  assert.match(apply, /prefers-color-scheme:\s*dark/);
  assert.match(apply, /theme-dark/);
  assert.doesNotMatch(apply, /opacity:\s*['"]?0\.6/);
  assert.doesNotMatch(options, /opacity:\s*['"]0\.6['"]/);
});

test('shortcuts heading is sentence case and Mac uses Command glyph', async () => {
  const code = await text('newtab.js');
  assert.match(code, /textContent\s*=\s*['"]Keyboard shortcuts['"]/);
  assert.equal(code.includes('Keyboard Shortcuts'), false);
  assert.match(code, /userAgentData|navigator\.platform/);
  assert.match(code, /⌘|Command/);
});

test('README first-run copy matches wizard Declare your intent', async () => {
  const readme = await text('README.md');
  assert.match(readme, /Declare your intent\./);
  assert.equal(readme.includes('Welcome to IntentLock'), false);
  assert.doesNotMatch(readme, /\|\s*\*\*1 — Welcome\*\*/);
});

test('confirm and shortcuts overlays use class opacity without nested dialog fade', async () => {
  const css = await text('newtab.css');
  const code = await text('newtab.js');
  for (const selector of ['.confirm-overlay', '.shortcuts-modal']) {
    const escaped = selector.replace(/\./g, '\\.');
    const block = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 's'));
    assert.ok(block, `${selector} styles required`);
    assert.match(block[1], /transition:\s*opacity\s+160ms\s+ease-out/);
    assert.doesNotMatch(block[1], /animation:\s*fadeIn/);
  }
  const dialog = css.match(/\.confirm-dialog\s*\{([^}]+)\}/s);
  assert.ok(dialog, '.confirm-dialog styles required');
  assert.doesNotMatch(dialog[1], /animation:\s*fadeIn/);
  assert.match(css, /\.confirm-overlay\.is-open|\.shortcuts-modal\.is-open/);
  assert.match(code, /classList\.add\(\s*['"]is-open['"]\s*\)/);
  assert.match(code, /setTimeout\(\s*finish\s*,\s*180\s*\)/);
});

test('options status uses 160ms ease-out and button active includes transform', async () => {
  const options = await text('options.js');
  const css = await text('newtab.css');
  assert.match(options, /opacity\s+160ms\s+ease-out/);
  assert.doesNotMatch(options, /200ms\s+cubic-bezier\(0\.2,\s*0,\s*0,\s*1\)/);
  const buttonBlock = css.match(/^button\s*\{([^}]+)\}/m)
    || css.match(/(?:^|\n)button\s*\{([^}]+)\}/);
  assert.ok(buttonBlock, 'button styles required');
  assert.match(buttonBlock[1], /transition:[^;]*transform/);
});

test('status history diagnostics left rails are 1px and unused preset CSS removed', async () => {
  const css = await text('newtab.css');
  for (const selector of ['#status-message', '.reflection-item', '.history-card', '.diagnostics-entry']) {
    const escaped = selector.replace(/\./g, '\\.').replace(/#/g, '\\#');
    const block = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 's'));
    assert.ok(block, `${selector} styles required`);
    assert.match(block[1], /border-left(?:-width)?:\s*1px/);
    assert.doesNotMatch(block[1], /border-left(?:-width)?:\s*2px/);
  }
  assert.doesNotMatch(css, /#intent-preset/);
  assert.doesNotMatch(css, /#session-strictness/);
  assert.doesNotMatch(css, /\.plan-list\s*\{/);
  assert.doesNotMatch(css, /\.plan-step\s*\{/);
  assert.doesNotMatch(css, /\.api-notice\s*\{/);
});

test('bundled VV fonts or documented family names remain and no outline none regression', async () => {
  const css = await text('newtab.css');
  assert.match(css, /IBM Plex Mono/);
  assert.match(css, /Source Serif 4/);
  assert.match(css, /@font-face/);
  assert.match(css, /fonts\/IBMPlexMono-Regular\.woff2/);
  assert.match(css, /fonts\/SourceSerif4-Regular\.woff2/);
  assert.match(css, /fonts\/SourceSerif4-Italic\.woff2/);
  assert.equal(/outline:\s*none/.test(css), false);
  assert.match(css, /--bg-white:\s*#ffffff/);
  assert.match(css, /--fg-black:\s*#000000/);
  assert.match(css, /--muted-black:\s*#1a1a1a/);
});

test('onboarding second step is not named showStep3', async () => {
  const code = await text('onboarding.js');
  assert.equal(code.includes('showStep3'), false);
  assert.match(code, /function\s+showStep2\s*\(/);
});
