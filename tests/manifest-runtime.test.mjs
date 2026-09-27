import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);

const expectedRuntimeFiles = [
  'analytics.html',
  'analytics.js',
  'background.js',
  'content.js',
  'diagnostics.html',
  'diagnostics.js',
  'distraction-sites.js',
  'drift-cache.js',
  'drift.js',
  'error-log.js',
  'fonts/IBMPlexMono-Regular.woff2',
  'fonts/OFL-IBMPlexMono.txt',
  'fonts/OFL-SourceSerif4.txt',
  'fonts/SourceSerif4-Italic.woff2',
  'fonts/SourceSerif4-Regular.woff2',
  'heuristic-policy.js',
  'history.html',
  'history.js',
  'icon128.png',
  'icon16.png',
  'icon48.png',
  'intervention-overlay.js',
  'intervention.css',
  'intervention.html',
  'intervention.js',
  'llm-backoff.js',
  'llm.js',
  'manifest.json',
  'newtab.css',
  'newtab.html',
  'newtab.js',
  'onboarding.js',
  'options.html',
  'options.js',
  'page-tracker.js',
  'popup.html',
  'popup.js',
  'providers.js',
  'privacy-utils.js',
  'session-metrics.js',
  'storage-queue.js',
  'storage-client.js',
  'storage-authority.js',
];

async function readRoot(relativePath) {
  return readFile(new URL(relativePath, root), 'utf8');
}

function runNodeScript(script, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: rootPath,
    encoding: 'utf8',
  });
}

function zipEntries(zipPath) {
  const result = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, `unable to inspect ZIP:\n${result.stderr}`);
  return result.stdout.trim().split('\n').filter(Boolean);
}

function sha256(path) {
  const result = spawnSync('shasum', ['-a', '256', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, `unable to hash ZIP:\n${result.stderr}`);
  return result.stdout.split(/\s+/)[0];
}

test('manifest declares alarms and a supported ordered classic content script', async () => {
  const manifest = JSON.parse(await readRoot('manifest.json'));
  const contentScript = manifest.content_scripts?.[0];

  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes('alarms'));
  assert.equal(manifest.background.type, 'module');
  assert.deepEqual(contentScript.js, [
    'page-tracker.js',
    'intervention-overlay.js',
    'content.js',
  ]);
  assert.equal('type' in contentScript, false);
  assert.equal(contentScript.run_at, 'document_idle');

  const contentCode = await readRoot('content.js');
  assert.doesNotMatch(contentCode, /^\s*import\s/m);
  assert.match(contentCode, /IntentLock\.pageTracker/);
  assert.match(contentCode, /IntentLock\.interventionOverlay/);
});

test('manifest exposes packaged VV fonts to http and https pages', async () => {
  const manifest = JSON.parse(await readRoot('manifest.json'));
  const entries = manifest.web_accessible_resources || [];
  const fontEntry = entries.find((entry) =>
    (entry.resources || []).includes('fonts/IBMPlexMono-Regular.woff2'),
  );

  assert.ok(fontEntry, 'web_accessible_resources must list VV font files');
  assert.deepEqual(fontEntry.resources, [
    'fonts/IBMPlexMono-Regular.woff2',
    'fonts/SourceSerif4-Regular.woff2',
    'fonts/SourceSerif4-Italic.woff2',
  ]);
  assert.deepEqual(fontEntry.matches, ['http://*/*', 'https://*/*']);
});

test('manifest and HTML runtime references resolve to files in the repository', async () => {
  const manifest = JSON.parse(await readRoot('manifest.json'));
  const references = [
    ...Object.values(manifest.icons || {}),
    manifest.chrome_url_overrides?.newtab,
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.options_ui?.page,
    ...(manifest.content_scripts || []).flatMap((entry) => [
      ...(entry.js || []),
      ...(entry.css || []),
    ]),
  ].filter(Boolean);

  for (const htmlPath of [
    'analytics.html',
    'diagnostics.html',
    'history.html',
    'intervention.html',
    'newtab.html',
    'options.html',
    'popup.html',
  ]) {
    const html = await readRoot(htmlPath);
    for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      references.push(match[1]);
    }
  }

  for (const reference of new Set(references)) {
    assert.doesNotReject(
      access(new URL(reference, root), constants.R_OK),
      `missing runtime asset: ${reference}`,
    );
  }
});

test('package scripts provide test, static verification, packaging, and version validation', async () => {
  const packageJson = JSON.parse(await readRoot('package.json'));

  assert.equal(packageJson.type, 'module');
  assert.match(packageJson.scripts?.test || '', /node --test tests\/\*\.test\.mjs/);
  assert.match(packageJson.scripts?.['verify:static'] || '', /node --test/);
  assert.match(packageJson.scripts?.package || '', /package-release\.mjs/);
  assert.match(packageJson.scripts?.['validate:version'] || '', /validate-version\.mjs/);
});

test('release ZIP is deterministic and contains only the explicit runtime allowlist', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'intentlock-release-'));
  const firstZip = join(tempDir, 'first.zip');
  const secondZip = join(tempDir, 'second.zip');

  try {
    for (const output of [firstZip, secondZip]) {
      const result = runNodeScript('scripts/package-release.mjs', ['--output', output]);
      assert.equal(result.status, 0, `packaging failed:\n${result.stdout}\n${result.stderr}`);
    }

    assert.deepEqual(zipEntries(firstZip), expectedRuntimeFiles);
    assert.deepEqual(zipEntries(secondZip), expectedRuntimeFiles);
    assert.equal(sha256(firstZip), sha256(secondZip));
    assert.equal(expectedRuntimeFiles.some((file) => file.startsWith('tests/')), false);
    assert.equal(expectedRuntimeFiles.some((file) => file.startsWith('docs/')), false);
    assert.equal(expectedRuntimeFiles.includes('package.json'), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('version validation accepts a matching vX.Y.Z tag and rejects mismatches', async () => {
  const manifest = JSON.parse(await readRoot('manifest.json'));
  const matching = runNodeScript('scripts/validate-version.mjs', [`v${manifest.version}`]);
  assert.equal(matching.status, 0, matching.stderr);

  const mismatched = runNodeScript('scripts/validate-version.mjs', ['v0.0.0']);
  assert.notEqual(mismatched.status, 0);
});

test('Chrome version parsing enforces component bounds, shape, and tag rules', async () => {
  const { parseChromeTag, parseChromeVersion } = await import('../scripts/chrome-version.mjs');

  assert.deepEqual(parseChromeVersion('1.5.1'), [1, 5, 1]);
  assert.deepEqual(parseChromeVersion('0.1.0'), [0, 1, 0]);
  assert.deepEqual(parseChromeVersion('1.2.3.4'), [1, 2, 3, 4]);
  assert.deepEqual(parseChromeTag('v1.5.1'), {
    tag: 'v1.5.1',
    version: '1.5.1',
    components: [1, 5, 1],
  });

  for (const invalidVersion of [
    '',
    '0',
    '0.0.0',
    '1.02.3',
    '65536.1.1',
    '1.2.3.4.5',
    '1.-2.3',
    '1.2.3-beta',
  ]) {
    assert.throws(() => parseChromeVersion(invalidVersion), invalidVersion);
  }

  for (const invalidTag of [
    '',
    '1.5.1',
    'v0.0.0',
    'v01.5.1',
    'v1.2',
    'v1.2.3.4',
    'v65536.1.1',
  ]) {
    assert.throws(() => parseChromeTag(invalidTag), invalidTag);
  }
});

test('packaging validates regular in-repository sources and rejects symlinks or escapes', async () => {
  const { validateRuntimeSources } = await import('../scripts/package-release.mjs');
  const tempDir = await mkdtemp(join(tmpdir(), 'intentlock-sources-'));
  const outsideDir = await mkdtemp(join(tmpdir(), 'intentlock-outside-'));

  try {
    await writeFile(join(tempDir, 'runtime.js'), 'runtime');
    await writeFile(join(outsideDir, 'runtime.js'), 'outside');
    await symlink(join(tempDir, 'runtime.js'), join(tempDir, 'runtime-link.js'));
    await symlink(outsideDir, join(tempDir, 'linked-directory'));

    const sources = await validateRuntimeSources(tempDir, ['runtime.js']);
    const resolvedTempDir = await realpath(tempDir);
    assert.equal(sources[0].relativePath, 'runtime.js');
    assert.equal(sources[0].sourcePath, join(resolvedTempDir, 'runtime.js'));
    await assert.rejects(
      validateRuntimeSources(tempDir, ['runtime-link.js']),
      /symbolic link|symlink/i,
    );
    await assert.rejects(
      validateRuntimeSources(tempDir, ['..\/outside.js']),
      /repository root/i,
    );
    await assert.rejects(
      validateRuntimeSources(tempDir, ['linked-directory/runtime.js']),
      /resolved runtime asset escapes repository root/i,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test('packaging reports spawn failures accurately and removes partial output', async () => {
  const { createReleaseZip } = await import('../scripts/package-release.mjs');
  const tempDir = await mkdtemp(join(tmpdir(), 'intentlock-package-errors-'));
  const manifestPath = join(tempDir, 'manifest.json');
  const outputPath = join(tempDir, 'release.zip');

  try {
    await writeFile(manifestPath, JSON.stringify({ version: '1.5.1' }));

    await writeFile(outputPath, 'partial');
    await assert.rejects(
      createReleaseZip(outputPath, {
        repositoryRoot: tempDir,
        runtimeFiles: ['manifest.json'],
        spawn: () => ({
          error: Object.assign(new Error('zip executable missing'), { code: 'ENOENT' }),
          status: null,
          signal: null,
          stdout: '',
          stderr: '',
        }),
      }),
      /could not start.*ENOENT.*zip executable missing/i,
    );
    await assert.rejects(access(outputPath));

    await writeFile(outputPath, 'partial');
    await assert.rejects(
      createReleaseZip(outputPath, {
        repositoryRoot: tempDir,
        runtimeFiles: ['manifest.json'],
        spawn: () => ({
          error: null,
          status: null,
          signal: 'SIGTERM',
          stdout: '',
          stderr: '',
        }),
      }),
      /terminated by signal SIGTERM/i,
    );
    await assert.rejects(access(outputPath));

    await writeFile(outputPath, 'partial');
    await assert.rejects(
      createReleaseZip(outputPath, {
        repositoryRoot: tempDir,
        runtimeFiles: ['manifest.json'],
        spawn: () => ({
          error: null,
          status: 2,
          signal: null,
          stdout: '',
          stderr: 'archive failed',
        }),
      }),
      /zip exited with status 2: archive failed/i,
    );
    await assert.rejects(access(outputPath));

    await writeFile(manifestPath, JSON.stringify({ version: '0.0.0' }));
    await writeFile(outputPath, 'partial');
    await assert.rejects(
      createReleaseZip(outputPath, {
        repositoryRoot: tempDir,
        runtimeFiles: ['manifest.json'],
      }),
      /invalid Chrome version/i,
    );
    await assert.rejects(access(outputPath));
    await assert.rejects(
      createReleaseZip(undefined, {
        repositoryRoot: tempDir,
        runtimeFiles: ['manifest.json'],
      }),
      /invalid Chrome version/i,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('GitHub Actions workflows use minimal permissions and immutable action references', async () => {
  for (const workflow of [
    '.github/workflows/test.yml',
    '.github/workflows/release.yml',
    '.github/workflows/pages.yml',
  ]) {
    const code = await readRoot(workflow);
    assert.match(code, /permissions:/);
    for (const match of code.matchAll(/uses:\s*([^\s]+)@([^\s]+)/g)) {
      assert.match(match[2], /^[0-9a-f]{40}$/, `${workflow} uses a mutable action ref: ${match[0]}`);
    }
  }

  const testWorkflow = await readRoot('.github/workflows/test.yml');
  assert.match(testWorkflow, /contents:\s*read/);
  const releaseWorkflow = await readRoot('.github/workflows/release.yml');
  assert.match(releaseWorkflow, /contents:\s*write/);
  const testBeforePackage = releaseWorkflow.indexOf('run: npm test');
  const packageStep = releaseWorkflow.indexOf('run: npm run package');
  const releaseStep = releaseWorkflow.indexOf('gh release create');
  assert.ok(testBeforePackage >= 0, 'release workflow must run npm test');
  assert.ok(testBeforePackage < packageStep, 'release tests must run before packaging');
  assert.ok(testBeforePackage < releaseStep, 'release tests must run before publication');
});

test('CI runs every Node suite, release checks and the real Chromium journeys', async () => {
  const workflow = await readRoot('.github/workflows/test.yml');
  const pkg = JSON.parse(await readRoot('package.json'));
  assert.equal(pkg.scripts.test, 'node --test tests/*.test.mjs', 'npm test must discover every Node test file');
  for (const step of ['run: npm test', 'run: npm run verify:static', 'run: npm run validate:version',
    'run: npm run package', 'run: npm ci', 'npx playwright install --with-deps chromium', 'run: npm run test:browser']) {
    assert.ok(workflow.includes(step), `test workflow must include ${step}`);
  }
  assert.match(workflow, /node-version: \[18\.x, 20\.x, 22\.x\]/);
  assert.doesNotMatch(workflow, /secrets\./, 'test workflow must not read secrets');
  assert.doesNotMatch(workflow, /chromiumSandbox:\s*false|--no-sandbox/);
});
