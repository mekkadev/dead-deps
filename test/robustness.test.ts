/**
 * The cases that embarrass a tool in front of a stranger.
 *
 * Everything here was reproduced by hand against the built CLI first, then
 * written down so it stays fixed. Two rules hold throughout: the tool never
 * shows a stack trace for a situation it can describe in a sentence, and it
 * never exits 0 on a failure or non-zero on a success.
 *
 * No test touches the network. The CLI cases chosen here all resolve before any
 * request is made — argument validation, a missing path, a project with nothing
 * to look up — which is what makes spawning the real binary safe.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { parseLockfile } from '../src/lockfile/index.js';
import { EXIT } from '../src/types.js';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'dead-deps-robustness-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function project(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), content);
  }
  return dir;
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function cli(...args: string[]): CliResult {
  const run = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    encoding: 'utf8',
    // A hard ceiling: any of these cases hanging is itself the bug.
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: '1', DEAD_DEPS_CONTACT: '' },
  });
  return { status: run.status ?? -1, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

/** Nothing the user should ever see: a raw Node stack trace. */
function assertNoStackTrace(result: CliResult): void {
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.ok(
    !/^\s+at\s.+:\d+:\d+\)?$/m.test(combined),
    `expected no stack trace, got:\n${combined.slice(0, 600)}`,
  );
}

describe('CLI argument validation', () => {
  it('rejects an unknown --min-state and lists the valid ones', () => {
    const result = cli(project('bad-state', { 'package.json': '{}' }), '--min-state', 'banana');
    assert.equal(result.status, EXIT.USAGE_ERROR);
    assert.match(result.stderr, /banana/);
    // The error has to be actionable, not merely correct.
    assert.match(result.stderr, /active/);
    assert.match(result.stderr, /hijack-risk/);
    assertNoStackTrace(result);
  });

  it('rejects a --limit of zero rather than silently reporting nothing', () => {
    const result = cli(project('zero-limit', { 'package.json': '{}' }), '--limit', '0');
    assert.equal(result.status, EXIT.USAGE_ERROR);
    assert.match(result.stderr, /--limit/);
    assertNoStackTrace(result);
  });

  it('reports a missing path in one sentence', () => {
    const result = cli(join(root, 'definitely-not-here'));
    assert.equal(result.status, EXIT.USAGE_ERROR);
    assert.match(result.stderr, /no such file or directory/i);
    assertNoStackTrace(result);
  });

  it('exits cleanly for --help and --version', () => {
    for (const flag of ['--help', '--version']) {
      const result = cli(flag);
      assert.equal(result.status, EXIT.OK, `${flag} should exit 0`);
      assert.ok(result.stdout.trim().length > 0, `${flag} should print something`);
    }
  });
});

describe('projects with nothing to scan', () => {
  it('fails with a clear message when there is no lockfile and no manifest', () => {
    const result = cli(project('bare', {}));
    assert.equal(result.status, EXIT.RUNTIME_ERROR);
    assert.match(result.stderr, /lockfile/i);
    assertNoStackTrace(result);
  });

  it('succeeds on a manifest with no dependencies at all', () => {
    const result = cli(project('no-deps', { 'package.json': '{}' }));
    // Nothing to flag is a clean result, not an error.
    assert.equal(result.status, EXIT.OK);
    assertNoStackTrace(result);
  });
});

describe('awkward lockfiles parse instead of throwing', () => {
  it('reads a classic yarn.lock with CRLF line endings', async () => {
    const dir = project('crlf', {
      'yarn.lock': '# yarn lockfile v1\r\n\r\n"lodash@^4.17.21":\r\n  version "4.17.21"\r\n',
    });
    const parsed = await parseLockfile(join(dir, 'yarn.lock'));
    assert.equal(parsed.format, 'yarn-v1');
    assert.deepEqual(
      parsed.dependencies.map((d) => d.name),
      ['lodash'],
    );
    assert.equal(parsed.dependencies[0]?.version, '4.17.21');
  });

  it('reads a classic yarn.lock that starts with a byte order mark', async () => {
    const dir = project('bom', {
      'yarn.lock': '﻿# yarn lockfile v1\n\n"ms@^2.1.3":\n  version "2.1.3"\n',
    });
    const parsed = await parseLockfile(join(dir, 'yarn.lock'));
    assert.equal(parsed.format, 'yarn-v1');
    assert.deepEqual(
      parsed.dependencies.map((d) => d.name),
      ['ms'],
    );
  });

  it('warns about a malformed entry instead of discarding the whole file', async () => {
    const dir = project('partly-broken', {
      'yarn.lock': [
        '# yarn lockfile v1',
        '',
        '"lodash@^4.17.21":',
        '  version "4.17.21"',
        '',
        '?????? this line is not a lockfile entry',
        '',
        '"ms@^2.1.3":',
        '  version "2.1.3"',
        '',
      ].join('\n'),
    });
    const parsed = await parseLockfile(join(dir, 'yarn.lock'));
    // The readable entries survive; that is the whole point.
    assert.ok(parsed.dependencies.some((d) => d.name === 'lodash'));
    assert.ok(parsed.dependencies.some((d) => d.name === 'ms'));
  });

  it('handles a pnpm workspace with several importers', async () => {
    const dir = project('workspace', {
      'pnpm-lock.yaml': [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        '      lodash:',
        "        specifier: ^4.17.21",
        '        version: 4.17.21',
        '  packages/api:',
        '    dependencies:',
        '      ms:',
        "        specifier: ^2.1.3",
        '        version: 2.1.3',
        'packages:',
        '  lodash@4.17.21: {}',
        '  ms@2.1.3: {}',
        '',
      ].join('\n'),
    });
    const parsed = await parseLockfile(join(dir, 'pnpm-lock.yaml'));
    assert.equal(parsed.format, 'pnpm');
    const names = parsed.dependencies.map((d) => d.name).sort();
    assert.deepEqual(names, ['lodash', 'ms']);
    // Both importers are the project's own, so both count as direct.
    assert.ok(parsed.dependencies.every((d) => d.direct));
  });
});
