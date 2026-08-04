/**
 * The codemod, which is the only part of dead-deps that writes to files the
 * user did not ask us to create.
 *
 * That makes this the suite that matters most, and it is written against the
 * governing rule of `src/fix.ts` rather than against its implementation: a
 * refusal is always cheaper than a bad edit. So the assertions come in pairs —
 * for every "this is rewritten" there is a "and this, which looks almost the
 * same, is not". The near-misses are the point. `rollup-plugin-commonjs-extra`
 * shares twenty-two characters with `rollup-plugin-commonjs`, and a codemod
 * that matched substrings would silently corrupt a stranger's build for a
 * package it was never asked to touch.
 *
 * Everything runs against real files in a temp directory, because the two
 * properties worth proving — that `planFixes` writes nothing, and that a
 * rewritten `package.json` is byte-for-byte the original with one key changed —
 * are only observable on disk.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, it } from 'node:test';

import { applyFixes, planFixes } from '../src/fix.js';
import type { FixPlan } from '../src/fix.js';
import type { Finding, SuccessorRecord } from '../src/types.js';
import { dependency, finding, scanResult, successor } from './helpers.js';

const ROOT = mkdtempSync(join(tmpdir(), 'dead-deps-fix-'));

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** The rename this whole module exists for. */
const FROM = 'rollup-plugin-commonjs';
const TO = '@rollup/plugin-commonjs';
/** A different package whose name begins with the one above. */
const NEIGHBOUR = 'rollup-plugin-commonjs-extra';

async function project(name: string, files: Record<string, string>): Promise<string> {
  const dir = join(ROOT, name);
  await mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const full = join(dir, file);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  return dir;
}

/** Every file under `dir`, with its bytes and its mtime. */
async function tree(dir: string): Promise<Array<[string, string, number]>> {
  const out: Array<[string, string, number]> = [];

  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      out.push([relative(dir, full), await readFile(full, 'utf8'), (await stat(full)).mtimeMs]);
    }
  }

  await walk(dir);
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function reasons(plan: FixPlan): Map<string, string> {
  return new Map(plan.skipped.map((entry) => [entry.name, entry.reason]));
}

/** A finding whose curated row clears every gate in `refuseFinding`. */
function mechanical(from: string, to: string, overrides: Partial<SuccessorRecord> = {}): Finding {
  return finding({
    dependency: dependency({ name: from }),
    successor: successor({
      from,
      to,
      toKind: 'package',
      type: 'rename',
      confidence: 'high',
      dropIn: true,
      ...overrides,
    }),
  });
}

function plan(dir: string, findings: Finding[]): Promise<FixPlan> {
  return planFixes(scanResult({ findings }), dir);
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('what is safe to fix automatically', () => {
  it('plans only high-confidence drop-in package renames and explains every refusal', async () => {
    const dir = await project('gate', {
      'package.json': ['{', '  "dependencies": {', `    "${FROM}": "^9.1.8"`, '  }', '}', ''].join('\n'),
    });

    const findings: Finding[] = [
      mechanical(FROM, TO),
      // A fork is drop-in and high confidence and is still refused: it is a
      // change of maintainer as well as of name, and that is the user's call.
      finding({
        dependency: dependency({ name: 'faker' }),
        successor: successor({ from: 'faker', to: '@faker-js/faker', type: 'fork' }),
      }),
      finding({
        dependency: dependency({ name: 'request' }),
        successor: successor({ from: 'request', to: 'got', type: 'replacement', dropIn: false }),
      }),
      finding({
        dependency: dependency({ name: 'node-sass' }),
        successor: successor({ from: 'node-sass', to: 'sass', type: 'self-declared' }),
      }),
      // Not packages at all: the instruction is to delete the dependency.
      finding({
        dependency: dependency({ name: 'left-pad' }),
        successor: successor({
          from: 'left-pad',
          to: 'String.prototype.padStart',
          toKind: 'platform',
          type: 'absorbed',
        }),
      }),
      finding({
        dependency: dependency({ name: '@types/uuid' }),
        successor: successor({
          from: '@types/uuid',
          to: 'uuid',
          toKind: 'bundled',
          type: 'absorbed',
        }),
      }),
      finding({
        dependency: dependency({ name: 'casperjs' }),
        successor: successor({ from: 'casperjs', to: null, toKind: 'none', type: 'replacement' }),
      }),
      mechanical('cuid', '@paralleldrive/cuid2', { confidence: 'medium' }),
      mechanical('shortid', 'nanoid', { dropIn: false }),
      finding({ dependency: dependency({ name: 'mystery' }), successor: null }),
      // A perfect curated row, refused because nothing here declares it: the
      // rename belongs to whichever package does.
      finding({
        dependency: dependency({ name: 'har-validator', direct: false }),
        successor: successor({
          from: 'har-validator',
          to: '@har/validator',
          toKind: 'package',
          type: 'rename',
          confidence: 'high',
          dropIn: true,
        }),
      }),
    ];

    const result = await plan(dir, findings);

    assert.deepEqual(
      result.edits.map((edit) => edit.from),
      [FROM],
    );
    assert.deepEqual(
      result.edits.map((edit) => edit.kind),
      ['manifest'],
    );

    const why = reasons(result);
    assert.equal(why.size, findings.length - 1, 'every finding is either planned or explained');
    assert.equal(why.get(FROM), undefined);
    for (const [name, reason] of why) {
      assert.ok(reason.trim().length > 0, `${name} was refused without a reason`);
    }

    assert.match(why.get('faker') ?? '', /"fork"/);
    assert.match(why.get('request') ?? '', /not recorded as a drop-in replacement/);
    assert.match(why.get('node-sass') ?? '', /"self-declared"/);
    assert.match(why.get('left-pad') ?? '', /platform \(String\.prototype\.padStart\)/);
    assert.match(why.get('@types/uuid') ?? '', /uuid now carries this itself/);
    assert.match(why.get('casperjs') ?? '', /nothing credible succeeded it/);
    assert.match(why.get('cuid') ?? '', /only medium confidence/);
    assert.match(why.get('shortid') ?? '', /not recorded as a drop-in replacement/);
    assert.match(why.get('mystery') ?? '', /no curated successor/);
    assert.match(why.get('har-validator') ?? '', /transitive dependency/);
  });
});

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------

const FOUR_SPACE = [
  '{',
  '    "name": "format-demo",',
  '    "version": "2.3.4",',
  '    "devDependencies": {',
  '        "left-pad": "^1.3.0",',
  `        "${FROM}": "~9.1.8",`,
  '        "rollup": "^2.79.0"',
  '    },',
  '    "peerDependencies": {',
  `        "${FROM}": ">=9.0.0"`,
  '    }',
  '}',
  '',
].join('\n');

const TABBED = [
  '{',
  '\t"name": "tabbed-demo",',
  '\t"dependencies": {',
  `\t\t"${FROM}": "^9.1.8"`,
  '\t}',
  '}',
].join('\n');

describe('rewriting package.json', () => {
  it('replaces the key in place, keeping the range operator, the indentation and the trailing newline', async () => {
    const dir = await project('manifest-four-space', { 'package.json': FOUR_SPACE });

    const result = await plan(dir, [mechanical(FROM, TO)]);
    assert.deepEqual(result.skipped, []);
    assert.equal(result.edits.length, 1);

    assert.deepEqual(await applyFixes(result), [join(dir, 'package.json')]);
    const applied = await readFile(join(dir, 'package.json'), 'utf8');

    // The whole file, byte for byte, with two keys changed and nothing else.
    // A JSON.parse/stringify round trip would pass every assertion below and
    // still hand the user a diff they did not ask for, so this is an exact
    // comparison rather than a structural one.
    assert.equal(applied, FOUR_SPACE.split(`"${FROM}"`).join(`"${TO}"`));

    // Called out individually so a failure says which property broke.
    assert.ok(applied.endsWith('}\n'), 'the trailing newline must survive');
    assert.match(applied, /\n {8}"@rollup\/plugin-commonjs": "~9\.1\.8",\n/);
    assert.match(applied, /"@rollup\/plugin-commonjs": ">=9\.0\.0"/);
    assert.ok(!applied.includes(`"${FROM}"`), 'both declarations are renamed, not one');
    assert.match(applied, /"left-pad": "\^1\.3\.0"/);
  });

  it('leaves a file that never ended in a newline without one', async () => {
    const dir = await project('manifest-tabbed', { 'package.json': TABBED });

    const result = await plan(dir, [mechanical(FROM, TO)]);
    await applyFixes(result);

    const applied = await readFile(join(dir, 'package.json'), 'utf8');
    assert.equal(applied, TABBED.split(`"${FROM}"`).join(`"${TO}"`));
    assert.ok(!applied.endsWith('\n'), 'a newline nobody wrote must not appear');
    assert.match(applied, /\n\t\t"@rollup\/plugin-commonjs": "\^9\.1\.8"\n/);
  });

  it('refuses a version range that cannot be carried across the rename', async () => {
    for (const spec of ['npm:@rollup/plugin-commonjs@^9.1.8', '^1.0.0 || ^2.0.0', 'workspace:*']) {
      const dir = await project(`manifest-range-${spec.replace(/[^a-z0-9]+/gi, '-')}`, {
        'package.json': `{\n  "dependencies": {\n    "${FROM}": "${spec}"\n  }\n}\n`,
      });

      const result = await plan(dir, [mechanical(FROM, TO)]);
      assert.deepEqual(result.edits, [], `${spec} must not be rewritten`);
      assert.match(reasons(result).get(FROM) ?? '', /not a plain semver range/);
    }
  });

  it('refuses when the manifest already declares the successor', async () => {
    const dir = await project('manifest-collision', {
      'package.json': `{\n  "dependencies": {\n    "${FROM}": "^9.1.8",\n    "${TO}": "^25.0.0"\n  }\n}\n`,
    });

    const result = await plan(dir, [mechanical(FROM, TO)]);
    assert.deepEqual(result.edits, []);
    assert.match(reasons(result).get(FROM) ?? '', /already depends on @rollup\/plugin-commonjs/);
  });

  it('refuses when the root manifest does not declare the package at all', async () => {
    const dir = await project('manifest-absent', {
      'package.json': '{\n  "dependencies": {\n    "left-pad": "^1.3.0"\n  }\n}\n',
    });

    const result = await plan(dir, [mechanical(FROM, TO)]);
    assert.deepEqual(result.edits, []);
    assert.match(reasons(result).get(FROM) ?? '', /does not declare it/);
  });
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const CONFIG_BEFORE = [
  `import commonjs from '${FROM}';`,
  `import extra from '${NEIGHBOUR}';`,
  '',
  `// ${FROM} moved to ${TO} in 2019.`,
  `const advice = 'tell the team about ${FROM} when you get a chance';`,
  `const lazy = () => import('${FROM}');`,
  '',
  'export default { plugins: [commonjs(), extra()], advice, lazy };',
  '',
].join('\n');

const CONFIG_AFTER = [
  `import commonjs from '${TO}';`,
  `import extra from '${NEIGHBOUR}';`,
  '',
  `// ${FROM} moved to ${TO} in 2019.`,
  `const advice = 'tell the team about ${FROM} when you get a chance';`,
  `const lazy = () => import('${TO}');`,
  '',
  'export default { plugins: [commonjs(), extra()], advice, lazy };',
  '',
].join('\n');

const LEGACY_BEFORE = [
  `const commonjs = require('${FROM}');`,
  `const where = require.resolve('${FROM}');`,
  `const extra = require('${NEIGHBOUR}');`,
  '',
  'module.exports = { commonjs, where, extra };',
  '',
].join('\n');

const LEGACY_AFTER = [
  `const commonjs = require('${TO}');`,
  `const where = require.resolve('${TO}');`,
  `const extra = require('${NEIGHBOUR}');`,
  '',
  'module.exports = { commonjs, where, extra };',
  '',
].join('\n');

describe('rewriting imports', () => {
  it('rewrites exact specifiers and nothing that merely looks like one', async () => {
    const dir = await project('imports', {
      'package.json': `{\n  "dependencies": {\n    "${FROM}": "^9.1.8"\n  }\n}\n`,
      'rollup.config.js': CONFIG_BEFORE,
      'tools/legacy.cjs': LEGACY_BEFORE,
    });

    const result = await plan(dir, [mechanical(FROM, TO)]);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(
      result.edits.map((edit) => edit.kind),
      ['manifest', 'import', 'import'],
    );

    assert.deepEqual(await applyFixes(result), [
      join(dir, 'package.json'),
      join(dir, 'rollup.config.js'),
      join(dir, 'tools', 'legacy.cjs'),
    ]);

    const config = await readFile(join(dir, 'rollup.config.js'), 'utf8');
    const legacy = await readFile(join(dir, 'tools', 'legacy.cjs'), 'utf8');

    assert.equal(config, CONFIG_AFTER);
    assert.equal(legacy, LEGACY_AFTER);

    // Spelled out, because these three are the whole reason the module lexes
    // instead of running a regular expression over the file.
    assert.match(config, /import extra from 'rollup-plugin-commonjs-extra';/);
    assert.ok(
      !config.includes('@rollup/plugin-commonjs-extra'),
      'a neighbouring package must never be touched',
    );
    assert.match(config, /'tell the team about rollup-plugin-commonjs when you get a chance'/);
    assert.match(config, /\/\/ rollup-plugin-commonjs moved to/);
  });

  it('refuses the whole package when one mention cannot be rewritten', async () => {
    const dir = await project('blocked-mention', {
      'package.json': `{\n  "dependencies": {\n    "${FROM}": "^9.1.8"\n  }\n}\n`,
      'src/index.js': `import commonjs from '${FROM}';\nexport default commonjs;\n`,
      'spec/build.spec.js': `jest.mock('${FROM}');\nit('builds', () => {});\n`,
    });
    const before = await tree(dir);

    const result = await plan(dir, [mechanical(FROM, TO)]);

    // Half a migration is worse than none, because it looks finished.
    assert.deepEqual(result.edits, []);
    const reason = reasons(result).get(FROM) ?? '';
    assert.match(reason, /somewhere that is not an import/);
    assert.match(reason, /spec\/build\.spec\.js:1/);
    assert.deepEqual(await tree(dir), before);
  });

  it('refuses a subpath import rather than inventing the successor’s layout', async () => {
    const dir = await project('blocked-subpath', {
      'package.json': `{\n  "dependencies": {\n    "${FROM}": "^9.1.8"\n  }\n}\n`,
      'src/deep.js': `import inner from '${FROM}/dist/index.js';\nexport default inner;\n`,
    });

    const result = await plan(dir, [mechanical(FROM, TO)]);
    assert.deepEqual(result.edits, []);
    assert.match(reasons(result).get(FROM) ?? '', /subpaths/);
  });

  it('refuses when a workspace member declares the package too', async () => {
    const dir = await project('workspace', {
      'package.json': `{\n  "dependencies": {\n    "${FROM}": "^9.1.8"\n  }\n}\n`,
      'packages/api/package.json': `{\n  "dependencies": {\n    "${FROM}": "^9.1.8"\n  }\n}\n`,
      'packages/api/src/index.js': `import commonjs from '${FROM}';\nexport default commonjs;\n`,
    });

    const result = await plan(dir, [mechanical(FROM, TO)]);
    assert.deepEqual(result.edits, []);
    assert.match(reasons(result).get(FROM) ?? '', /declares it as well/);
  });
});

// ---------------------------------------------------------------------------
// Lockfiles, and the purity of planning
// ---------------------------------------------------------------------------

const LOCKFILES: Record<string, string> = {
  'package-lock.json': JSON.stringify(
    {
      name: 'locked',
      lockfileVersion: 3,
      packages: { [`node_modules/${FROM}`]: { version: '9.1.8' } },
    },
    null,
    2,
  ),
  'yarn.lock': `# yarn lockfile v1\n\n"${FROM}@^9.1.8":\n  version "9.1.8"\n`,
  'pnpm-lock.yaml': `lockfileVersion: '9.0'\npackages:\n  ${FROM}@9.1.8: {}\n`,
};

describe('lockfiles', () => {
  it('never plans or writes one, even when it names the package', async () => {
    const dir = await project('locked', {
      'package.json': `{\n  "dependencies": {\n    "${FROM}": "^9.1.8"\n  }\n}\n`,
      'src/index.js': `import commonjs from '${FROM}';\nexport default commonjs;\n`,
      ...LOCKFILES,
    });

    const result = await plan(dir, [mechanical(FROM, TO)]);
    assert.equal(result.edits.length, 2);
    for (const edit of result.edits) {
      assert.ok(
        !Object.keys(LOCKFILES).some((name) => edit.file.endsWith(name)),
        `${edit.file} is a lockfile and must never be planned`,
      );
    }

    await applyFixes(result);
    for (const [name, content] of Object.entries(LOCKFILES)) {
      assert.equal(await readFile(join(dir, name), 'utf8'), content, `${name} was modified`);
    }
  });

  it('refuses a hand-assembled plan that targets one, and writes nothing', async () => {
    const dir = await project('hand-written-plan', {
      'package.json': `{\n  "dependencies": {\n    "${FROM}": "^9.1.8"\n  }\n}\n`,
      ...LOCKFILES,
    });
    const before = await tree(dir);

    for (const name of Object.keys(LOCKFILES)) {
      const file = join(dir, name);
      const forged: FixPlan = {
        edits: [
          {
            file,
            from: FROM,
            to: TO,
            kind: 'manifest',
            before: await readFile(file, 'utf8'),
            after: '{}',
          },
        ],
        skipped: [],
      };

      await assert.rejects(applyFixes(forged), /never writes lockfiles/);
    }

    assert.deepEqual(await tree(dir), before);
  });
});

describe('planFixes', () => {
  it('writes nothing at all', async () => {
    const dir = await project('pure', {
      'package.json': `{\n  "dependencies": {\n    "${FROM}": "^9.1.8"\n  }\n}\n`,
      'src/index.js': `import commonjs from '${FROM}';\nexport default commonjs;\n`,
      'src/unrelated.js': 'export const answer = 42;\n',
      'README.md': `# pure\n\nStill on ${FROM}.\n`,
    });

    const before = await tree(dir);
    const result = await plan(dir, [mechanical(FROM, TO)]);

    // The plan has real work in it, so "nothing changed" is a property of
    // planning rather than of an empty result.
    assert.equal(result.edits.length, 2);
    assert.ok(result.edits.every((edit) => edit.after !== edit.before));

    // Same bytes, same mtimes, same set of files: no temp file left behind.
    assert.deepEqual(await tree(dir), before);

    // And planning twice from the same disk state produces the same plan.
    const again = await plan(dir, [mechanical(FROM, TO)]);
    assert.deepEqual(again, result);
    assert.deepEqual(await tree(dir), before);
  });
});
