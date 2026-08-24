import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  utimes,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChromeVersion } from './chrome-version.mjs';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);
const FIXED_TIMESTAMP = new Date('1980-01-01T00:00:00Z');

// Keep this list explicit: source, test, documentation, and local development files
// must never enter a release artifact by directory traversal.
export const RUNTIME_FILES = Object.freeze([
  'background.js',
  'content.js',
  'diagnostics.html',
  'diagnostics.js',
  'distraction-sites.js',
  'drift-cache.js',
  'drift.js',
  'error-log.js',
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
]);

async function readManifest(repositoryRoot) {
  return JSON.parse(await readFile(join(repositoryRoot, 'manifest.json'), 'utf8'));
}

function parseOutputPath(args) {
  const outputFlagIndex = args.indexOf('--output');
  if (outputFlagIndex === -1) return null;
  const output = args[outputFlagIndex + 1];
  if (!output) throw new Error('--output requires a file path');
  return resolve(rootPath, output);
}

function isInsideRepository(repositoryRoot, candidatePath) {
  const relativePath = relative(repositoryRoot, candidatePath);
  return relativePath === '' || (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

export async function validateRuntimeSources(repositoryRoot = rootPath, runtimeFiles = RUNTIME_FILES) {
  const resolvedRoot = await realpath(resolve(repositoryRoot));
  const sources = [];

  for (const relativePath of runtimeFiles) {
    const sourcePath = resolve(resolvedRoot, relativePath);
    if (!isInsideRepository(resolvedRoot, sourcePath)) {
      throw new Error(`runtime asset escapes repository root: ${relativePath}`);
    }

    const sourceStat = await lstat(sourcePath);
    if (sourceStat.isSymbolicLink()) {
      throw new Error(`runtime asset must not be a symbolic link: ${relativePath}`);
    }
    if (!sourceStat.isFile()) {
      throw new Error(`runtime asset must be a regular file: ${relativePath}`);
    }

    const resolvedSourcePath = await realpath(sourcePath);
    if (!isInsideRepository(resolvedRoot, resolvedSourcePath)) {
      throw new Error(`resolved runtime asset escapes repository root: ${relativePath}`);
    }
    await access(sourcePath, constants.R_OK);
    sources.push({ relativePath, sourcePath });
  }

  return sources;
}

export async function createReleaseZip(outputPath, {
  repositoryRoot = rootPath,
  runtimeFiles = RUNTIME_FILES,
  spawn = spawnSync,
} = {}) {
  const resolvedRepositoryRoot = resolve(repositoryRoot);
  let destination = outputPath
    ? resolve(resolvedRepositoryRoot, outputPath)
    : null;
  let staging;

  try {
    const manifest = await readManifest(resolvedRepositoryRoot);
    parseChromeVersion(manifest.version);
    destination ||= resolve(
      resolvedRepositoryRoot,
      `dist/IntentLock-v${manifest.version}.zip`,
    );
    await mkdir(dirname(destination), { recursive: true });

    const sources = await validateRuntimeSources(resolvedRepositoryRoot, runtimeFiles);
    staging = await mkdtemp(join(tmpdir(), 'intentlock-package-'));

    for (const { relativePath, sourcePath } of sources) {
      const stagedPath = join(staging, relativePath);
      await mkdir(dirname(stagedPath), { recursive: true });
      await copyFile(sourcePath, stagedPath);
      await utimes(stagedPath, FIXED_TIMESTAMP, FIXED_TIMESTAMP);
    }

    await rm(destination, { force: true });
    const result = spawn(
      'zip',
      ['-X', '-q', '-9', '-D', destination, ...runtimeFiles],
      { cwd: staging, encoding: 'utf8' },
    );
    if (result.error) {
      const code = result.error.code ? ` (${result.error.code})` : '';
      throw new Error(`zip could not start${code}: ${result.error.message}`, {
        cause: result.error,
      });
    }
    if (result.signal) {
      throw new Error(`zip terminated by signal ${result.signal}`);
    }
    if (result.status !== 0) {
      const detail = result.stderr || result.stdout || '';
      throw new Error(`zip exited with status ${result.status}${detail ? `: ${detail.trim()}` : ''}`);
    }
  } catch (error) {
    if (destination) {
      await rm(destination, { force: true });
    }
    throw error;
  } finally {
    if (staging) {
      await rm(staging, { recursive: true, force: true });
    }
  }

  return destination;
}

async function main() {
  const outputPath = parseOutputPath(process.argv.slice(2));
  const destination = await createReleaseZip(outputPath);
  console.log(`Created ${destination}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
