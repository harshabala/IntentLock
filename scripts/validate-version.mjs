import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseChromeTag, parseChromeVersion } from './chrome-version.mjs';

const root = new URL('../', import.meta.url);

export async function readManifestVersion() {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  return manifest.version;
}

export function versionFromTag(tag) {
  return parseChromeTag(tag).version;
}

export function assertTagMatchesVersion(tag, manifestVersion) {
  parseChromeVersion(manifestVersion);
  const tagVersion = versionFromTag(tag);
  if (tagVersion !== manifestVersion) {
    throw new Error(`tag ${tag} does not match manifest version ${manifestVersion}`);
  }
  return true;
}

export async function validateTag(tag) {
  const manifestVersion = await readManifestVersion();
  assertTagMatchesVersion(tag, manifestVersion);
  return manifestVersion;
}

async function main() {
  const tag = process.argv[2] || process.env.GITHUB_REF_NAME;
  const version = await validateTag(tag);
  console.log(`Validated ${tag} against manifest version ${version}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
