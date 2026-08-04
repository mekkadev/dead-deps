/**
 * The verdict engine.
 *
 * Signals are built in code against a fixed clock, so nothing here touches the
 * network and nothing rots as the calendar moves. The centre of gravity is the
 * `stable-complete` trap: a small finished package and a dead one produce the
 * same last-release date, and a tool that cannot tell them apart is worse than
 * no tool. Several shapes of that trap are checked, together with the negative
 * controls that must *not* be excused.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { LOW_ACTIVITY_SCORE, STATE_SCORE_BANDS, assess, extractReplacement } from '../src/detect/score.js';
import { STATE_SEVERITY } from '../src/types.js';
import type { Assessment, EvidenceKind, MaintenanceState, PackageSignals } from '../src/types.js';
import { NOW, advisory, daysAgo, signals, yearsAgo } from './helpers.js';

function verdict(input: PackageSignals): Assessment {
  return assess(input, NOW);
}

function kinds(result: Assessment): EvidenceKind[] {
  return result.evidence.map((item) => item.kind);
}

function labelled(result: Assessment, kind: EvidenceKind): string {
  return result.evidence
    .filter((item) => item.kind === kind)
    .map((item) => item.label)
    .join(' | ');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** `request`-shaped: the maintainers said so themselves. */
const DEPRECATED = signals({
  name: 'request',
  deprecationMessage: 'request has been deprecated, use undici instead',
  registryStatus: 'deprecated',
  repositoryUrl: 'https://github.com/request/request',
  repoArchived: false,
  repoPushedAt: daysAgo(200),
  latestReleaseAt: daysAgo(200),
  firstReleaseAt: yearsAgo(10),
  latestVersion: '2.88.2',
  versionsCount: 120,
  historicalReleaseCadenceDays: 30,
  dependentPackagesCount: 40_000,
  downloadsLastMonth: 20_000_000,
  pastYearIssues: 10,
  pastYearIssuesClosed: 2,
});

/** Archived years ago, and nothing shipped since. */
const ABANDONED = signals({
  name: 'left-over',
  repositoryUrl: 'https://github.com/example/left-over',
  repoArchived: true,
  repoPushedAt: yearsAgo(4),
  latestReleaseAt: yearsAgo(4),
  firstReleaseAt: yearsAgo(9),
  latestVersion: '3.1.0',
  versionsCount: 40,
  historicalReleaseCadenceDays: 45,
  dependentPackagesCount: 300,
  downloadsLastMonth: 90_000,
  pastYearIssues: 12,
  pastYearIssuesClosed: 0,
  pastYearAvgCommentsPerIssue: 0.2,
});

/**
 * The trap, four ways. Each of these is finished, not dead: quiet for years
 * because there is nothing left to add, still depended on by the ecosystem,
 * with nobody waiting on a fix.
 */
const FINISHED: ReadonlyArray<readonly [string, PackageSignals]> = [
  [
    'ms-shaped: tiny, ancient, enormous dependent count, zero open issues',
    signals({
      name: 'ms',
      repositoryUrl: 'https://github.com/vercel/ms',
      repoArchived: false,
      repoPushedAt: yearsAgo(3),
      latestReleaseAt: yearsAgo(6),
      firstReleaseAt: yearsAgo(12),
      latestVersion: '2.1.3',
      versionsCount: 20,
      historicalReleaseCadenceDays: 180,
      dependentPackagesCount: 60_000,
      dependentReposCount: 900_000,
      downloadsLastMonth: 300_000_000,
      pastYearIssues: 0,
      pastYearIssuesClosed: 0,
      pastYearPullRequests: 2,
      pastYearMergedPullRequests: 0,
    }),
  ],
  [
    'isarray-shaped: no release cadence to speak of, moderate adoption',
    signals({
      name: 'isarray',
      repositoryUrl: 'https://github.com/juliangruber/isarray',
      repoArchived: false,
      repoPushedAt: yearsAgo(7),
      latestReleaseAt: yearsAgo(8),
      firstReleaseAt: yearsAgo(13),
      latestVersion: '2.0.5',
      versionsCount: 8,
      historicalReleaseCadenceDays: null,
      dependentPackagesCount: 800,
      downloadsLastMonth: 40_000_000,
      pastYearIssues: 0,
      pastYearIssuesClosed: 0,
    }),
  ],
  [
    'no issue index at all, carried by overwhelming adoption',
    signals({
      name: 'inherits',
      repositoryUrl: 'https://github.com/isaacs/inherits',
      repoArchived: false,
      repoPushedAt: yearsAgo(5),
      latestReleaseAt: yearsAgo(7),
      firstReleaseAt: yearsAgo(13),
      latestVersion: '2.0.4',
      versionsCount: 15,
      historicalReleaseCadenceDays: 240,
      dependentPackagesCount: 30_000,
      downloadsLastMonth: 250_000_000,
      pastYearIssues: null,
      pastYearIssuesClosed: null,
      pastYearPullRequests: null,
      pastYearMergedPullRequests: null,
      freshness: { packageSyncedAt: daysAgo(2), repoSyncedAt: daysAgo(2), issuesSyncedAt: null, stale: false },
    }),
  ],
  [
    'a handful of issues, all triaged, still quiet for years',
    signals({
      name: 'once',
      repositoryUrl: 'https://github.com/isaacs/once',
      repoArchived: false,
      repoPushedAt: yearsAgo(4),
      latestReleaseAt: yearsAgo(6),
      firstReleaseAt: yearsAgo(11),
      latestVersion: '1.4.0',
      versionsCount: 18,
      historicalReleaseCadenceDays: 200,
      dependentPackagesCount: 20_000,
      downloadsLastMonth: 180_000_000,
      pastYearIssues: 20,
      pastYearIssuesClosed: 16,
      pastYearAvgCommentsPerIssue: 2.1,
      pastYearPullRequests: 4,
      pastYearMergedPullRequests: 2,
      activeMaintainers: ['isaacs'],
    }),
  ],
];

/** Healthy and obviously so. */
const ACTIVE = signals({
  name: 'vite',
  repositoryUrl: 'https://github.com/vitejs/vite',
  repoArchived: false,
  repoPushedAt: daysAgo(2),
  latestReleaseAt: daysAgo(9),
  firstReleaseAt: yearsAgo(6),
  latestVersion: '6.3.1',
  versionsCount: 700,
  historicalReleaseCadenceDays: 4,
  dependentPackagesCount: 12_000,
  downloadsLastMonth: 60_000_000,
  developmentDistributionScore: 0.72,
  totalCommitters: 900,
  pastYearIssues: 900,
  pastYearIssuesClosed: 820,
  pastYearAvgCommentsPerIssue: 4.3,
  pastYearPullRequests: 400,
  pastYearMergedPullRequests: 350,
  activeMaintainers: ['patak', 'antfu', 'bluwy'],
});

/** Unattended, still installed everywhere, and carrying an unpatched advisory. */
const HIJACK = signals({
  name: 'flatmap-stream',
  repositoryUrl: 'https://github.com/example/flatmap-stream',
  repoArchived: false,
  repoPushedAt: yearsAgo(3),
  latestReleaseAt: yearsAgo(3),
  firstReleaseAt: yearsAgo(8),
  latestVersion: '0.1.1',
  versionsCount: 12,
  dependentPackagesCount: 4_000,
  downloadsLastMonth: 2_000_000,
  pastYearIssues: 22,
  pastYearIssuesClosed: 1,
  pastYearAvgCommentsPerIssue: 0.1,
  activeMaintainers: [],
  openAdvisories: [advisory({ id: 'GHSA-aaaa-bbbb-cccc', severity: 'critical', publishedAt: daysAgo(500) })],
});

/** Nothing came back from any source. */
const UNKNOWN = signals({ name: 'ghost', errors: ['ecosyste.ms lookup failed: timeout'] });

const ALL_FIXTURES: ReadonlyArray<readonly [string, PackageSignals]> = [
  ['deprecated', DEPRECATED],
  ['abandoned', ABANDONED],
  ...FINISHED,
  ['active', ACTIVE],
  ['hijack', HIJACK],
  ['unknown', UNKNOWN],
];

// ---------------------------------------------------------------------------
// Decisive states
// ---------------------------------------------------------------------------

describe('decisive verdicts', () => {
  test('a deprecated package is deprecated, with the registry notice as evidence', () => {
    const result = verdict(DEPRECATED);

    assert.equal(result.state, 'deprecated');
    assert.ok(kinds(result).includes('registry-deprecation'));

    const notice = result.evidence.find((item) => item.kind === 'registry-deprecation');
    assert.ok(notice !== undefined);
    assert.ok(notice.weight > 0, 'the deprecation must argue for the verdict, not against it');
    assert.equal(notice.url, 'https://www.npmjs.com/package/request');
    // The replacement named in the notice is the most useful thing in it.
    assert.match(notice.label, /undici/);
  });

  test('a deprecation notice that names no replacement still produces evidence', () => {
    const result = verdict(
      signals({
        ...DEPRECATED,
        deprecationMessage: 'This package is no longer supported.',
      }),
    );
    assert.equal(result.state, 'deprecated');
    assert.match(labelled(result, 'registry-deprecation'), /no longer supported/);
  });

  test('an archived repository plus years of silence is abandoned', () => {
    const result = verdict(ABANDONED);

    assert.equal(result.state, 'abandoned');
    assert.ok(kinds(result).includes('repo-archived'));
    assert.match(labelled(result, 'repo-archived'), /archived/i);
  });

  test('archived but recently released is unmaintained, not abandoned', () => {
    // A final tag or a successor announcement may still be coming.
    const result = verdict(signals({ ...ABANDONED, repoArchived: true, latestReleaseAt: daysAgo(120) }));
    assert.equal(result.state, 'unmaintained');
  });

  test('removed from the registry is abandoned whatever else is true', () => {
    const result = verdict(signals({ ...ACTIVE, registryStatus: 'removed' }));
    assert.equal(result.state, 'abandoned');
  });

  test('an unattended package with an unpatched advisory is a hijack risk', () => {
    const result = verdict(HIJACK);

    assert.equal(result.state, 'hijack-risk');
    assert.ok(kinds(result).includes('security-advisory'));
    assert.ok(result.score >= 88, `expected the top band, got ${result.score}`);
  });

  test('an attended package with an advisory is not a hijack risk', () => {
    const result = verdict(
      signals({
        ...HIJACK,
        activeMaintainers: ['someone'],
        pastYearIssues: 20,
        pastYearIssuesClosed: 18,
        latestReleaseAt: daysAgo(30),
      }),
    );
    assert.notEqual(result.state, 'hijack-risk');
  });

  test('a healthy package is active and scores low', () => {
    const result = verdict(ACTIVE);

    assert.equal(result.state, 'active');
    assert.ok(result.score <= 24, `expected a low score, got ${result.score}`);
    assert.ok(kinds(result).includes('release-cadence'));
    // Exculpatory evidence leads when the verdict is not negative.
    assert.ok((result.evidence[0]?.weight ?? 0) < 0);
  });

  test('no data at all is unknown, not abandoned', () => {
    const result = verdict(UNKNOWN);

    assert.equal(result.state, 'unknown');
    assert.equal(result.confidence, 'low');
  });
});

// ---------------------------------------------------------------------------
// The trap
// ---------------------------------------------------------------------------

describe('finished is not abandoned', () => {
  for (const [name, input] of FINISHED) {
    test(name, () => {
      const result = verdict(input);

      assert.equal(
        result.state,
        'stable-complete',
        `${input.name} was judged "${result.state}"; a quiet, widely used, unbroken package is finished, not dead`,
      );
      assert.ok(
        result.score <= STATE_SCORE_BANDS['stable-complete'][1],
        `expected a low score, got ${result.score}`,
      );
      assert.ok(
        kinds(result).includes('stability-heuristic'),
        'the verdict has to say out loud why it declined to flag this',
      );
      assert.match(labelled(result, 'stability-heuristic'), /Not flagged/);
    });
  }

  test('the exculpatory evidence carries a negative weight', () => {
    const first = FINISHED[0];
    assert.ok(first !== undefined);
    const result = verdict(first[1]);
    const heuristic = result.evidence.filter((item) => item.kind === 'stability-heuristic');
    assert.ok(heuristic.length > 0);
    for (const item of heuristic) {
      assert.ok(item.weight < 0, `${item.label} should argue the package is alive`);
    }
  });

  /** Each of these breaks exactly one clause of the guard. */
  const NOT_FINISHED: ReadonlyArray<readonly [string, Partial<PackageSignals>]> = [
    ['people are waiting on unanswered issues', { pastYearIssues: 30, pastYearIssuesClosed: 4 }],
    ['contributors are offering fixes nobody merges', { pastYearPullRequests: 9, pastYearMergedPullRequests: 0 }],
    ['the maintainers deprecated it', { deprecationMessage: 'no longer maintained' }],
    ['the repository is archived', { repoArchived: true }],
    ['an advisory is open against it', { openAdvisories: [advisory()] }],
    ['nobody depends on it any more', { dependentPackagesCount: 3, downloadsLastMonth: 400 }],
    ['it is too young for "converged" to be credible', { firstReleaseAt: yearsAgo(3) }],
    ['it still churns out releases', { versionsCount: 400 }],
  ];

  for (const [why, override] of NOT_FINISHED) {
    test(`not excused when ${why}`, () => {
      const base = FINISHED[0];
      assert.ok(base !== undefined);
      const result = verdict(signals({ ...base[1], ...override }));

      assert.notEqual(
        result.state,
        'stable-complete',
        `"${why}" must defeat the stable-complete guard`,
      );
      assert.equal(
        kinds(result).includes('stability-heuristic'),
        false,
        'the guard must not emit its excuse when it did not fire',
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

describe('confidence', () => {
  for (const [name, input] of ALL_FIXTURES) {
    test(`${name}: stale data never yields high confidence`, () => {
      const stale = signals({ ...input, freshness: { ...input.freshness, stale: true } });
      const result = verdict(stale);

      assert.notEqual(result.confidence, 'high');
      assert.equal(result.confidence, 'low');
    });
  }

  test('a source that failed drops confidence', () => {
    const result = verdict(signals({ ...DEPRECATED, errors: ['npm registry lookup failed'] }));
    assert.equal(result.confidence, 'low');
  });

  test('no repository metadata at all drops confidence', () => {
    const result = verdict(
      signals({
        ...ACTIVE,
        repositoryUrl: null,
        repoArchived: null,
        repoPushedAt: null,
      }),
    );
    assert.equal(result.confidence, 'low');
  });

  test('an authoritative fact on fresh data earns high confidence', () => {
    assert.equal(verdict(DEPRECATED).confidence, 'high');
    assert.equal(verdict(ABANDONED).confidence, 'high');
  });

  test('a judgement call on fresh data is medium at best', () => {
    assert.equal(verdict(ACTIVE).confidence, 'medium');
  });
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

describe('invariants', () => {
  for (const [name, input] of ALL_FIXTURES) {
    test(`${name}: every piece of evidence is checkable`, () => {
      const result = verdict(input);
      assert.ok(result.evidence.length > 0, 'a verdict with no evidence is a bug');

      for (const item of result.evidence) {
        assert.equal(typeof item.label, 'string');
        assert.notEqual(item.label.trim(), '', `empty label on ${item.kind}`);
        assert.ok(
          Number.isFinite(item.weight),
          `${item.kind} carries a non-finite weight (${item.weight})`,
        );
        if (item.url !== undefined) {
          assert.ok(URL.canParse(item.url), `${item.kind} has an unusable url: ${item.url}`);
          assert.match(item.url, /^https:\/\//);
        }
        if (item.observedAt !== undefined) {
          assert.ok(
            Number.isFinite(Date.parse(item.observedAt)),
            `${item.kind} has an unparseable observedAt: ${item.observedAt}`,
          );
        }
      }
    });

    test(`${name}: score and state agree`, () => {
      const result = verdict(input);
      const band = STATE_SCORE_BANDS[result.state];

      assert.ok(
        result.score >= band[0] && result.score <= band[1],
        `${result.state} must score within ${band[0]}..${band[1]}, got ${result.score}`,
      );
      assert.ok(Number.isInteger(result.score));
      assert.equal(result.name, input.name);
      assert.equal(result.signals, input);
    });
  }

  test('a flagged word always carries a flagged number', () => {
    const flagged = STATE_SEVERITY['low-activity'];
    for (const [name, input] of ALL_FIXTURES) {
      const result = verdict(input);
      if (STATE_SEVERITY[result.state] >= flagged) {
        assert.ok(
          result.score >= LOW_ACTIVITY_SCORE,
          `${name} reads "${result.state}" but scores ${result.score}, below the reporting floor`,
        );
      }
      if (result.state === 'active' || result.state === 'stable-complete') {
        assert.ok(
          result.score < LOW_ACTIVITY_SCORE,
          `${name} reads "${result.state}" but scores ${result.score}, above the reporting floor`,
        );
      }
    }
  });

  test('the bands themselves cannot contradict the severity order', () => {
    const states = (Object.keys(STATE_SEVERITY) as MaintenanceState[]).sort(
      (a, b) => STATE_SEVERITY[a] - STATE_SEVERITY[b],
    );

    let previousFloor = -1;
    for (const state of states) {
      const [min, max] = STATE_SCORE_BANDS[state];
      assert.ok(min <= max, `${state} has an inverted band`);
      assert.ok(min >= 0 && max <= 100, `${state} has a band outside 0..100`);
      // Bands may overlap — `abandoned` tops out above `hijack-risk` starts —
      // but a worse state may never begin below a milder one.
      assert.ok(min >= previousFloor, `${state} starts below the state beneath it`);
      previousFloor = min;
    }
  });

  test('assess never throws on hostile input', () => {
    const hostile = signals({
      name: '',
      latestReleaseAt: 'not a date',
      repoPushedAt: '',
      firstReleaseAt: '0000-00-00',
      versionsCount: Number.NaN,
      historicalReleaseCadenceDays: -5,
      dependentPackagesCount: Number.POSITIVE_INFINITY,
      pastYearIssues: 10,
      pastYearIssuesClosed: 999,
      openAdvisories: [advisory({ publishedAt: 'whenever', severity: null })],
    });

    const result = verdict(hostile);
    assert.ok(Number.isInteger(result.score));
    assert.ok(Object.prototype.hasOwnProperty.call(STATE_SEVERITY, result.state));
  });
});

// ---------------------------------------------------------------------------
// Deprecation notices
// ---------------------------------------------------------------------------

describe('extractReplacement', () => {
  const cases: ReadonlyArray<readonly [string, string | null]> = [
    ['request has been deprecated, use undici instead', 'undici'],
    ['This module is no longer maintained, try this instead:\n  npm i nyc', 'nyc'],
    ['Switch to "npm install joi"', 'joi'],
    ['Package no longer supported.', null],
    ['replaced by @faker-js/faker', '@faker-js/faker'],
    ['moved to sass', 'sass'],
    ['use left-pad@^2.0.0 instead', 'left-pad'],
    ['Please upgrade to version 7 or higher.', null],
  ];

  for (const [message, expected] of cases) {
    test(JSON.stringify(message.slice(0, 48)), () => {
      assert.equal(extractReplacement(message, 'self'), expected);
    });
  }

  test('a package is never told to replace itself', () => {
    assert.equal(extractReplacement('use moment instead', 'moment'), null);
  });
});
