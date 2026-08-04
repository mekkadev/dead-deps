/**
 * The archive, and what reading it twice buys.
 *
 * Two halves, tested for two different kinds of failure.
 *
 * `store` is tested for *durability*. History cannot be bought or backfilled —
 * a week that was never sampled is gone for good — so the failure that matters
 * is not "returned the wrong answer", it is "lost the file". Everything here
 * therefore pushes damage at it: a torn line, a line that is valid JSON but not
 * a snapshot, a week written twice. The archive is allowed to skip a row; it is
 * never allowed to throw, and it is never allowed to duplicate.
 *
 * `trajectory` is tested for *restraint*. It is the only part of the tool that
 * makes a claim no upstream index can check, so the interesting cases are the
 * ones where it must decline: too few samples, and a dependent count that
 * collapsed because an importer was re-run rather than because anybody left.
 *
 * Nothing here touches the network or the repository's own `data/history`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  DEPENDENT_FLIGHT_SEVERE,
  MIN_SAMPLES_FOR_TRAJECTORY,
  computeTrajectory,
  summarise,
} from '../src/history/trajectory.js';
import type { HealthSnapshot } from '../src/types.js';
import { snapshot } from './helpers.js';

// ---------------------------------------------------------------------------
// A throwaway archive
// ---------------------------------------------------------------------------

const ARCHIVE = mkdtempSync(join(tmpdir(), 'dead-deps-history-'));

/**
 * `store` resolves its archive directory exactly once, at module load, from
 * this variable — the escape hatch its own documentation names. So it has to be
 * set before the module is imported, which is why the import below is dynamic
 * and memoised rather than static: a static import is hoisted above this
 * assignment, and the suite would then append its fixtures to the repository's
 * real `data/history`.
 */
process.env['DEAD_DEPS_HISTORY_DIR'] = ARCHIVE;

type Store = typeof import('../src/history/store.js');

let loading: Promise<Store> | null = null;

function store(): Promise<Store> {
  if (loading === null) loading = import('../src/history/store.js');
  return loading;
}

after(() => {
  rmSync(ARCHIVE, { recursive: true, force: true });
});

/**
 * Three different ISO weeks, seven days apart so they cannot collide however
 * the week boundary falls, plus a second day inside the last one.
 */
const WEEK_A = new Date('2026-06-03T09:00:00.000Z');
const WEEK_B = new Date('2026-06-10T09:00:00.000Z');
const WEEK_C = new Date('2026-06-17T09:00:00.000Z');
const WEEK_C_FRIDAY = new Date('2026-06-19T18:30:00.000Z');

function row(name: string, at: Date, overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return snapshot({ name, observedAt: at.toISOString(), ...overrides });
}

/** Lines of an archive file, with the trailing newline accounted for. */
function lines(text: string): string[] {
  assert.ok(text.endsWith('\n'), 'an archive file must end in a newline');
  return text.slice(0, -1).split('\n');
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

describe('the snapshot archive', () => {
  it('round-trips a week of snapshots through a temporary directory', async () => {
    const { HISTORY_DIR, appendSnapshots, isoWeekKey, readAllSnapshots, readSnapshotsFor, snapshotPath } =
      await store();

    // If this fails, something imported the module before the redirect above
    // and every write in this file is landing in the repository.
    assert.equal(HISTORY_DIR, ARCHIVE);

    // Every field populated: the point of a round-trip test is that nothing is
    // quietly dropped on the way through JSON.
    const zeta = row('zeta-a', WEEK_A, {
      state: 'abandoned',
      score: 91,
      latestReleaseAt: '2019-03-04T10:00:00.000Z',
      dependentPackagesCount: 1204,
      dependentReposCount: 88_301,
      downloadsLastMonth: 4_120_559,
      pastYearIssues: 61,
      pastYearIssuesClosed: 4,
      activeMaintainers: 0,
      openAdvisories: 2,
      developmentDistributionScore: 0.12,
    });
    const alpha = row('alpha-a', WEEK_A, {
      state: 'active',
      score: 3,
      latestReleaseAt: '2026-05-30T08:00:00.000Z',
      dependentPackagesCount: 42_000,
      dependentReposCount: 900_100,
      downloadsLastMonth: 91_000_000,
      pastYearIssues: 240,
      pastYearIssuesClosed: 231,
      activeMaintainers: 7,
      openAdvisories: 0,
      developmentDistributionScore: 0.81,
    });

    const file = await appendSnapshots([zeta, alpha], WEEK_A);
    assert.equal(file, snapshotPath(WEEK_A));
    assert.equal(basename(file), `${isoWeekKey(WEEK_A)}.ndjson`);
    assert.ok(file.startsWith(ARCHIVE), `${file} should live under the temp archive`);

    const text = await readFile(file, 'utf8');
    const written = lines(text);
    assert.equal(written.length, 2);

    // Sorted by package name, canonical field order: a re-run of the same facts
    // has to diff as nothing at all.
    const first = JSON.parse(written[0] ?? '');
    assert.equal(first.name, 'alpha-a');
    assert.deepEqual(Object.keys(first).slice(0, 4), ['name', 'observedAt', 'state', 'score']);

    const read = (await readAllSnapshots(ARCHIVE)).filter((entry) => entry.name.endsWith('-a'));
    assert.deepEqual(read, [alpha, zeta]);

    // npm folds case, so the archive does too.
    assert.deepEqual(await readSnapshotsFor('ALPHA-A', ARCHIVE), [alpha]);
    assert.deepEqual(await readSnapshotsFor('never-sampled', ARCHIVE), []);

    // Byte-stable: writing the same facts again must not touch the file.
    await appendSnapshots([zeta, alpha], WEEK_A);
    assert.equal(await readFile(file, 'utf8'), text);
  });

  it('skips a corrupt line instead of throwing the rest of the file away', async () => {
    const { appendSnapshots, readAllSnapshots } = await store();

    const good = row('good-b', WEEK_B, { score: 12 });
    const alsoGood = row('also-good-b', WEEK_B, { score: 34, state: 'deprecated' });
    const file = await appendSnapshots([good, alsoGood], WEEK_B);
    const intact = await readFile(file, 'utf8');

    // Everything a real archive gets damaged by: a write torn mid-line, a merge
    // conflict resolved by hand, an editor leaving a blank line behind, and a
    // row that parses but is not a snapshot.
    await writeFile(
      file,
      [
        '{"name":"torn-b","observedAt":"2026-06-10T09:00:00.000Z","state":"active","score":',
        'not json at all',
        '[]',
        '{"name":"stateless-b","observedAt":"2026-06-10T09:00:00.000Z","state":"asleep","score":3,"activeMaintainers":0,"openAdvisories":0}',
        '{"name":"countless-b","observedAt":"2026-06-10T09:00:00.000Z","state":"active","score":3,"openAdvisories":0}',
        '',
        intact.trimEnd(),
        '',
      ].join('\n'),
      'utf8',
    );

    const read = await readAllSnapshots(ARCHIVE);
    const names = read.map((entry) => entry.name);

    // Skipped, not thrown on, and not invented: a truncated line must not
    // become a row with defaults filled in.
    assert.ok(!names.includes('torn-b'));
    assert.ok(!names.includes('stateless-b'), 'an unknown state is not a snapshot');
    assert.ok(!names.includes('countless-b'), 'a missing maintainer count must not default to zero');

    assert.deepEqual(
      read.filter((entry) => entry.name.endsWith('-b')),
      [alsoGood, good],
    );

    // A directory that was never created reads as "no history yet".
    assert.deepEqual(await readAllSnapshots(join(ARCHIVE, 'not-a-directory')), []);
  });

  it("replaces a week's rows rather than duplicating them", async () => {
    const { appendSnapshots, isoWeekKey, readAllSnapshots, readSnapshotsFor } = await store();

    assert.equal(isoWeekKey(WEEK_C), isoWeekKey(WEEK_C_FRIDAY), 'fixture weeks must match');

    const file = await appendSnapshots(
      [row('upsert-c', WEEK_C, { score: 10 }), row('bystander-c', WEEK_C, { score: 20 })],
      WEEK_C,
    );
    const again = await appendSnapshots([row('upsert-c', WEEK_C_FRIDAY, { score: 90 })], WEEK_C_FRIDAY);
    assert.equal(again, file, 'both samples belong to the same ISO week');

    assert.equal(lines(await readFile(file, 'utf8')).length, 2);

    const upsert = await readSnapshotsFor('upsert-c', ARCHIVE);
    assert.equal(upsert.length, 1, 're-running a scan in one week must not double the archive');
    assert.equal(upsert[0]?.score, 90);
    // The row keeps its own stamp, not the one that chose the file.
    assert.equal(upsert[0]?.observedAt, WEEK_C_FRIDAY.toISOString());

    // Packages the second run did not mention are left exactly as they were.
    const bystander = await readSnapshotsFor('bystander-c', ARCHIVE);
    assert.equal(bystander.length, 1);
    assert.equal(bystander[0]?.score, 20);
    assert.equal(bystander[0]?.observedAt, WEEK_C.toISOString());

    // Two spellings of one npm package are one row, not two.
    await appendSnapshots([row('Upsert-C', WEEK_C_FRIDAY, { score: 91 })], WEEK_C_FRIDAY);
    assert.equal(lines(await readFile(file, 'utf8')).length, 2);
    const folded = (await readAllSnapshots(ARCHIVE)).filter(
      (entry) => entry.name.toLowerCase() === 'upsert-c',
    );
    assert.equal(folded.length, 1);
    assert.equal(folded[0]?.score, 91);
  });
});

// ---------------------------------------------------------------------------
// trajectory
// ---------------------------------------------------------------------------

const WEEKLY = [
  '2026-05-04T00:00:00.000Z',
  '2026-05-11T00:00:00.000Z',
  '2026-05-18T00:00:00.000Z',
  '2026-05-25T00:00:00.000Z',
];

/** One package sampled weekly, with only `dependentPackagesCount` moving. */
function dependentSeries(name: string, counts: readonly number[]): HealthSnapshot[] {
  return counts.map((value, index) =>
    snapshot({
      name,
      observedAt: WEEKLY[index] ?? `2026-06-0${index}T00:00:00.000Z`,
      dependentPackagesCount: value,
    }),
  );
}

describe('computing a trajectory', () => {
  it('says unknown, not steady, below the minimum sample count', () => {
    const one = computeTrajectory([snapshot({ name: 'lonely', observedAt: WEEKLY[0] ?? '' })]);

    assert.ok(one !== null, 'a single sample is still a trajectory');
    assert.equal(one.samples, 1);
    // "We have not watched this long enough" and "this is not moving" are
    // different statements, and only the first one is true here.
    assert.equal(one.direction, 'unknown');
    assert.notEqual(one.direction, 'steady');
    assert.equal(one.scoreDelta, 0);
    assert.match(one.notes.join(' '), new RegExp(`at least ${MIN_SAMPLES_FOR_TRAJECTORY}`));
    assert.match(summarise(one), /no trend yet/);

    // Nothing to compare at all is not a package fact, it is an empty input.
    assert.equal(computeTrajectory([]), null);

    // Two samples that share a timestamp are one observation twice over.
    const sameInstant = computeTrajectory([
      snapshot({ name: 'frozen', observedAt: WEEKLY[0] ?? '', score: 10 }),
      snapshot({ name: 'frozen', observedAt: WEEKLY[0] ?? '', score: 90 }),
    ]);
    assert.equal(sameInstant?.direction, 'unknown');

    // Rows naming two packages are a caller mistake, not a verdict.
    assert.equal(
      computeTrajectory([
        snapshot({ name: 'one', observedAt: WEEKLY[0] ?? '' }),
        snapshot({ name: 'two', observedAt: WEEKLY[1] ?? '' }),
      ]),
      null,
    );
  });

  it('reports dependent flight when the ecosystem walks away', () => {
    const trajectory = computeTrajectory(dependentSeries('leaving', [1000, 960, 920, 850]));

    assert.ok(trajectory !== null);
    assert.equal(trajectory.samples, 4);
    assert.equal(trajectory.dependentFlight, 0.15);
    assert.ok(trajectory.dependentFlight !== null && trajectory.dependentFlight < DEPENDENT_FLIGHT_SEVERE);
    assert.equal(trajectory.direction, 'declining');
    assert.match(trajectory.notes.join(' '), /15% of dependent packages left/);
    assert.match(summarise(trajectory), /15% of dependents gone/);
  });

  it('treats an implausible collapse as an indexing artefact, not an exodus', () => {
    // Nothing sheds 95% of its dependents in a week. When the index says so it
    // has re-run an importer, and the two readings are not comparable.
    const cliff = computeTrajectory(dependentSeries('artefact', [900, 880, 860, 40]));

    assert.ok(cliff !== null);
    assert.equal(cliff.samples, 4);
    assert.equal(cliff.dependentFlight, null, 'the step is missing data, not a measurement');
    assert.notEqual(cliff.direction, 'collapsing');
    assert.equal(cliff.direction, 'steady');
    assert.doesNotMatch(cliff.notes.join(' '), /dependent packages left/);

    // A reset produces a cliff *and then* a recovery. Counting only the cliff
    // would turn the rebound into phantom growth, so the archive is cut at
    // both and only the most recent uninterrupted run is measured.
    const rebound = computeTrajectory(dependentSeries('rebound', [1000, 40, 1010, 1000]));

    assert.ok(rebound !== null);
    assert.equal(rebound.dependentFlight, 0.0099);
    assert.equal(rebound.direction, 'steady');
    assert.doesNotMatch(rebound.notes.join(' '), /more packages depend on it/);

    // The guard is about scale, not about ratios: four dependents going to one
    // is ordinary noise, and cutting the series there would discard history for
    // a share that is unusable anyway.
    const tiny = computeTrajectory(dependentSeries('tiny', [4, 3, 2, 1]));
    assert.equal(tiny?.samples, 4);
    assert.equal(tiny?.dependentFlight, null);
    assert.equal(tiny?.direction, 'steady');
  });

  it('reads a rising score with falling responsiveness as declining', () => {
    const before = snapshot({
      name: 'quieting',
      observedAt: WEEKLY[0] ?? '',
      state: 'low-activity',
      score: 40,
      pastYearIssues: 120,
      pastYearIssuesClosed: 96,
      activeMaintainers: 2,
      latestReleaseAt: '2025-01-05T00:00:00.000Z',
    });
    const after = snapshot({
      name: 'quieting',
      observedAt: WEEKLY[3] ?? '',
      state: 'low-activity',
      score: 62,
      pastYearIssues: 120,
      pastYearIssuesClosed: 42,
      activeMaintainers: 2,
      latestReleaseAt: '2025-01-05T00:00:00.000Z',
    });

    const trajectory = computeTrajectory([after, before]);

    assert.ok(trajectory !== null);
    assert.equal(trajectory.from, before.observedAt, 'rows arrive in any order and are sorted');
    assert.equal(trajectory.to, after.observedAt);
    assert.equal(trajectory.scoreDelta, 22);
    assert.equal(trajectory.responsivenessDelta, -0.45);
    assert.equal(trajectory.direction, 'declining');

    const notes = trajectory.notes.join(' ');
    assert.match(notes, /abandonment score rose 22 points/);
    assert.match(notes, /issues closed within the trailing year fell from 80% to 35%/);

    // Mixed evidence is not a direction: ship a release into the same window
    // and the reading goes back to steady rather than staying declining.
    const released = computeTrajectory([
      before,
      { ...after, latestReleaseAt: '2026-05-20T00:00:00.000Z' },
    ]);
    assert.equal(released?.direction, 'steady');
  });
});
