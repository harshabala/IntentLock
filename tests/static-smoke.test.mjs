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
    ['tabs', 'storage', 'idle', 'tabGroups'],
  );

  assert.deepEqual(
    [...manifest.host_permissions].sort(),
    ['http://*/*', 'https://*/*'],
  );

  assert.deepEqual(
    [...manifest.content_scripts[0].matches].sort(),
    ['http://*/*', 'https://*/*'],
  );
});

test('all extension javascript files parse', async () => {
  for (const file of [
    'background.js',
    'content.js',
    'drift.js',
    'history.js',
    'intervention.js',
    'llm.js',
    'providers.js',
    'newtab.js',
    'options.js',
    'popup.js',
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

  const combined = Object.values(files).join('\n').toLowerCase();
  for (const forbidden of [
    'goals',
    'favorite',
    'patterns',
    'quick start',
    'category',
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

test('options.html exposes multi-provider LLM settings', async () => {
  const html = await text('options.html');
  assert.match(html, /id=["']provider-select["']/);
  assert.match(html, /id=["']model-input["']/);
  assert.match(html, /id=["']base-url-input["']/);
  assert.match(html, /id=["']custom-provider-fields["']/);
});

test('newtab.js enforces maxLength on dynamically created textareas', async () => {
  const code = await text('newtab.js');
  
  // Verify edit intent textarea has maxLength set
  assert.ok(code.includes('.maxLength = 250') || code.includes('.maxLength=250'), 'edit intent textarea should set maxLength');
  
  // Verify dynamic intentInput in showNewSessionForm has maxLength set
  assert.match(code, /intentInput\.maxLength\s*=\s*\d+/);
});


