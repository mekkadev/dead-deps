/**
 * Builders shared by the test suites.
 *
 * Everything here is pure and offline. No test in this repository is allowed to
 * touch the network, so signals are constructed by hand rather than fetched,
 * and anything that would otherwise need an `HttpClient` gets `fakeHttp()`.
 */

import type {
  AdvisorySummary,
  Assessment,
  DataFreshness,
  Evidence,
  Finding,
  ParsedDependency,
  ParsedLockfile,
  PackageSignals,
  ScanResult,
  SuccessorRecord,
} from '../src/types.js';

const MS_PER_DAY = 86_400_000;

/** Fixed clock. Tests that reason about ages pass this to `assess`. */
export const NOW = Date.parse('2026-08-04T00:00:00.000Z');

export function daysAgo(days: number, now: number = NOW): string {
  return new Date(now - days * MS_PER_DAY).toISOString();
}

export function yearsAgo(years: number, now: number = NOW): string {
  return daysAgo(years * 365.25, now);
}

/**
 * A `PackageSignals` in which nothing is known, plus overrides. Written out
 * here rather than imported from `src/sources` so a change to the gatherer can
 * never quietly change what the scorer is being tested against.
 */
export type SignalOverrides = Partial<Omit<PackageSignals, 'freshness'>> & {
  freshness?: Partial<DataFreshness>;
};

export function signals(overrides: SignalOverrides = {}): PackageSignals {
  const base: PackageSignals = {
    name: 'example',
    registryStatus: null,
    deprecationMessage: null,
    repositoryUrl: null,
    repoArchived: null,
    repoPushedAt: null,
    latestReleaseAt: null,
    firstReleaseAt: null,
    latestVersion: null,
    versionsCount: null,
    historicalReleaseCadenceDays: null,
    dependentPackagesCount: null,
    dependentReposCount: null,
    downloadsLastMonth: null,
    developmentDistributionScore: null,
    totalCommitters: null,
    pastYearIssues: null,
    pastYearIssuesClosed: null,
    pastYearAvgCommentsPerIssue: null,
    pastYearPullRequests: null,
    pastYearMergedPullRequests: null,
    activeMaintainers: [],
    openAdvisories: [],
    freshness: {
      packageSyncedAt: daysAgo(1),
      repoSyncedAt: daysAgo(1),
      issuesSyncedAt: daysAgo(1),
      stale: false,
    },
    errors: [],
  };

  return {
    ...base,
    ...overrides,
    freshness: { ...base.freshness, ...(overrides.freshness ?? {}) },
  };
}

export function advisory(overrides: Partial<AdvisorySummary> = {}): AdvisorySummary {
  return {
    id: 'GHSA-0000-0000-0000',
    title: 'Prototype pollution in example',
    severity: 'high',
    url: 'https://github.com/advisories/GHSA-0000-0000-0000',
    publishedAt: daysAgo(400),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Report-shaped builders
// ---------------------------------------------------------------------------

export function dependency(overrides: Partial<ParsedDependency> = {}): ParsedDependency {
  return { name: 'example', version: '1.0.0', direct: true, scope: 'prod', ...overrides };
}

export function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    kind: 'release-cadence',
    label: 'Something a human can check.',
    weight: 5,
    ...overrides,
  };
}

export function assessment(overrides: Partial<Assessment> = {}): Assessment {
  const name = overrides.name ?? overrides.signals?.name ?? 'example';
  return {
    name,
    state: 'abandoned',
    score: 90,
    confidence: 'high',
    evidence: [evidence()],
    signals: signals({ name }),
    ...overrides,
  };
}

export function successor(overrides: Partial<SuccessorRecord> = {}): SuccessorRecord {
  return {
    from: 'example',
    to: 'example-ng',
    toKind: 'package',
    type: 'fork',
    confidence: 'high',
    since: '2021-04',
    dropIn: true,
    alternatives: ['other-example'],
    notes: 'The original stopped shipping. A community fork carried it on.',
    migration: 'Change the import and keep the same call sites.',
    evidence: [{ label: 'Maintainer announcement', url: 'https://example.com/announcement' }],
    ...overrides,
  };
}

export function finding(overrides: Partial<Finding> = {}): Finding {
  const dep = overrides.dependency ?? dependency();
  return {
    dependency: dep,
    assessment: assessment({ name: dep.name, signals: signals({ name: dep.name }) }),
    successor: null,
    ...overrides,
  };
}

export function lockfile(overrides: Partial<ParsedLockfile> = {}): ParsedLockfile {
  return {
    format: 'npm-v3',
    path: '/projects/example/package-lock.json',
    dependencies: [dependency()],
    warnings: [],
    ...overrides,
  };
}

export function scanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    lockfile: lockfile(),
    findings: [],
    examined: 1,
    skipped: 0,
    startedAt: '2026-08-04T00:00:00.000Z',
    durationMs: 1234,
    warnings: [],
    ...overrides,
  };
}

/**
 * Any ANSI CSI sequence (SGR colour is the one that matters here). Written with
 * an explicit \u001B so the pattern survives a copy-paste through an editor.
 */
export const ANSI_PATTERN = /\u001B\[[0-9;?]*[ -\/]*[@-~]/;

/** The bare escape byte. Nothing rendered without colour may contain one. */
export const ESC = '\u001B';
