import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeCustomDomainRules } from '../heuristic-policy.js';

test('options settings use the shared path-aware custom domain normalizer', async () => {
  const source = await readFile(new URL('../options.js', import.meta.url), 'utf8');
  assert.match(source, /normalizeCustomDomainRules/);
  assert.doesNotMatch(source, /HOSTNAME_RE/);
  assert.deepEqual(
    normalizeCustomDomainRules(['google.com/travel', 'docs.example.com/work/']),
    ['google.com/travel', 'docs.example.com/work'],
  );
});
