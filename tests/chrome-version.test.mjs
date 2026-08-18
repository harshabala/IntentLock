import assert from 'node:assert/strict';
import test from 'node:test';
import { parseChromeTag, parseChromeVersion } from '../scripts/chrome-version.mjs';

test('parseChromeVersion accepts Chrome manifest version boundaries', () => {
  for (const [version, expected] of [
    ['1', [1]],
    ['1.0', [1, 0]],
    ['0.1.0.0', [0, 1, 0, 0]],
    ['65535.65535.65535.65535', [65535, 65535, 65535, 65535]],
  ]) {
    assert.deepEqual(parseChromeVersion(version), expected);
  }
});

test('parseChromeVersion rejects malformed and out-of-range components', () => {
  for (const version of [
    '',
    '0',
    '0.0.0',
    '0.0.0.0',
    '1.01.2',
    '1.2.003',
    '65536.1.1',
    '1.65536.1',
    '1.2.3.65536',
    '1.2.3.4.5',
    '1.-2.3',
    '1.2.3-beta',
    ' 1.2.3',
    '1.2.3 ',
  ]) {
    assert.throws(() => parseChromeVersion(version), /invalid Chrome version/);
  }

  for (const version of [null, 1.2, {}, []]) {
    assert.throws(() => parseChromeVersion(version), /invalid Chrome version/);
  }
});

test('parseChromeTag accepts only a strict three-component release tag', () => {
  assert.deepEqual(parseChromeTag('v1.5.1'), {
    tag: 'v1.5.1',
    version: '1.5.1',
    components: [1, 5, 1],
  });

  for (const tag of ['', '1.5.1', 'v0.0.0', 'v01.5.1', 'v1.2', 'v1.2.3.4', 'v1.2.3\n']) {
    assert.throws(() => parseChromeTag(tag), /invalid/);
  }
});
