/**
 * ecosyste.ms package index.
 *
 * One request per package returns registry metadata, repository metadata,
 * issue/PR responsiveness and security advisories. The index lags reality by
 * months for unpopular repositories, so every timestamp it hands us is
 * recorded in `DataFreshness` rather than silently trusted.
 */

import { advisoryAffectsVersion } from '../semver.js';
import type { AdvisorySummary, PackageSignals } from '../types.js';
import type { HttpClient } from './http.js';

const ECOSYSTEMS_PACKAGE_BASE =
  'https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages';

/** A datum older than this makes the whole verdict "stale". */
export const STALENESS_THRESHOLD_DAYS = 180;

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Upstream shape (only the fields this tool reads)
// ---------------------------------------------------------------------------

export interface EcosystemsCommitStats {
  total_commits?: number | null;
  total_committers?: number | null;
  mean_commits?: number | null;
  /** Development Distribution Score: 0 = one author, 1 = fully distributed. */
  dds?: number | null;
}

export interface EcosystemsRepoMetadata {
  full_name?: string | null;
  html_url?: string | null;
  archived?: boolean | null;
  fork?: boolean | null;
  pushed_at?: string | null;
  /** `null` normally; e.g. `"removed"` when the repository has disappeared. */
  status?: string | null;
  last_synced_at?: string | null;
  commit_stats?: EcosystemsCommitStats | null;
}

export interface EcosystemsIssueAuthor {
  login?: string | null;
  count?: number | null;
  url?: string | null;
}

export interface EcosystemsIssueMetadata {
  last_synced_at?: string | null;
  past_year_issues_count?: number | null;
  past_year_issues_closed_count?: number | null;
  past_year_avg_comments_per_issue?: number | null;
  past_year_pull_requests_count?: number | null;
  past_year_merged_pull_requests_count?: number | null;
  active_maintainers?: EcosystemsIssueAuthor[] | null;
  maintainers?: EcosystemsIssueAuthor[] | null;
}

export interface EcosystemsAdvisoryVersionWindow {
  /** e.g. `"< 2.0.0"`. */
  vulnerable_version_range?: string | null;
  first_patched_version?: string | null;
}

export interface EcosystemsAdvisoryPackage {
  ecosystem?: string | null;
  package_name?: string | null;
  versions?: EcosystemsAdvisoryVersionWindow[] | null;
}

export interface EcosystemsAdvisory {
  uuid?: string | null;
  url?: string | null;
  html_url?: string | null;
  title?: string | null;
  severity?: string | null;
  published_at?: string | null;
  withdrawn_at?: string | null;
  identifiers?: string[] | null;
  /** Affected packages and their version windows, one entry per ecosystem. */
  packages?: EcosystemsAdvisoryPackage[] | null;
}

export interface EcosystemsPackage {
  name?: string | null;
  ecosystem?: string | null;
  /** `"deprecated"`, `"removed"`, `"unpublished"` … `null` when healthy. */
  status?: string | null;
  repository_url?: string | null;
  first_release_published_at?: string | null;
  latest_release_published_at?: string | null;
  latest_release_number?: string | null;
  versions_count?: number | null;
  dependent_packages_count?: number | null;
  dependent_repos_count?: number | null;
  downloads?: number | null;
  /** Period the `downloads` figure covers, e.g. `"last-month"`. */
  downloads_period?: string | null;
  last_synced_at?: string | null;
  advisories?: EcosystemsAdvisory[] | null;
  repo_metadata?: EcosystemsRepoMetadata | null;
  issue_metadata?: EcosystemsIssueMetadata | null;
}

// ---------------------------------------------------------------------------
// JSON narrowing
// ---------------------------------------------------------------------------

/** Keeps a declared type while proving the runtime value is really an object. */
function asObject<T extends object>(value: T | null | undefined): T | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : null;
}

function asList<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // The index occasionally serialises large counts as strings.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asBooleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Returns the timestamp unchanged when it parses, so provenance is preserved. */
function asTimestamp(value: unknown): string | null {
  const text = asString(value);
  if (text === null) return null;
  return Number.isFinite(Date.parse(text)) ? text : null;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export function ecosystemsPackageUrl(name: string): string {
  // `@scope/pkg` must arrive as `%40scope%2Fpkg`; encodeURIComponent does both.
  return `${ECOSYSTEMS_PACKAGE_BASE}/${encodeURIComponent(name)}`;
}

export async function fetchEcosystemsPackage(
  http: HttpClient,
  name: string,
): Promise<EcosystemsPackage | null> {
  if (name.trim() === '') return null;
  const doc = await http.getJson<EcosystemsPackage>(ecosystemsPackageUrl(name));
  return asObject(doc);
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Pulls the affected-version window out of an advisory's `packages` block.
 *
 * The block covers every ecosystem the advisory touches, so entries are matched
 * on package name where possible; a single-entry block is taken as-is, since
 * advisories mirrored from other sources sometimes omit the name.
 */
function extractAffectedRange(
  advisory: EcosystemsAdvisory,
  packageName: string,
): { vulnerableRange: string | null; firstPatchedVersion: string | null } {
  const entries = asList(advisory.packages)
    .map((entry) => asObject(entry))
    .filter((entry): entry is EcosystemsAdvisoryPackage => entry !== null);

  const wanted = packageName.toLowerCase();
  const match =
    entries.find((entry) => asString(entry.package_name)?.toLowerCase() === wanted) ??
    (entries.length === 1 ? entries[0] : undefined);
  if (match === undefined) return { vulnerableRange: null, firstPatchedVersion: null };

  const window = asList(match.versions)
    .map((entry) => asObject(entry))
    .find((entry): entry is EcosystemsAdvisoryVersionWindow => entry !== null);
  if (window === undefined) return { vulnerableRange: null, firstPatchedVersion: null };

  return {
    vulnerableRange: asString(window.vulnerable_version_range),
    firstPatchedVersion: asString(window.first_patched_version),
  };
}

function mapAdvisories(
  raw: EcosystemsAdvisory[] | null | undefined,
  packageName: string,
): AdvisorySummary[] {
  const out: AdvisorySummary[] = [];
  for (const entry of asList(raw)) {
    const advisory = asObject(entry);
    if (advisory === null) continue;
    // Withdrawn advisories were retracted upstream; reporting them is noise.
    if (asString(advisory.withdrawn_at) !== null) continue;

    const identifiers = asList(advisory.identifiers)
      .map((id) => asString(id))
      .filter((id): id is string => id !== null);
    const url = asString(advisory.url) ?? asString(advisory.html_url);
    const id = identifiers[0] ?? asString(advisory.uuid) ?? url;
    if (id === null) continue;

    const severity = asString(advisory.severity);
    const { vulnerableRange, firstPatchedVersion } = extractAffectedRange(advisory, packageName);
    out.push({
      id,
      title: asString(advisory.title) ?? id,
      severity: severity === null ? null : severity.toLowerCase(),
      url: url ?? `https://github.com/advisories/${encodeURIComponent(id)}`,
      publishedAt: asTimestamp(advisory.published_at),
      vulnerableRange,
      firstPatchedVersion,
      // Resolved once the latest version is known; see applyEcosystemsSignals.
      affectsLatest: null,
    });
  }
  return out;
}

/**
 * Marks each advisory as still-open-against-the-newest-release or already
 * fixed, now that the latest version is known.
 *
 * Safe to call repeatedly: sources land in any order, and `latestVersion` may
 * only be filled in by whichever source answered second.
 */
export function resolveAdvisoryApplicability(signals: PackageSignals): void {
  if (signals.openAdvisories.length === 0) return;
  signals.openAdvisories = signals.openAdvisories.map((advisory) => ({
    ...advisory,
    affectsLatest: advisoryAffectsVersion(
      signals.latestVersion,
      advisory.vulnerableRange,
      advisory.firstPatchedVersion,
    ),
  }));
}

/**
 * Folds an ecosyste.ms document into `signals`. Only fields the document
 * actually carries are written, so the caller may apply sources in any order.
 */
export function applyEcosystemsSignals(
  signals: PackageSignals,
  pkg: EcosystemsPackage,
): void {
  const repo = asObject(pkg.repo_metadata);
  const commits = asObject(repo?.commit_stats);
  const issues = asObject(pkg.issue_metadata);

  signals.registryStatus = asString(pkg.status) ?? signals.registryStatus;
  signals.repositoryUrl =
    asString(pkg.repository_url) ?? asString(repo?.html_url) ?? signals.repositoryUrl;
  signals.repoArchived = asBooleanOrNull(repo?.archived) ?? signals.repoArchived;
  signals.repoPushedAt = asTimestamp(repo?.pushed_at) ?? signals.repoPushedAt;

  signals.latestReleaseAt =
    asTimestamp(pkg.latest_release_published_at) ?? signals.latestReleaseAt;
  signals.firstReleaseAt =
    asTimestamp(pkg.first_release_published_at) ?? signals.firstReleaseAt;
  signals.latestVersion = asString(pkg.latest_release_number) ?? signals.latestVersion;
  signals.versionsCount = asFiniteNumber(pkg.versions_count) ?? signals.versionsCount;

  signals.dependentPackagesCount =
    asFiniteNumber(pkg.dependent_packages_count) ?? signals.dependentPackagesCount;
  signals.dependentReposCount =
    asFiniteNumber(pkg.dependent_repos_count) ?? signals.dependentReposCount;

  const downloads = asFiniteNumber(pkg.downloads);
  const downloadsPeriod = asString(pkg.downloads_period);
  if (downloads !== null && (downloadsPeriod === null || downloadsPeriod === 'last-month')) {
    signals.downloadsLastMonth = downloads;
  }

  signals.developmentDistributionScore =
    asFiniteNumber(commits?.dds) ?? signals.developmentDistributionScore;
  signals.totalCommitters =
    asFiniteNumber(commits?.total_committers) ?? signals.totalCommitters;

  signals.pastYearIssues =
    asFiniteNumber(issues?.past_year_issues_count) ?? signals.pastYearIssues;
  signals.pastYearIssuesClosed =
    asFiniteNumber(issues?.past_year_issues_closed_count) ?? signals.pastYearIssuesClosed;
  signals.pastYearAvgCommentsPerIssue =
    asFiniteNumber(issues?.past_year_avg_comments_per_issue) ??
    signals.pastYearAvgCommentsPerIssue;
  signals.pastYearPullRequests =
    asFiniteNumber(issues?.past_year_pull_requests_count) ?? signals.pastYearPullRequests;
  signals.pastYearMergedPullRequests =
    asFiniteNumber(issues?.past_year_merged_pull_requests_count) ??
    signals.pastYearMergedPullRequests;

  if (issues !== null) {
    const logins: string[] = [];
    for (const entry of asList(issues.active_maintainers)) {
      const login = asString(asObject(entry)?.login);
      if (login !== null && !logins.includes(login)) logins.push(login);
    }
    // An empty list here is meaningful ("upstream sees nobody active"), so it
    // is written even when nothing was collected.
    signals.activeMaintainers = logins;
  }

  const advisories = mapAdvisories(pkg.advisories, signals.name);
  if (advisories.length > 0 || Array.isArray(pkg.advisories)) {
    signals.openAdvisories = advisories;
  }
  resolveAdvisoryApplicability(signals);

  signals.freshness.packageSyncedAt =
    asTimestamp(pkg.last_synced_at) ?? signals.freshness.packageSyncedAt;
  signals.freshness.repoSyncedAt =
    asTimestamp(repo?.last_synced_at) ?? signals.freshness.repoSyncedAt;
  signals.freshness.issuesSyncedAt =
    asTimestamp(issues?.last_synced_at) ?? signals.freshness.issuesSyncedAt;
}

function ageInDays(timestamp: string, now: number): number | null {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  return (now - parsed) / MS_PER_DAY;
}

/** True when the issue index returned nothing usable for this package. */
export function hasIssueData(signals: PackageSignals): boolean {
  return (
    signals.freshness.issuesSyncedAt !== null ||
    signals.pastYearIssues !== null ||
    signals.pastYearPullRequests !== null
  );
}

/**
 * A verdict resting on two-year-old issue counts must be labelled as such.
 * Stale when any sync timestamp has aged past the threshold, when we never
 * reached the index at all, or when issue data is missing entirely.
 */
export function computeFreshnessStale(
  signals: PackageSignals,
  now: number = Date.now(),
): boolean {
  if (!hasIssueData(signals)) return true;
  const { packageSyncedAt, repoSyncedAt, issuesSyncedAt } = signals.freshness;
  if (packageSyncedAt === null) return true;
  for (const timestamp of [packageSyncedAt, repoSyncedAt, issuesSyncedAt]) {
    if (timestamp === null) continue;
    const age = ageInDays(timestamp, now);
    if (age !== null && age > STALENESS_THRESHOLD_DAYS) return true;
  }
  return false;
}
