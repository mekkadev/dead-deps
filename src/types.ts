/**
 * Shared contracts for dead-deps.
 *
 * Every module in this project codes against these types. Treat this file as
 * the single source of truth: if a shape needs to change, change it here first.
 */

// ---------------------------------------------------------------------------
// Lockfiles
// ---------------------------------------------------------------------------

export type LockfileFormat =
  | 'npm-v1'
  | 'npm-v2'
  | 'npm-v3'
  | 'pnpm'
  | 'yarn-v1'
  | 'yarn-berry'
  | 'package-json';

/** How a dependency is reachable from the project root. */
export type DependencyScope = 'prod' | 'dev' | 'optional' | 'peer';

export interface ParsedDependency {
  /** Bare package name, e.g. `request` or `@babel/core`. */
  name: string;
  /** Resolved version if the lockfile pins one. */
  version: string | null;
  /** True when listed in the project's own manifest (actionable by the user). */
  direct: boolean;
  scope: DependencyScope;
}

export interface ParsedLockfile {
  format: LockfileFormat;
  /** Absolute path of the file that was parsed. */
  path: string;
  dependencies: ParsedDependency[];
  /** Non-fatal problems (unknown entries, unparseable lines). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Maintenance assessment
// ---------------------------------------------------------------------------

/**
 * The verdict is a state, never a boolean. Distinguishing `stable-complete`
 * from `abandoned` is the entire point of this tool: small finished packages
 * look identical to dead ones if you only read the last-release date.
 */
export type MaintenanceState =
  | 'active'
  | 'stable-complete'
  | 'low-activity'
  | 'unmaintained'
  | 'deprecated'
  | 'abandoned'
  | 'hijack-risk'
  | 'unknown';

/** Severity ordering used for sorting and exit codes. Higher = worse. */
export const STATE_SEVERITY: Record<MaintenanceState, number> = {
  active: 0,
  'stable-complete': 1,
  unknown: 2,
  'low-activity': 3,
  unmaintained: 4,
  deprecated: 5,
  abandoned: 6,
  'hijack-risk': 7,
};

export type EvidenceKind =
  | 'registry-deprecation'
  | 'repo-archived'
  | 'repo-missing'
  | 'release-cadence'
  | 'commit-activity'
  | 'issue-responsiveness'
  | 'bus-factor'
  | 'maintainer-activity'
  | 'security-advisory'
  | 'dependent-flight'
  | 'curated-dataset'
  | 'stability-heuristic';

/**
 * A single human-checkable fact behind a verdict. Every claim the tool makes
 * must be traceable to one of these; unsourced verdicts are a bug.
 */
export interface Evidence {
  kind: EvidenceKind;
  /** One line, written for a human reading a terminal. */
  label: string;
  /** Where a human can verify the claim. */
  url?: string;
  /** When the underlying datum was observed upstream, if known. */
  observedAt?: string;
  /** Signed contribution to the score. Negative = argues for "alive". */
  weight: number;
}

/** Raw facts gathered from upstream sources, before any judgement. */
export interface PackageSignals {
  name: string;
  /** `deprecated` / `active` / etc. as reported by the registry index. */
  registryStatus: string | null;
  /** npm `deprecated` field on the latest version, if set. */
  deprecationMessage: string | null;
  repositoryUrl: string | null;
  repoArchived: boolean | null;
  repoPushedAt: string | null;
  latestReleaseAt: string | null;
  firstReleaseAt: string | null;
  latestVersion: string | null;
  versionsCount: number | null;
  /** Median gap between releases across the package's life, in days. */
  historicalReleaseCadenceDays: number | null;
  dependentPackagesCount: number | null;
  dependentReposCount: number | null;
  downloadsLastMonth: number | null;
  /** Development Distribution Score: 0 = one author, 1 = fully distributed. */
  developmentDistributionScore: number | null;
  totalCommitters: number | null;
  /** Issue/PR responsiveness over the trailing year. */
  pastYearIssues: number | null;
  pastYearIssuesClosed: number | null;
  pastYearAvgCommentsPerIssue: number | null;
  pastYearPullRequests: number | null;
  pastYearMergedPullRequests: number | null;
  /** Maintainers upstream considers currently active. Empty array is a signal. */
  activeMaintainers: string[];
  openAdvisories: AdvisorySummary[];
  /** Timestamps telling us how much to trust the above. */
  freshness: DataFreshness;
  /** Sources that failed, so the report can admit what it does not know. */
  errors: string[];
}

export interface AdvisorySummary {
  id: string;
  title: string;
  severity: string | null;
  url: string;
  publishedAt: string | null;
}

/**
 * Upstream indexes lag. A verdict built on two-year-old issue data must say so
 * rather than quietly presenting it as current.
 */
export interface DataFreshness {
  packageSyncedAt: string | null;
  repoSyncedAt: string | null;
  issuesSyncedAt: string | null;
  /** True when any load-bearing input is older than the staleness threshold. */
  stale: boolean;
}

export interface Assessment {
  name: string;
  state: MaintenanceState;
  /** 0..100. Higher = more likely genuinely abandoned. */
  score: number;
  /** How much to trust the verdict given data coverage and freshness. */
  confidence: 'high' | 'medium' | 'low';
  evidence: Evidence[];
  signals: PackageSignals;
}

// ---------------------------------------------------------------------------
// Succession dataset
// ---------------------------------------------------------------------------

/**
 * How the successor relates to the package it replaces. A maintained fork is
 * only one of six ways a package gets succeeded, and not the most common one.
 */
export type SuccessionType =
  | 'fork'
  | 'rename'
  | 'replacement'
  | 'absorbed'
  | 'self-declared'
  | 'reimplementation';

export type Confidence = 'high' | 'medium' | 'low';

export interface SuccessorEvidence {
  label: string;
  url: string;
}

/** One curated row of `data/successors.yaml`. */
export interface SuccessorRecord {
  /** Package that is dead, deprecated or superseded. */
  from: string;
  /** Primary recommended successor. `null` when none is credible. */
  to: string | null;
  type: SuccessionType;
  confidence: Confidence;
  /** Approximate month the `from` package stopped being maintained, `YYYY-MM`. */
  since: string | null;
  /** True when the successor is API-compatible enough to swap directly. */
  dropIn: boolean;
  /** Other credible options, in no particular order. */
  alternatives: string[];
  /** Two or three sentences of plain prose. Rendered on the site. */
  notes: string;
  /** Optional concrete migration hint (import change, codemod, flag). */
  migration: string | null;
  /** Human-checkable sources. At least one required. */
  evidence: SuccessorEvidence[];
}

export interface SuccessorDataset {
  records: SuccessorRecord[];
  /** Index by `from`, lowercased. */
  byFrom: Map<string, SuccessorRecord>;
}

// ---------------------------------------------------------------------------
// Scan results
// ---------------------------------------------------------------------------

export interface Finding {
  dependency: ParsedDependency;
  assessment: Assessment;
  /** Curated succession record, when one exists for this package. */
  successor: SuccessorRecord | null;
}

export interface ScanResult {
  lockfile: ParsedLockfile;
  findings: Finding[];
  /** Packages examined, including healthy ones that produced no finding. */
  examined: number;
  skipped: number;
  startedAt: string;
  durationMs: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ScanOptions {
  /** Include transitive dependencies. Off by default: they are not actionable. */
  all: boolean;
  /** Report at most this many findings. */
  limit: number;
  /** Minimum state severity to report. */
  minState: MaintenanceState;
  /** Disable the on-disk HTTP cache. */
  noCache: boolean;
  /** Cache time-to-live in hours. */
  cacheTtlHours: number;
  /** Contact address sent upstream to reach ecosyste.ms' polite pool. */
  contact: string | null;
  /** Max concurrent upstream requests. */
  concurrency: number;
  /** Suppress progress output. */
  quiet: boolean;
}

export const DEFAULT_SCAN_OPTIONS: ScanOptions = {
  all: false,
  limit: 5,
  minState: 'low-activity',
  noCache: false,
  cacheTtlHours: 24,
  contact: null,
  concurrency: 8,
  quiet: false,
};

/** Exit codes. Stable contract for CI users. */
export const EXIT = {
  OK: 0,
  FINDINGS: 1,
  USAGE_ERROR: 2,
  RUNTIME_ERROR: 3,
} as const;
