/**
 * Lockfile parsing.
 *
 * Every fixture format is parsed and compared against the *complete* expected
 * dependency set, written out by hand from the fixture. Comparing whole sets
 * rather than spot-checking a package is deliberate: the failures that matter
 * here are a package silently disappearing, a scoped name being split at the
 * wrong `@`, or a transitive entry being reported as direct — and each of those
 * looks fine to a `.some()` assertion.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';

import { detectLockfiles, parseLockfile } from '../src/lockfile/index.js';
import { nameFromPackagesKey } from '../src/lockfile/npm.js';
import { parsePnpmKey } from '../src/lockfile/pnpm.js';
import { splitDescriptor, splitDescriptors } from '../src/lockfile/yarn.js';
import type { LockfileFormat, ParsedLockfile } from '../src/types.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

function fixture(...parts: string[]): string {
  return join(FIXTURES, ...parts);
}

/** `name@version direct|transitive scope`, one line per dependency, in order. */
function summarise(parsed: ParsedLockfile): string[] {
  return parsed.dependencies.map(
    (dep) =>
      `${dep.name}@${dep.version ?? '-'} ${dep.direct ? 'direct' : 'transitive'} ${dep.scope}`,
  );
}

/** The set every well-formed fixture in this repo describes, per format. */
const NPM_V1_EXPECTED = [
  '@babel/core@7.24.0 direct dev',
  '@babel/parser@7.24.0 transitive dev',
  '@octokit/rest@19.0.13 direct prod',
  'escape-string-regexp@1.0.2 transitive dev',
  'escape-string-regexp@1.0.5 transitive dev',
  'fsevents@2.3.3 direct optional',
  'istanbul@0.4.5 direct dev',
  'moment@2.29.4 direct prod',
  'request@2.88.2 direct prod',
  'tough-cookie@2.5.0 transitive prod',
  'uuid@3.4.0 transitive prod',
];

let scratch: string;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dead-deps-lockfile-'));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Writes a throwaway project directory and returns the path of `lockName`. */
async function project(
  name: string,
  files: Record<string, string>,
  lockName: string,
): Promise<string> {
  const dir = join(scratch, name);
  await mkdir(dir, { recursive: true });
  for (const [file, body] of Object.entries(files)) {
    const target = join(dir, file);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, body, 'utf8');
  }
  return join(dir, lockName);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe('detectLockfiles', () => {
  test('returns lockfiles in preference order, lockfile before manifest', async () => {
    const found = await detectLockfiles(fixture('npm-v3'));
    assert.deepEqual(found, [fixture('npm-v3', 'package-lock.json'), fixture('npm-v3', 'package.json')]);
  });

  test('prefers pnpm-lock.yaml over everything else', async () => {
    const found = await detectLockfiles(fixture('pnpm-v5'));
    assert.equal(found[0], fixture('pnpm-v5', 'pnpm-lock.yaml'));
  });

  test('finds npm-shrinkwrap.json', async () => {
    const found = await detectLockfiles(fixture('npm-v2'));
    assert.deepEqual(found, [
      fixture('npm-v2', 'npm-shrinkwrap.json'),
      fixture('npm-v2', 'package.json'),
    ]);
  });

  test('a path to a file resolves to just that file', async () => {
    const path = fixture('yarn-v1', 'yarn.lock');
    assert.deepEqual(await detectLockfiles(path), [path]);
  });

  test('a directory with nothing to scan yields an empty list', async () => {
    const empty = join(scratch, 'empty');
    await mkdir(empty, { recursive: true });
    assert.deepEqual(await detectLockfiles(empty), []);
  });
});

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

describe('npm lockfiles', () => {
  test('v1: nested dependency tree, including a shadowed nested copy', async () => {
    const parsed = await parseLockfile(fixture('npm-v1', 'package-lock.json'));

    assert.equal(parsed.format, 'npm-v1' satisfies LockfileFormat);
    assert.equal(parsed.path, fixture('npm-v1', 'package-lock.json'));
    assert.deepEqual(summarise(parsed), NPM_V1_EXPECTED);
    assert.deepEqual(parsed.warnings, []);
  });

  test('v2: the flat packages map wins over the duplicated legacy tree', async () => {
    const parsed = await parseLockfile(fixture('npm-v2', 'npm-shrinkwrap.json'));

    assert.equal(parsed.format, 'npm-v2');
    // The v2 `packages` map holds a single hoisted escape-string-regexp, while
    // the legacy tree beneath it repeats every entry. Reading both would double
    // the set; reading only the tree would lose the hoisting.
    assert.deepEqual(summarise(parsed), [
      '@babel/core@7.24.0 direct dev',
      '@babel/parser@7.24.0 transitive dev',
      '@octokit/rest@19.0.13 direct prod',
      'escape-string-regexp@1.0.5 transitive dev',
      'fsevents@2.3.3 direct optional',
      'istanbul@0.4.5 direct dev',
      'moment@2.29.4 direct prod',
      'request@2.88.2 direct prod',
      'tough-cookie@2.5.0 transitive prod',
      'uuid@3.4.0 transitive prod',
    ]);
    assert.deepEqual(parsed.warnings, []);
  });

  test('v3: nested install paths, workspace links dropped', async () => {
    const parsed = await parseLockfile(fixture('npm-v3', 'package-lock.json'));

    assert.equal(parsed.format, 'npm-v3');
    assert.deepEqual(summarise(parsed), NPM_V1_EXPECTED);
    assert.deepEqual(parsed.warnings, []);

    // `node_modules/@example/tools` is `link: true` and `packages/tools` is the
    // workspace itself: neither is something the user can upgrade.
    assert.equal(
      parsed.dependencies.some((dep) => dep.name === '@example/tools'),
      false,
    );
  });

  test('v3: a nested install path reports the inner package, not the outer one', async () => {
    const parsed = await parseLockfile(fixture('npm-v3', 'package-lock.json'));
    // `node_modules/istanbul/node_modules/escape-string-regexp` is 1.0.2.
    const nested = parsed.dependencies.filter((dep) => dep.name === 'escape-string-regexp');
    assert.deepEqual(
      nested.map((dep) => dep.version),
      ['1.0.2', '1.0.5'],
    );
    assert.equal(
      parsed.dependencies.some((dep) => dep.name.includes('/node_modules/')),
      false,
    );
  });

  test('scoped names survive the packages-key round trip', () => {
    assert.equal(nameFromPackagesKey('node_modules/@babel/core'), '@babel/core');
    assert.equal(nameFromPackagesKey('node_modules/a/node_modules/b'), 'b');
    assert.equal(
      nameFromPackagesKey('node_modules/a/node_modules/@scope/b'),
      '@scope/b',
    );
    assert.equal(nameFromPackagesKey('packages/tools'), null);
    assert.equal(nameFromPackagesKey('node_modules/'), null);
  });
});

describe('pnpm lockfiles', () => {
  test('v5: slash-separated keys, underscore peer suffixes, workspace importers', async () => {
    const parsed = await parseLockfile(fixture('pnpm-v5', 'pnpm-lock.yaml'));

    assert.equal(parsed.format, 'pnpm');
    assert.deepEqual(summarise(parsed), [
      '@babel/core@7.24.0 direct dev',
      '@babel/parser@7.24.0 transitive dev',
      // `/@babel/plugin-syntax-jsx/7.24.0_@babel+core@7.24.0` — the v5 peer
      // suffix must not end up in the version.
      '@babel/plugin-syntax-jsx@7.24.0 transitive dev',
      '@octokit/rest@19.0.13 direct prod',
      // Declared by the `packages/tools` importer, so it is direct for someone.
      'escape-string-regexp@1.0.5 direct prod',
      'fsevents@2.3.3 direct optional',
      'istanbul@0.4.5 direct dev',
      'moment@2.29.4 direct prod',
      'request@2.88.2 direct prod',
      'tough-cookie@2.5.0 transitive prod',
      'uuid@3.4.0 transitive prod',
    ]);
    assert.deepEqual(parsed.warnings, []);
  });

  test('v6: at-separated keys and specifier/version importer records', async () => {
    const parsed = await parseLockfile(fixture('pnpm-v6', 'pnpm-lock.yaml'));

    assert.equal(parsed.format, 'pnpm');
    assert.deepEqual(summarise(parsed), [
      '@babel/core@7.24.0 direct dev',
      '@babel/parser@7.24.0 transitive dev',
      '@babel/plugin-syntax-jsx@7.24.0 transitive dev',
      '@octokit/rest@19.0.13 direct prod',
      'escape-string-regexp@1.0.5 transitive dev',
      'fsevents@2.3.3 direct optional',
      'istanbul@0.4.5 direct dev',
      'moment@2.29.4 direct prod',
      'request@2.88.2 direct prod',
      'tough-cookie@2.5.0 transitive prod',
      'uuid@3.4.0 transitive prod',
    ]);
    assert.deepEqual(parsed.warnings, []);
  });

  test('v9: importers plus the split packages/snapshots key spaces', async () => {
    const parsed = await parseLockfile(fixture('pnpm-v9', 'pnpm-lock.yaml'));

    assert.equal(parsed.format, 'pnpm');
    // v9 records no dev flag on `packages`/`snapshots` entries, so transitive
    // scope collapses to prod. Direct entries still take scope from the
    // importer, which is the part a user can act on.
    assert.deepEqual(summarise(parsed), [
      '@babel/core@7.24.0 direct dev',
      '@babel/parser@7.24.0 transitive prod',
      '@babel/plugin-syntax-jsx@7.24.0 transitive prod',
      '@octokit/rest@19.0.13 direct prod',
      'escape-string-regexp@1.0.5 transitive prod',
      'fsevents@2.3.3 direct optional',
      'istanbul@0.4.5 direct dev',
      'moment@2.29.4 direct prod',
      'request@2.88.2 direct prod',
      'tough-cookie@2.5.0 transitive prod',
      'uuid@3.4.0 transitive prod',
    ]);
    assert.deepEqual(parsed.warnings, []);
  });

  test('parsePnpmKey handles every key dialect, peer suffix and alias', () => {
    assert.deepEqual(parsePnpmKey('/foo/1.2.3'), { kind: 'package', name: 'foo', version: '1.2.3' });
    assert.deepEqual(parsePnpmKey('/@scope/foo/1.2.3'), {
      kind: 'package',
      name: '@scope/foo',
      version: '1.2.3',
    });
    assert.deepEqual(parsePnpmKey('/foo@1.2.3'), { kind: 'package', name: 'foo', version: '1.2.3' });
    assert.deepEqual(parsePnpmKey('foo@1.2.3'), { kind: 'package', name: 'foo', version: '1.2.3' });
    assert.deepEqual(parsePnpmKey('@scope/foo@1.2.3'), {
      kind: 'package',
      name: '@scope/foo',
      version: '1.2.3',
    });

    // The peer-suffixed keys, in both encodings.
    assert.deepEqual(parsePnpmKey('foo@1.2.3(bar@2.0.0)'), {
      kind: 'package',
      name: 'foo',
      version: '1.2.3',
    });
    assert.deepEqual(parsePnpmKey('/foo@1.2.3(bar@2.0.0)(baz@3.0.0)'), {
      kind: 'package',
      name: 'foo',
      version: '1.2.3',
    });
    assert.deepEqual(parsePnpmKey('/foo/1.2.3_bar@2.0.0'), {
      kind: 'package',
      name: 'foo',
      version: '1.2.3',
    });

    // Aliases resolve to the package that is actually installed.
    assert.deepEqual(parsePnpmKey('left-pad@npm:pad-left@1.0.0'), {
      kind: 'package',
      name: 'pad-left',
      version: '1.0.0',
    });

    // Things inside the project are not dependencies.
    assert.deepEqual(parsePnpmKey('link:packages/tools'), { kind: 'local' });
    assert.deepEqual(parsePnpmKey('file:../vendor/thing'), { kind: 'local' });

    assert.deepEqual(parsePnpmKey(''), { kind: 'unknown' });
    assert.deepEqual(parsePnpmKey('nonsense'), { kind: 'unknown' });
  });

  test('a peer-suffixed key parses through the whole file, once', async () => {
    const path = await project(
      'pnpm-peer',
      {
        'package.json': JSON.stringify({
          name: 'peer-example',
          dependencies: { foo: '^1.2.3' },
        }),
        'pnpm-lock.yaml': [
          "lockfileVersion: '9.0'",
          '',
          'importers:',
          '',
          '  .:',
          '    dependencies:',
          '      foo:',
          '        specifier: ^1.2.3',
          '        version: 1.2.3(bar@2.0.0)',
          '',
          'packages:',
          '',
          '  foo@1.2.3:',
          '    resolution: {integrity: sha512-aaa}',
          '',
          '  bar@2.0.0:',
          '    resolution: {integrity: sha512-bbb}',
          '',
          'snapshots:',
          '',
          "  'foo@1.2.3(bar@2.0.0)':",
          '    dependencies:',
          '      bar: 2.0.0',
          '',
          '  bar@2.0.0: {}',
          '',
        ].join('\n'),
      },
      'pnpm-lock.yaml',
    );

    const parsed = await parseLockfile(path);
    assert.deepEqual(summarise(parsed), ['bar@2.0.0 transitive prod', 'foo@1.2.3 direct prod']);
    assert.deepEqual(parsed.warnings, []);
  });
});

describe('yarn lockfiles', () => {
  test('classic: bespoke grammar, scope from the sibling manifest', async () => {
    const parsed = await parseLockfile(fixture('yarn-v1', 'yarn.lock'));

    assert.equal(parsed.format, 'yarn-v1');
    // Yarn records no dev/prod-ness at all, so every transitive entry is prod
    // and the direct ones take their scope from package.json.
    assert.deepEqual(summarise(parsed), [
      '@babel/core@7.24.0 direct dev',
      '@babel/parser@7.24.0 transitive prod',
      '@octokit/rest@19.0.13 direct prod',
      'escape-string-regexp@1.0.5 transitive prod',
      'fsevents@2.3.3 direct optional',
      'istanbul@0.4.5 direct dev',
      'moment@2.29.4 direct prod',
      'request@2.88.2 direct prod',
      'tough-cookie@2.5.0 transitive prod',
      'uuid@3.4.0 transitive prod',
    ]);
    assert.deepEqual(parsed.warnings, []);
  });

  test('berry: YAML dialect, patch/workspace protocols dropped', async () => {
    const parsed = await parseLockfile(fixture('yarn-berry', 'yarn.lock'));

    assert.equal(parsed.format, 'yarn-berry');
    assert.deepEqual(summarise(parsed), [
      '@babel/core@7.24.0 direct dev',
      '@babel/parser@7.24.0 transitive prod',
      '@octokit/rest@19.0.13 direct prod',
      'escape-string-regexp@1.0.5 transitive prod',
      'fsevents@2.3.3 direct optional',
      'istanbul@0.4.5 direct dev',
      'moment@2.29.4 direct prod',
      'request@2.88.2 direct prod',
      'tough-cookie@2.5.0 transitive prod',
      'uuid@3.4.0 transitive prod',
    ]);
    // `example-app@workspace:.` is the project itself and
    // `tough-cookie@patch:…` duplicates a package already listed.
    assert.deepEqual(parsed.warnings, []);
  });

  test('descriptors split on the first @ after the scope', () => {
    assert.deepEqual(splitDescriptor('moment@^2.29.4'), { name: 'moment', range: '^2.29.4' });
    assert.deepEqual(splitDescriptor('"@babel/core@npm:^7.24.0"'), {
      name: '@babel/core',
      range: 'npm:^7.24.0',
    });
    // A second @ inside the range must not become the split point.
    assert.deepEqual(splitDescriptor('tough-cookie@patch:tough-cookie@npm%3A2.5.0#~/p.patch'), {
      name: 'tough-cookie',
      range: 'patch:tough-cookie@npm%3A2.5.0#~/p.patch',
    });
    assert.deepEqual(splitDescriptor('foo@git+ssh://git@github.com/o/r.git'), {
      name: 'foo',
      range: 'git+ssh://git@github.com/o/r.git',
    });
  });

  test('a key line splits on commas outside quotes only', () => {
    assert.deepEqual(splitDescriptors('escape-string-regexp@^1.0.2, escape-string-regexp@^1.0.5'), [
      'escape-string-regexp@^1.0.2',
      'escape-string-regexp@^1.0.5',
    ]);
    assert.deepEqual(splitDescriptors('foo@">=1, <2", bar@^1'), ['foo@">=1, <2"', 'bar@^1']);
  });
});

describe('package.json with no lockfile', () => {
  test('every declared range is direct, and local references are dropped', async () => {
    const parsed = await parseLockfile(fixture('package-json', 'package.json'));

    assert.equal(parsed.format, 'package-json');
    assert.deepEqual(summarise(parsed), [
      '@babel/core@^7.24.0 direct dev',
      '@octokit/rest@^19.0.13 direct prod',
      'fsevents@^2.3.3 direct optional',
      'istanbul@^0.4.5 direct dev',
      'moment@^2.29.4 direct prod',
      'react@>=17 direct peer',
      'request@^2.88.2 direct prod',
    ]);
    // `local-helper` is `file:./vendor/local-helper`: not a registry package.
    assert.equal(
      parsed.dependencies.some((dep) => dep.name === 'local-helper'),
      false,
    );
    assert.deepEqual(parsed.warnings, []);
  });

  test('a manifest with no dependencies warns rather than throwing', async () => {
    const path = await project(
      'bare-manifest',
      { 'package.json': JSON.stringify({ name: 'nothing', version: '1.0.0' }) },
      'package.json',
    );

    const parsed = await parseLockfile(path);
    assert.deepEqual(parsed.dependencies, []);
    assert.equal(parsed.warnings.length, 1);
    assert.match(parsed.warnings[0] ?? '', /declares no dependencies/);
  });
});

// ---------------------------------------------------------------------------
// Adversarial input
// ---------------------------------------------------------------------------

describe('malformed input degrades to warnings', () => {
  test('npm: a non-object entry and an unusable key are warned about, not fatal', async () => {
    const parsed = await parseLockfile(fixture('malformed', 'package-lock.json'));

    assert.equal(parsed.format, 'npm-v3');
    assert.deepEqual(summarise(parsed), [
      '@babel/core@7.24.0 direct dev',
      'moment@2.29.4 direct prod',
    ]);

    assert.equal(parsed.warnings.length, 2);
    assert.ok(
      parsed.warnings.some((w) => w.includes('node_modules/request') && w.includes('not an object')),
      `expected a warning about the string entry, got ${JSON.stringify(parsed.warnings)}`,
    );
    assert.ok(
      parsed.warnings.some((w) => w.includes('could not derive a package name')),
      `expected a warning about the empty key, got ${JSON.stringify(parsed.warnings)}`,
    );
  });

  test('yarn classic: a line that is not a descriptor warns and parsing continues', async () => {
    const parsed = await parseLockfile(fixture('malformed', 'yarn.lock'));

    assert.equal(parsed.format, 'yarn-v1');
    // Everything after the bad line is still parsed, and `resolved-only` keeps
    // its identity even though the entry pins no version.
    assert.deepEqual(summarise(parsed), [
      '@babel/core@7.24.0 direct dev',
      'moment@2.29.4 direct prod',
      'request@2.88.2 direct prod',
      'resolved-only@- transitive prod',
    ]);

    assert.equal(parsed.warnings.length, 2);
    assert.ok(
      parsed.warnings.some((w) => /expected a descriptor line ending in ":"/.test(w)),
      `expected a warning about the stray line, got ${JSON.stringify(parsed.warnings)}`,
    );
    assert.ok(
      parsed.warnings.some((w) => w.includes('no-version') && w.includes('has no version')),
      `expected a warning about the versionless entry, got ${JSON.stringify(parsed.warnings)}`,
    );
    // Warnings must be locatable: each one names the line it came from.
    for (const warning of parsed.warnings) assert.match(warning, /^line \d+:/);
  });

  test('a lockfile with no sibling manifest warns and reports everything transitive', async () => {
    const path = await project(
      'orphan-lock',
      {
        'package-lock.json': JSON.stringify({
          name: 'orphan',
          lockfileVersion: 1,
          dependencies: { moment: { version: '2.29.4' } },
        }),
      },
      'package-lock.json',
    );

    const parsed = await parseLockfile(path);
    assert.deepEqual(summarise(parsed), ['moment@2.29.4 transitive prod']);
    assert.ok(
      parsed.warnings.some((w) => w.includes('package.json') && w.includes('not found')),
      `expected a missing-manifest warning, got ${JSON.stringify(parsed.warnings)}`,
    );
  });

  test('a lockfileVersion from the future parses as v3 and says so', async () => {
    const path = await project(
      'future-lock',
      {
        'package.json': JSON.stringify({ name: 'future', dependencies: { moment: '^2.29.4' } }),
        'package-lock.json': JSON.stringify({
          name: 'future',
          lockfileVersion: 9,
          packages: {
            '': { name: 'future', dependencies: { moment: '^2.29.4' } },
            'node_modules/moment': { version: '2.29.4' },
          },
        }),
      },
      'package-lock.json',
    );

    const parsed = await parseLockfile(path);
    assert.equal(parsed.format, 'npm-v3');
    assert.deepEqual(summarise(parsed), ['moment@2.29.4 direct prod']);
    assert.ok(
      parsed.warnings.some((w) => w.includes('newer than this tool understands')),
      `expected a version warning, got ${JSON.stringify(parsed.warnings)}`,
    );
  });

  test('an unusable top-level structure throws with the path in the message', async () => {
    const path = await project(
      'not-an-object',
      { 'package-lock.json': '["definitely", "not", "a", "lockfile"]' },
      'package-lock.json',
    );

    await assert.rejects(parseLockfile(path), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /cannot parse/);
      assert.ok(error.message.includes(path), `message should name the file: ${error.message}`);
      return true;
    });
  });

  test('invalid JSON throws rather than reporting an empty project', async () => {
    const path = await project(
      'broken-json',
      { 'package-lock.json': '{ "lockfileVersion": 3, ' },
      'package-lock.json',
    );
    await assert.rejects(parseLockfile(path), /invalid JSON/);
  });

  test('a missing file throws', async () => {
    await assert.rejects(parseLockfile(join(scratch, 'nope', 'yarn.lock')), /cannot read/);
  });
});

// ---------------------------------------------------------------------------
// Content sniffing
// ---------------------------------------------------------------------------

describe('dispatch by content when the filename is unfamiliar', () => {
  const cases: ReadonlyArray<readonly [string, string, LockfileFormat]> = [
    ['yarn-classic.bak', join('yarn-v1', 'yarn.lock'), 'yarn-v1'],
    ['yarn-berry.bak', join('yarn-berry', 'yarn.lock'), 'yarn-berry'],
    ['pnpm.bak', join('pnpm-v9', 'pnpm-lock.yaml'), 'pnpm'],
    ['npm.bak', join('npm-v3', 'package-lock.json'), 'npm-v3'],
  ];

  for (const [name, source, format] of cases) {
    test(`${name} is recognised as ${format}`, async () => {
      const { readFile } = await import('node:fs/promises');
      const body = await readFile(fixture(source), 'utf8');
      const dir = join(scratch, 'sniff', format);
      await mkdir(dir, { recursive: true });
      const path = join(dir, name);
      await writeFile(path, body, 'utf8');

      const parsed = await parseLockfile(path);
      assert.equal(parsed.format, format);
      assert.ok(parsed.dependencies.length > 0, 'expected the copy to parse into dependencies');
    });
  }

  test('an unrecognisable file is refused', async () => {
    const path = await project('gibberish', { 'thing.bak': 'hello, world\n' }, 'thing.bak');
    await assert.rejects(parseLockfile(path), /unrecognised lockfile format/);
  });
});
