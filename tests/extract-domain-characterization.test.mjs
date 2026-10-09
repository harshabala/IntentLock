import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { hostnameFromUrl } from '../privacy-utils.js';

/** Restored extractDomain (same body as origin/main background.js). */
function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

const CASES = [
  ['empty string', ''],
  ['chrome://settings', 'chrome://settings'],
  ['about:blank', 'about:blank'],
  ['file:///tmp/x', 'file:///tmp/x'],
  ['userinfo', 'https://user:pass@example.com/path'],
  ['ipv4', 'https://127.0.0.1/x'],
  ['trailing-dot host', 'https://example.com./a'],
  ['www strip', 'https://www.Example.com/a'],
  ['nullish', null],
  ['undefined', undefined],
];

test('background.js extractDomain is the legacy function, not hostnameFromUrl', async () => {
  const bg = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  assert.match(bg, /function extractDomain\(url\) \{/);
  assert.doesNotMatch(bg, /const extractDomain = hostnameFromUrl/);
});

test('extractDomain pins legacy empty-host as empty string', () => {
  for (const [label, url] of CASES) {
    const got = extractDomain(url);
    const privacy = hostnameFromUrl(url);
    if (got === '' && privacy === null) continue;
    assert.equal(got, privacy, `${label}: extractDomain=${JSON.stringify(got)} hostnameFromUrl=${JSON.stringify(privacy)}`);
  }
  assert.equal(extractDomain(''), null);
  assert.equal(extractDomain('chrome://settings'), 'settings');
  assert.equal(extractDomain('about:blank'), '');
  assert.equal(extractDomain('file:///tmp/x'), '');
  assert.equal(extractDomain('https://user:pass@example.com/path'), 'example.com');
  assert.equal(extractDomain('https://127.0.0.1/x'), '127.0.0.1');
  assert.equal(extractDomain('https://example.com./a'), 'example.com.');
});

test('every extractDomain caller treats null and empty string the same (truthiness or || null)', async () => {
  const bg = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  const lines = bg.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    if (line.includes('extractDomain(') && !line.includes('function extractDomain')) {
      hits.push({ line: i + 1, text: line.trim() });
    }
  });
  assert.ok(hits.length >= 6, `expected several callers, got ${hits.length}`);
  const unsafe = hits.filter(({ text }) => {
    if (/if\s*\(\s*(host|domain|evaluatedDomain|hostname)\s*\)/.test(text)) return false;
    if (/\|\|\s*null/.test(text)) return false;
    if (/isDomainOnCooldown\(extractDomain\(/.test(text)) return false;
    if (/const (host|domain|hostname|evaluatedDomain) = extractDomain\(/.test(text)) return false;
    if (/hostname:\s*(e\.hostname\s*\|\|\s*)?extractDomain\(/.test(text)) return false;
    return true;
  });
  const assigned = hits.filter(({ text }) => /hostname:\s*extractDomain\(/.test(text) && !/\|\|\s*null/.test(text));
  assert.equal(
    assigned.length,
    1,
    'override event stores extractDomain() directly (legacy empty-host is "")',
  );
  assert.deepEqual(unsafe, [], `callers that may distinguish null vs "": ${JSON.stringify(unsafe)}`);
});
