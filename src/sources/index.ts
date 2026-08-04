/**
 * Signal gathering.
 *
 * Two independent upstreams describe a package: the ecosyste.ms index (broad,
 * rich, often months behind) and the npm registry (narrow, authoritative,
 * live). This module fires both, merges them into one `PackageSignals`, and
 * records what it could not learn instead of guessing.
 */

import type { PackageSignals } from '../types.js';
import type { HttpClient } from './http.js';
import {
  applyEcosystemsSignals,
  resolveAdvisoryApplicability,
  computeFreshnessStale,
  fetchEcosystemsPackage,
} from './ecosystems.js';
import { applyNpmSignals, fetchNpmPackument } from './npm.js';

export { HttpClient } from './http.js';
export type { HttpClientOptions } from './http.js';
export {
  applyEcosystemsSignals,
  resolveAdvisoryApplicability,
  computeFreshnessStale,
  ecosystemsPackageUrl,
  fetchEcosystemsPackage,
  hasIssueData,
  STALENESS_THRESHOLD_DAYS,
} from './ecosystems.js';
export type { EcosystemsPackage } from './ecosystems.js';
export {
  applyNpmSignals,
  fetchNpmPackument,
  medianReleaseGapDays,
  normaliseDeprecation,
  npmPackumentUrl,
} from './npm.js';
export type { NpmPackument } from './npm.js';

/** A `PackageSignals` in which nothing is known yet. */
export function emptySignals(name: string): PackageSignals {
  return {
    name,
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
      packageSyncedAt: null,
      repoSyncedAt: null,
      issuesSyncedAt: null,
      stale: true,
    },
    errors: [],
  };
}

type SourceOutcome<T> =
  | { readonly ok: true; readonly value: T | null }
  | { readonly ok: false; readonly reason: string };

async function attempt<T>(load: () => Promise<T | null>): Promise<SourceOutcome<T>> {
  try {
    return { ok: true, value: await load() };
  } catch (error) {
    return { ok: false, reason: describeError(error) };
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause instanceof Error && cause.message !== '' && cause.message !== error.message) {
      return `${error.message} (${cause.message})`;
    }
    return error.message === '' ? error.name : error.message;
  }
  return String(error);
}

/**
 * Collects everything known about one package. Never throws: a package whose
 * sources all fail still produces signals, with the failures listed in
 * `errors` so the report can say what it does not know.
 */
export async function gatherSignals(
  http: HttpClient,
  name: string,
): Promise<PackageSignals> {
  const trimmed = name.trim();
  const signals = emptySignals(trimmed === '' ? name : trimmed);

  if (trimmed === '') {
    signals.errors.push('Empty package name; nothing to look up.');
    return signals;
  }

  const [ecosystems, npm] = await Promise.all([
    attempt(() => fetchEcosystemsPackage(http, trimmed)),
    attempt(() => fetchNpmPackument(http, trimmed)),
  ]);

  if (!ecosystems.ok) {
    signals.errors.push(`ecosyste.ms lookup failed: ${ecosystems.reason}`);
  } else if (ecosystems.value === null) {
    signals.errors.push(
      `ecosyste.ms has no record of "${trimmed}" (not indexed, or the request was given up on).`,
    );
  } else {
    applyEcosystemsSignals(signals, ecosystems.value);
  }

  const npmAnswered = npm.ok && npm.value !== null;
  if (!npm.ok) {
    signals.errors.push(`npm registry lookup failed: ${npm.reason}`);
  } else if (npm.value === null) {
    signals.errors.push(
      `npm registry returned no packument for "${trimmed}" (unpublished, private, or the request was given up on).`,
    );
  } else {
    applyNpmSignals(signals, npm.value);
  }

  reconcileDeprecation(signals, npmAnswered);
  // Re-run now that both sources have landed: npm often supplies the latest
  // version, and advisory applicability cannot be decided without it.
  resolveAdvisoryApplicability(signals);
  signals.freshness.stale = computeFreshnessStale(signals);
  return signals;
}

/**
 * npm's deprecation flag is live and authoritative; ecosyste.ms' `status` is a
 * cached derivative of it. When they disagree npm wins — but the disagreement
 * itself is worth surfacing, since it usually means the index is out of date.
 */
function reconcileDeprecation(signals: PackageSignals, npmAnswered: boolean): void {
  if (signals.deprecationMessage !== null) {
    signals.registryStatus = 'deprecated';
    return;
  }
  if (npmAnswered && signals.registryStatus === 'deprecated') {
    signals.registryStatus = null;
    signals.errors.push(
      `ecosyste.ms lists "${signals.name}" as deprecated but the npm registry shows no deprecation on ` +
        `${signals.latestVersion ?? 'the latest version'}; trusting npm.`,
    );
  }
}
