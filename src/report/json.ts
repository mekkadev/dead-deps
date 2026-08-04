/**
 * The machine-facing report.
 *
 * CI jobs and the MCP server parse this, so it is a contract, not a dump:
 *
 *   - `schemaVersion` is `1`. It is bumped only when a field is removed or
 *     changes meaning. Adding a field is not a breaking change, so consumers
 *     must ignore keys they do not know.
 *   - Nothing here depends on terminal width, colour, `TERM`, or the locale.
 *     The same `ScanResult` always renders the same bytes, apart from
 *     `generatedAt`.
 *   - Every timestamp is ISO-8601 UTC, or `null`. Unparseable upstream values
 *     become `null` rather than leaking through in some other format.
 *   - Findings carry their **full** evidence array. Nothing is truncated for
 *     display; the terminal report does the summarising, not this one.
 *
 * Shape:
 *
 * {
 *   schemaVersion: 1,
 *   tool: "dead-deps",
 *   generatedAt: string,                  // ISO, when this report was rendered
 *   scan: { startedAt, completedAt, durationMs, examined, skipped,
 *           flagged, notFlagged },
 *   lockfile: { path, format, dependencyCount, warnings[] },
 *   summary: { worstState, worstSeverity, highestScore, byState{},
 *              withSuccessor, dropInAvailable, lowConfidence, stale },
 *   findings: [ {
 *     name, version, direct, scope,
 *     state, severity, score, confidence,
 *     stale, dataErrors[],
 *     evidence: [ { kind, label, url, observedAt, weight } ],
 *     signals: { ... },                   // raw upstream facts, unjudged
 *     successor: { ... } | null
 *   } ],
 *   warnings: string[]
 * }
 */

import { STATE_SEVERITY } from '../types.js';
import type {
  Assessment,
  Evidence,
  Finding,
  MaintenanceState,
  PackageSignals,
  ScanResult,
  SuccessorRecord,
} from '../types.js';

// ---------------------------------------------------------------------------
// Emitted shapes. These are the contract; keep them explicit rather than
// spreading source objects, so an upstream field can never leak in unnoticed.
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1;

interface JsonEvidence {
  kind: Evidence['kind'];
  label: string;
  url: string | null;
  observedAt: string | null;
  weight: number;
}

interface JsonSuccessor {
  to: string | null;
  type: SuccessorRecord['type'];
  confidence: SuccessorRecord['confidence'];
  since: string | null;
  dropIn: boolean;
  alternatives: string[];
  notes: string;
  migration: string | null;
  evidence: Array<{ label: string; url: string }>;
}

interface JsonFinding {
  name: string;
  version: string | null;
  direct: boolean;
  scope: Finding['dependency']['scope'];
  state: MaintenanceState;
  severity: number;
  score: number;
  confidence: Assessment['confidence'];
  stale: boolean;
  dataErrors: string[];
  evidence: JsonEvidence[];
  signals: JsonSignals;
  successor: JsonSuccessor | null;
}

interface JsonSignals {
  registryStatus: string | null;
  deprecationMessage: string | null;
  repositoryUrl: string | null;
  repoArchived: boolean | null;
  repoPushedAt: string | null;
  latestVersion: string | null;
  latestReleaseAt: string | null;
  firstReleaseAt: string | null;
  versionsCount: number | null;
  historicalReleaseCadenceDays: number | null;
  dependentPackagesCount: number | null;
  dependentReposCount: number | null;
  downloadsLastMonth: number | null;
  developmentDistributionScore: number | null;
  totalCommitters: number | null;
  pastYearIssues: number | null;
  pastYearIssuesClosed: number | null;
  pastYearAvgCommentsPerIssue: number | null;
  pastYearPullRequests: number | null;
  pastYearMergedPullRequests: number | null;
  activeMaintainers: string[];
  openAdvisories: Array<{
    id: string;
    title: string;
    severity: string | null;
    url: string;
    publishedAt: string | null;
  }>;
  freshness: {
    packageSyncedAt: string | null;
    repoSyncedAt: string | null;
    issuesSyncedAt: string | null;
    stale: boolean;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalises any upstream timestamp to ISO-8601 UTC, or `null`. */
function iso(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function isoFrom(start: string, offsetMs: number): string | null {
  const parsed = Date.parse(start);
  if (!Number.isFinite(parsed)) return null;
  const delta = Number.isFinite(offsetMs) ? offsetMs : 0;
  return new Date(parsed + delta).toISOString();
}

function bySeverityThenScore(a: Finding, b: Finding): number {
  const severity = STATE_SEVERITY[b.assessment.state] - STATE_SEVERITY[a.assessment.state];
  if (severity !== 0) return severity;
  if (b.assessment.score !== a.assessment.score) return b.assessment.score - a.assessment.score;
  return a.dependency.name.localeCompare(b.dependency.name);
}

function toJsonEvidence(evidence: readonly Evidence[]): JsonEvidence[] {
  return evidence.map((item) => ({
    kind: item.kind,
    label: item.label,
    url: item.url ?? null,
    observedAt: iso(item.observedAt),
    weight: item.weight,
  }));
}

function toJsonSignals(signals: PackageSignals): JsonSignals {
  return {
    registryStatus: signals.registryStatus,
    deprecationMessage: signals.deprecationMessage,
    repositoryUrl: signals.repositoryUrl,
    repoArchived: signals.repoArchived,
    repoPushedAt: iso(signals.repoPushedAt),
    latestVersion: signals.latestVersion,
    latestReleaseAt: iso(signals.latestReleaseAt),
    firstReleaseAt: iso(signals.firstReleaseAt),
    versionsCount: signals.versionsCount,
    historicalReleaseCadenceDays: signals.historicalReleaseCadenceDays,
    dependentPackagesCount: signals.dependentPackagesCount,
    dependentReposCount: signals.dependentReposCount,
    downloadsLastMonth: signals.downloadsLastMonth,
    developmentDistributionScore: signals.developmentDistributionScore,
    totalCommitters: signals.totalCommitters,
    pastYearIssues: signals.pastYearIssues,
    pastYearIssuesClosed: signals.pastYearIssuesClosed,
    pastYearAvgCommentsPerIssue: signals.pastYearAvgCommentsPerIssue,
    pastYearPullRequests: signals.pastYearPullRequests,
    pastYearMergedPullRequests: signals.pastYearMergedPullRequests,
    activeMaintainers: [...signals.activeMaintainers],
    openAdvisories: signals.openAdvisories.map((advisory) => ({
      id: advisory.id,
      title: advisory.title,
      severity: advisory.severity,
      url: advisory.url,
      publishedAt: iso(advisory.publishedAt),
    })),
    freshness: {
      packageSyncedAt: iso(signals.freshness.packageSyncedAt),
      repoSyncedAt: iso(signals.freshness.repoSyncedAt),
      issuesSyncedAt: iso(signals.freshness.issuesSyncedAt),
      stale: signals.freshness.stale,
    },
  };
}

function toJsonSuccessor(record: SuccessorRecord | null): JsonSuccessor | null {
  if (record === null) return null;
  return {
    to: record.to,
    type: record.type,
    confidence: record.confidence,
    since: record.since,
    dropIn: record.dropIn,
    alternatives: [...record.alternatives],
    notes: record.notes,
    migration: record.migration,
    evidence: record.evidence.map((item) => ({ label: item.label, url: item.url })),
  };
}

function toJsonFinding(finding: Finding): JsonFinding {
  const { assessment, dependency } = finding;
  return {
    name: dependency.name,
    version: dependency.version,
    direct: dependency.direct,
    scope: dependency.scope,
    state: assessment.state,
    severity: STATE_SEVERITY[assessment.state],
    score: assessment.score,
    confidence: assessment.confidence,
    stale: assessment.signals.freshness.stale,
    dataErrors: [...assessment.signals.errors],
    evidence: toJsonEvidence(assessment.evidence),
    signals: toJsonSignals(assessment.signals),
    successor: toJsonSuccessor(finding.successor),
  };
}

/** Counts per state, emitted with every state key so consumers can index it. */
function stateHistogram(findings: readonly Finding[]): Record<MaintenanceState, number> {
  const counts = {} as Record<MaintenanceState, number>;
  for (const state of Object.keys(STATE_SEVERITY) as MaintenanceState[]) counts[state] = 0;
  for (const finding of findings) counts[finding.assessment.state] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Renders the scan as pretty-printed JSON, without a trailing newline: the
 * caller is expected to `console.log()` it.
 */
export function renderJson(result: ScanResult): string {
  const findings = [...result.findings].sort(bySeverityThenScore);
  const worst = findings[0]?.assessment.state ?? null;

  const withSuccessor = findings.filter(
    (finding) => finding.successor !== null && finding.successor.to !== null,
  );

  const document = {
    schemaVersion: SCHEMA_VERSION,
    tool: 'dead-deps',
    generatedAt: new Date().toISOString(),
    scan: {
      startedAt: iso(result.startedAt),
      completedAt: isoFrom(result.startedAt, result.durationMs),
      durationMs: result.durationMs,
      examined: result.examined,
      skipped: result.skipped,
      flagged: findings.length,
      notFlagged: Math.max(0, result.examined - findings.length),
    },
    lockfile: {
      path: result.lockfile.path,
      format: result.lockfile.format,
      dependencyCount: result.lockfile.dependencies.length,
      warnings: [...result.lockfile.warnings],
    },
    summary: {
      worstState: worst,
      worstSeverity: worst === null ? 0 : STATE_SEVERITY[worst],
      highestScore: findings.reduce((max, f) => Math.max(max, f.assessment.score), 0),
      byState: stateHistogram(findings),
      withSuccessor: withSuccessor.length,
      dropInAvailable: withSuccessor.filter((finding) => finding.successor?.dropIn === true).length,
      lowConfidence: findings.filter((finding) => finding.assessment.confidence === 'low').length,
      stale: findings.filter((finding) => finding.assessment.signals.freshness.stale).length,
    },
    findings: findings.map(toJsonFinding),
    warnings: [...result.warnings],
  };

  return JSON.stringify(document, null, 2);
}
