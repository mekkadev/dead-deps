/**
 * Integrity of the curated succession dataset.
 *
 * These assertions run against the real `data/successors.yaml`, not a fixture:
 * the file is hand-edited by contributors, and a typo in it is a wrong
 * recommendation shipped to users. Everything checked here is something a
 * reviewer would otherwise have to notice by eye.
 *
 * The suite skips itself when the dataset is absent, so a checkout that has not
 * got the file yet still gets a green run.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  DEFAULT_DATASET_PATH,
  loadSuccessors,
  lookupSuccessor,
} from '../src/successors/index.js';
import type { SuccessorDataset, SuccessorRecord } from '../src/types.js';

/**
 * npm's own rule, minus the length cap: lowercase, optionally scoped, no
 * spaces. A `to` that fails this would be an uninstallable recommendation.
 */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

const SUCCESSION_TYPES = new Set([
  'fork',
  'rename',
  'replacement',
  'absorbed',
  'self-declared',
  'reimplementation',
]);

const DATASET_PRESENT = existsSync(DEFAULT_DATASET_PATH);

let dataset: SuccessorDataset | null = null;
let scratch: string;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dead-deps-successors-'));
  if (DATASET_PRESENT) dataset = await loadSuccessors();
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** `null` plus a skip note, or the loaded dataset. */
function require_(t: { skip: (reason?: string) => void }): SuccessorDataset | null {
  if (dataset === null) {
    t.skip(`${DEFAULT_DATASET_PATH} does not exist yet`);
    return null;
  }
  return dataset;
}

function where(record: SuccessorRecord): string {
  return `row "${record.from}"`;
}

describe('data/successors.yaml', () => {
  test('parses, and is not empty', (t) => {
    const ds = require_(t);
    if (ds === null) return;

    assert.ok(ds.records.length > 0, 'the dataset should contain at least one row');
    assert.equal(ds.byFrom.size, ds.records.length);
  });

  test('every "from" is unique, case-insensitively', (t) => {
    const ds = require_(t);
    if (ds === null) return;

    const seen = new Map<string, string>();
    for (const record of ds.records) {
      const key = record.from.trim().toLowerCase();
      const previous = seen.get(key);
      assert.equal(
        previous,
        undefined,
        `"${record.from}" is covered twice (also as "${previous ?? ''}"); merge the rows`,
      );
      seen.set(key, record.from);
    }
  });

  test('every row validates against the schema', (t) => {
    const ds = require_(t);
    if (ds === null) return;

    for (const record of ds.records) {
      assert.notEqual(record.from.trim(), '', 'a row with no "from" is unusable');
      assert.ok(SUCCESSION_TYPES.has(record.type), `${where(record)}: unknown type "${record.type}"`);
      assert.ok(
        ['high', 'medium', 'low'].includes(record.confidence),
        `${where(record)}: unknown confidence "${record.confidence}"`,
      );
      assert.equal(typeof record.dropIn, 'boolean', `${where(record)}: dropIn must be a boolean`);
      assert.ok(Array.isArray(record.alternatives), `${where(record)}: alternatives must be a list`);
      assert.notEqual(record.notes.trim(), '', `${where(record)}: notes are rendered on the site`);
      if (record.since !== null) {
        assert.match(record.since, /^\d{4}-(?:0[1-9]|1[0-2])$/, `${where(record)}: bad "since"`);
      }
      if (record.migration !== null) {
        assert.notEqual(record.migration.trim(), '', `${where(record)}: empty migration hint`);
      }
    }
  });

  test('"to" is null, an installable package name, or a named platform feature', (t) => {
    const ds = require_(t);
    if (ds === null) return;

    for (const record of ds.records) {
      switch (record.toKind) {
        case 'package':
          assert.ok(record.to !== null, `${where(record)}: toKind "package" needs a "to"`);
          assert.match(
            record.to ?? '',
            NPM_NAME,
            `${where(record)}: "${record.to ?? ''}" is not an installable npm name`,
          );
          break;
        case 'platform':
          // Deliberately *not* an npm name: the fix is deleting the dependency.
          assert.ok(record.to !== null, `${where(record)}: toKind "platform" needs a "to"`);
          assert.notEqual((record.to ?? '').trim(), '', `${where(record)}: empty platform successor`);
          assert.equal(
            record.dropIn,
            false,
            `${where(record)}: nothing to swap in when the successor is a platform feature`,
          );
          break;
        case 'none':
          assert.equal(record.to, null, `${where(record)}: toKind "none" must have a null "to"`);
          assert.equal(record.dropIn, false, `${where(record)}: nothing to swap in`);
          break;
        default:
          assert.fail(`${where(record)}: unknown toKind "${String(record.toKind)}"`);
      }
    }
  });

  test('every alternative is a plausible npm package name', (t) => {
    const ds = require_(t);
    if (ds === null) return;

    for (const record of ds.records) {
      for (const alternative of record.alternatives) {
        assert.match(alternative, NPM_NAME, `${where(record)}: alternative "${alternative}"`);
      }
    }
  });

  test('no package succeeds itself', (t) => {
    const ds = require_(t);
    if (ds === null) return;

    for (const record of ds.records) {
      const self = record.from.trim().toLowerCase();
      assert.notEqual(
        record.to?.trim().toLowerCase(),
        self,
        `${where(record)}: a package cannot be its own successor`,
      );
      for (const alternative of record.alternatives) {
        assert.notEqual(
          alternative.trim().toLowerCase(),
          self,
          `${where(record)}: listed as its own alternative`,
        );
      }
      // Repeating `to` under `alternatives` reads as two options where there is
      // only one.
      const duplicated = record.alternatives.filter(
        (alternative) => alternative.trim().toLowerCase() === record.to?.trim().toLowerCase(),
      );
      assert.deepEqual(duplicated, [], `${where(record)}: "${record.to ?? ''}" is also an alternative`);
    }
  });

  test('every evidence entry points at an absolute https URL', (t) => {
    const ds = require_(t);
    if (ds === null) return;

    for (const record of ds.records) {
      assert.ok(record.evidence.length > 0, `${where(record)}: at least one source is required`);
      for (const item of record.evidence) {
        assert.notEqual(item.label.trim(), '', `${where(record)}: evidence with no label`);
        assert.ok(URL.canParse(item.url), `${where(record)}: "${item.url}" is not a URL`);
        assert.equal(
          new URL(item.url).protocol,
          'https:',
          `${where(record)}: "${item.url}" must be https`,
        );
      }
    }
  });
});

describe('lookupSuccessor', () => {
  test('finds a known row, however it is cased', (t) => {
    const ds = require_(t);
    if (ds === null) return;

    const known = ds.records[0];
    assert.ok(known !== undefined);

    assert.equal(lookupSuccessor(ds, known.from), known);
    assert.equal(lookupSuccessor(ds, known.from.toUpperCase()), known);
    assert.equal(lookupSuccessor(ds, `  ${known.from}  `), known);
  });

  test('returns null for a package nobody has curated', (t) => {
    const ds = require_(t);
    if (ds === null) return;

    assert.equal(lookupSuccessor(ds, 'definitely-not-in-the-dataset-9f3a'), null);
    assert.equal(lookupSuccessor(ds, ''), null);
    assert.equal(lookupSuccessor(ds, '   '), null);
  });

  test('an ambiguous bare name is not guessed at', async () => {
    const path = join(scratch, 'ambiguous.yaml');
    await writeFile(
      path,
      [
        '- from: "@a/parser"',
        '  to: a-parser-ng',
        '  toKind: package',
        '  type: fork',
        '  confidence: high',
        '  since: "2021-01"',
        '  dropIn: true',
        '  alternatives: []',
        '  notes: One of two rows that share a bare name.',
        '  migration: null',
        '  evidence:',
        '    - label: Announcement',
        '      url: https://example.com/a',
        '- from: "@b/parser"',
        '  to: b-parser-ng',
        '  toKind: package',
        '  type: fork',
        '  confidence: high',
        '  since: "2021-01"',
        '  dropIn: true',
        '  alternatives: []',
        '  notes: The other one.',
        '  migration: null',
        '  evidence:',
        '    - label: Announcement',
        '      url: https://example.com/b',
        '',
      ].join('\n'),
      'utf8',
    );

    const ds = await loadSuccessors(path);
    assert.equal(lookupSuccessor(ds, '@a/parser')?.to, 'a-parser-ng');
    // Two rows share the bare name `parser`; recommending either would be a
    // coin flip, so the answer is nothing.
    assert.equal(lookupSuccessor(ds, 'parser'), null);
    assert.equal(lookupSuccessor(ds, '@c/parser'), null);
  });

  test('a scope-insensitive match is used when it is unambiguous', async () => {
    const path = join(scratch, 'scoped.yaml');
    await writeFile(
      path,
      [
        '- from: faker',
        '  to: "@faker-js/faker"',
        '  toKind: package',
        '  type: fork',
        '  confidence: high',
        '  since: "2022-01"',
        '  dropIn: false',
        '  alternatives: []',
        '  notes: The community forked it after the original was unpublished.',
        '  migration: null',
        '  evidence:',
        '    - label: Fork announcement',
        '      url: https://example.com/faker',
        '',
      ].join('\n'),
      'utf8',
    );

    const ds = await loadSuccessors(path);
    assert.equal(lookupSuccessor(ds, '@types/faker')?.to, '@faker-js/faker');
  });
});

describe('loader validation', () => {
  async function reject(name: string, body: string, pattern: RegExp): Promise<void> {
    const path = join(scratch, name);
    await writeFile(path, body, 'utf8');
    await assert.rejects(loadSuccessors(path), pattern);
  }

  const VALID = [
    '- from: request',
    '  to: undici',
    '  toKind: package',
    '  type: replacement',
    '  confidence: high',
    '  since: "2020-02"',
    '  dropIn: false',
    '  alternatives: [got]',
    '  notes: Deprecated in 2020.',
    '  migration: null',
    '  evidence:',
    '    - label: Maintainer announcement',
    '      url: https://github.com/request/request/issues/3142',
  ];

  test('a duplicate "from" is refused, naming both rows', async () => {
    await reject('dupes.yaml', [...VALID, ...VALID].join('\n'), /duplicate "from"/);
  });

  test('an unknown field is refused with a suggestion', async () => {
    const body = [...VALID, '  dropin: true'].join('\n');
    await reject('typo.yaml', body, /did you mean "dropIn"/);
  });

  test('a relative evidence URL is refused', async () => {
    const body = VALID.map((line) =>
      line.includes('https://github.com') ? '      url: /request/issues/3142' : line,
    ).join('\n');
    await reject('relative.yaml', body, /absolute http\(s\) URL/);
  });

  test('a package that succeeds itself is refused', async () => {
    const body = VALID.map((line) => (line.startsWith('  to:') ? '  to: request' : line)).join('\n');
    await reject('self.yaml', body, /cannot succeed itself/);
  });

  test('a "to" without a "toKind" defaults sensibly rather than failing', async () => {
    const path = join(scratch, 'no-kind.yaml');
    await writeFile(path, VALID.filter((line) => !line.startsWith('  toKind:')).join('\n'), 'utf8');

    const ds = await loadSuccessors(path);
    assert.equal(ds.records[0]?.toKind, 'package');
  });

  test('a missing dataset at an explicitly requested path is an error', async () => {
    await assert.rejects(
      loadSuccessors(join(scratch, 'does-not-exist.yaml')),
      /Cannot read succession dataset/,
    );
  });
});
