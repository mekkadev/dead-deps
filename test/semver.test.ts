/**
 * Regression tests for advisory applicability.
 *
 * These exist because of one concrete failure: `ms@2.1.3` was reported as a
 * hijack risk on the strength of GHSA-w9mr-4mfr-499f, a ReDoS advisory that was
 * patched in 2.0.0. Counting an already-fixed advisory turns the maintainer
 * having done their job into evidence against them, and `ms` is exactly the
 * finished-but-quiet package the tool must never flag.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  advisoryAffectsVersion,
  compareVersions,
  parseVersion,
  versionSatisfiesRange,
} from '../src/semver.js';

describe('parseVersion', () => {
  it('parses full, partial and prefixed versions', () => {
    assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] });
    assert.deepEqual(parseVersion('v2.0.0'), { major: 2, minor: 0, patch: 0, prerelease: [] });
    assert.deepEqual(parseVersion('3'), { major: 3, minor: 0, patch: 0, prerelease: [] });
    assert.deepEqual(parseVersion('1.4'), { major: 1, minor: 4, patch: 0, prerelease: [] });
  });

  it('keeps prerelease identifiers and discards build metadata', () => {
    assert.deepEqual(parseVersion('1.0.0-rc.2+build.7'), {
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: ['rc', '2'],
    });
  });

  it('rejects anything that is not a version', () => {
    for (const input of ['', 'latest', 'not.a.version', '^1.0.0']) {
      assert.equal(parseVersion(input), null, `expected ${JSON.stringify(input)} to be rejected`);
    }
  });
});

describe('compareVersions', () => {
  const cmp = (a: string, b: string): number => {
    const left = parseVersion(a);
    const right = parseVersion(b);
    assert.ok(left !== null && right !== null);
    return compareVersions(left, right);
  };

  it('orders by major, minor then patch', () => {
    assert.equal(cmp('1.0.0', '2.0.0'), -1);
    assert.equal(cmp('1.2.0', '1.10.0'), -1);
    assert.equal(cmp('1.2.3', '1.2.3'), 0);
    assert.equal(cmp('2.1.3', '2.0.0'), 1);
  });

  it('ranks a prerelease below its own release', () => {
    assert.equal(cmp('1.0.0-rc.1', '1.0.0'), -1);
    assert.equal(cmp('1.0.0-alpha', '1.0.0-beta'), -1);
    // Numeric identifiers compare numerically, not as strings.
    assert.equal(cmp('1.0.0-rc.2', '1.0.0-rc.10'), -1);
  });
});

describe('versionSatisfiesRange', () => {
  it('handles the single-comparator form advisories use', () => {
    assert.equal(versionSatisfiesRange('1.9.0', '< 2.0.0'), true);
    assert.equal(versionSatisfiesRange('2.1.3', '< 2.0.0'), false);
    assert.equal(versionSatisfiesRange('2.0.0', '<= 2.0.0'), true);
  });

  it('requires every clause of a comma-separated range', () => {
    assert.equal(versionSatisfiesRange('1.2.0', '>= 1.0.0, < 1.4.2'), true);
    assert.equal(versionSatisfiesRange('0.9.0', '>= 1.0.0, < 1.4.2'), false);
    assert.equal(versionSatisfiesRange('1.4.2', '>= 1.0.0, < 1.4.2'), false);
  });

  it('returns null rather than guessing at syntax it does not know', () => {
    assert.equal(versionSatisfiesRange('1.0.0', '^1.0.0'), null);
    assert.equal(versionSatisfiesRange('1.0.0', ''), null);
    assert.equal(versionSatisfiesRange('not-a-version', '< 2.0.0'), null);
  });
});

describe('advisoryAffectsVersion', () => {
  it('clears the version that ms was wrongly flagged on', () => {
    // GHSA-w9mr-4mfr-499f: vulnerable "< 2.0.0", first patched 2.0.0.
    assert.equal(advisoryAffectsVersion('2.1.3', '< 2.0.0', '2.0.0'), false);
    assert.equal(advisoryAffectsVersion('1.0.0', '< 2.0.0', '2.0.0'), true);
  });

  it('falls back to the first patched version when no range is published', () => {
    assert.equal(advisoryAffectsVersion('3.0.0', null, '2.5.0'), false);
    assert.equal(advisoryAffectsVersion('2.4.9', null, '2.5.0'), true);
  });

  it('reports unknown when applicability cannot be established', () => {
    // Unknown must not read as "safe": the caller keeps counting the advisory.
    assert.equal(advisoryAffectsVersion(null, '< 2.0.0', '2.0.0'), null);
    assert.equal(advisoryAffectsVersion('1.0.0', null, null), null);
    assert.equal(advisoryAffectsVersion('1.0.0', '^1.0.0', null), null);
  });

  it('prefers the explicit range over the patched version when both exist', () => {
    assert.equal(advisoryAffectsVersion('1.5.0', '>= 2.0.0, < 3.0.0', '3.0.0'), false);
  });
});
