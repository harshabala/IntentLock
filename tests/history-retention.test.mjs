import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function source(file) {
  return readFile(new URL(file, root), 'utf8');
}

test('history and module UIs sanitize and persist retention-pruned session history', async () => {
  const history = await source('history.js');
  const popup = await source('popup.js');
  const analytics = await source('analytics.js');
  const newtab = await source('newtab.js');

  assert.match(history, /import\('\.\/privacy-utils\.js'\)/);
  assert.match(history, /sanitizeSessionHistory\(rawHistory\)/);
  assert.doesNotMatch(history, /chrome\.storage\.local\.set\(\{ sessionHistory: sanitizedHistory \}/);

  assert.match(popup, /import \{ sanitizeSessionHistory \} from '\.\/privacy-utils\.js';/);
  assert.match(popup, /sanitizeSessionHistory\(rawHistory\)/);
  assert.doesNotMatch(popup, /chrome\.storage\.local\.set\(\{ sessionHistory: sanitizedHistory \}/);

  assert.match(analytics, /import \{ sanitizeSessionHistory \} from '\.\/privacy-utils\.js';/);
  assert.match(analytics, /sanitizeSessionHistory\(rawHistory\)/);
  assert.doesNotMatch(analytics, /chrome\.storage\.local\.set\(\{ sessionHistory: sanitizedHistory \}/);

  assert.match(newtab, /import \{ sanitizeSessionHistory \} from '\.\/privacy-utils\.js';/);
  assert.match(newtab, /sanitizeSessionHistory\(raw\)/);
  assert.doesNotMatch(newtab, /chrome\.storage\.local\.set\(\{ sessionHistory: sanitized \}/);
});
