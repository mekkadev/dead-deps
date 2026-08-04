/**
 * The verdict engine.
 *
 * Everything here exists to solve one problem: a small, finished, perfectly
 * healthy package looks identical to a dead one if you only read the last
 * release date. `ms`, `inherits`, `once`, `wrappy` and `isarray` have shipped
 * nothing for years because there is nothing left to ship. A tool that flags
 * them is worthless, so this file is written for precision, not recall.
 *
 * The shape of the computation:
 *
 *   1. Turn signals into `Evidence`, each with a signed weight and, wherever
 *      one exists, a URL a human can click to check the claim. Negative
 *      weights argue the package is alive; positive weights argue it is not.
 *   2. Sum the weights and squash the sum through a logistic curve into 0..100.
 *      The curve is monotone and unbounded on input, so a new signal can be
 *      added later without rebalancing the existing ones — it just moves the
 *      package along the curve.
 *   3. Pick a state from decisive overrides first, then from the score.
 *   4. Clamp the score into the band that belongs to the chosen state, so the
 *      number and the word can never contradict each other.
 *
 * Every threshold is an exported constant: the calibration harness tunes them
 * from the outside and a reviewer can audit them without reading the logic.
 */

import { STATE_SEVERITY } from '../types.js';
import type {
  AdvisorySummary,
  Assessment,
  Evidence,
  EvidenceKind,
  MaintenanceState,
  PackageSignals,
} from '../types.js';

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Score shaping
// ---------------------------------------------------------------------------

/** Weight sum that maps to a score of 50. */
export const SCORE_CENTER = 30;
/** Weight units per unit of logistic input. Larger = gentler curve. */
export const SCORE_SLOPE = 18;

/** Base score at or above which a package is at least `low-activity`. */
export const LOW_ACTIVITY_SCORE = 25;
/** Base score at or above which a package is at least `unmaintained`. */
export const UNMAINTAINED_SCORE = 45;

/**
 * The score a verdict is allowed to carry. Bands are ordered exactly like
 * `STATE_SEVERITY`, which is what keeps `state` and `score` consistent: the
 * state is chosen first, then the score is clamped into its band.
 */
export const STATE_SCORE_BANDS: Record<MaintenanceState, readonly [number, number]> = {
  active: [0, 24],
  'stable-complete': [0, 20],
  unknown: [0, 45],
  'low-activity': [LOW_ACTIVITY_SCORE, 44],
  unmaintained: [UNMAINTAINED_SCORE, 69],
  deprecated: [70, 89],
  abandoned: [82, 96],
  'hijack-risk': [88, 100],
};

// ---------------------------------------------------------------------------
// Release cadence
// ---------------------------------------------------------------------------

/** A release this recent settles the question: the package is alive. */
export const FRESH_RELEASE_DAYS = 180;
/** Below this, silence is never held against a package. */
export const MIN_SILENCE_DAYS = 365;
export const LONG_SILENCE_DAYS = 730;
export const VERY_LONG_SILENCE_DAYS = 1825;
/** Cadences below this are treated as this, so bursty packages do not divide by ~0. */
export const CADENCE_FLOOR_DAYS = 14;
/** Silence worth mentioning, as a multiple of the package's own median gap. */
export const SILENCE_MILD_MULTIPLE = 3;
/** Silence that is hard to explain as normal rhythm. */
export const SILENCE_SEVERE_MULTIPLE = 6;

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export const FRESH_PUSH_DAYS = 180;
export const STALE_PUSH_DAYS = 730;

// ---------------------------------------------------------------------------
// Issue responsiveness
// ---------------------------------------------------------------------------

/** Fewer issues than this in a year is too small a sample to judge. */
export const ISSUE_SAMPLE_MIN = 5;
export const ISSUE_CLOSE_RATE_DEAD = 0.15;
export const ISSUE_CLOSE_RATE_WEAK = 0.4;
export const ISSUE_CLOSE_RATE_HEALTHY = 0.6;
/** Average comments per issue below this means nobody even replied. */
export const ISSUE_SILENT_COMMENTS = 0.5;
export const PR_SAMPLE_MIN = 3;

// ---------------------------------------------------------------------------
// Bus factor
// ---------------------------------------------------------------------------

/** Development Distribution Score at or below this: effectively one author. */
export const DDS_SOLO_AUTHOR = 0.15;
export const DDS_DISTRIBUTED = 0.5;

// ---------------------------------------------------------------------------
// Advisories
// ---------------------------------------------------------------------------

/** An advisory younger than this has not had a fair chance at a fix yet. */
export const ADVISORY_UNPATCHED_GRACE_DAYS = 180;
export const ADVISORY_SEVERITY_WEIGHT: Record<string, number> = {
  critical: 20,
  high: 16,
  moderate: 10,
  medium: 10,
  low: 6,
};
export const ADVISORY_DEFAULT_WEIGHT = 10;
/** Added on top of severity when no release shipped after publication. */
export const ADVISORY_UNPATCHED_BONUS = 8;
/** Total positive weight advisories may contribute, however many there are. */
export const ADVISORY_WEIGHT_CAP = 42;
/** Advisories listed individually before the rest are summarised in one line. */
export const ADVISORY_DISPLAY_LIMIT = 5;

// ---------------------------------------------------------------------------
// Adoption and blast radius
// ---------------------------------------------------------------------------

export const ADOPTION_DEPENDENTS = 500;
export const ADOPTION_DOWNLOADS = 5_000_000;
export const STRONG_ADOPTION_DEPENDENTS = 5_000;
export const STRONG_ADOPTION_DOWNLOADS = 20_000_000;
/** Dependents above which an unattended package is a takeover target. */
export const HIJACK_DEPENDENTS = 250;

// ---------------------------------------------------------------------------
// The stable-complete guard
// ---------------------------------------------------------------------------

/** A package must have been around this long before "it converged" is credible. */
export const STABLE_COMPLETE_MIN_AGE_DAYS = 1825;
/** Releases per year at or below this means the package stopped changing. */
export const STABLE_COMPLETE_MAX_VERSIONS_PER_YEAR = 4;
/** Open issues from the trailing year that nobody closed. */
export const STABLE_COMPLETE_MAX_UNANSWERED_ISSUES = 6;

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/** Fewer known facts than this and the honest answer is `unknown`. */
export const MIN_KNOWN_SIGNAL_FIELDS = 2;

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

/** Signed contribution of each signal. Negative argues the package is alive. */
export const WEIGHTS = {
  deprecated: 55,
  deprecatedIndexOnly: 40,
  registryRemoved: 30,
  repoArchived: 40,
  repoMissing: 6,

  releaseFresh: -20,
  releaseWithinCadence: -8,
  releaseEarlyQuiet: 4,
  releaseSilenceMild: 8,
  releaseSilenceSevere: 16,
  releaseSilenceYear: 2,
  releaseSilenceLong: 6,
  releaseSilenceVeryLong: 10,

  pushFresh: -10,
  pushStale: 6,

  issuesUnanswered: 18,
  issuesSlow: 8,
  issuesNoDiscussion: 4,
  issuesResponsive: -14,
  issuesNoDemand: -8,
  prsMerged: -10,
  prsIgnored: 10,

  busFactorSolo: 6,
  busFactorDistributed: -6,
  maintainersNone: 12,
  maintainersActive: -12,

  adoption: -6,
  adoptionStrong: -10,

  advisoryOverflow: 6,
  hijackProfile: 15,
  stableComplete: -25,
  stableCompleteConverged: -6,
} as const;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function evidence(
  kind: EvidenceKind,
  label: string,
  weight: number,
  url?: string | null,
  observedAt?: string | null,
): Evidence {
  const item: Evidence = { kind, label, weight };
  if (typeof url === 'string' && url !== '') item.url = url;
  if (typeof observedAt === 'string' && observedAt !== '') item.observedAt = observedAt;
  return item;
}

function daysSince(timestamp: string | null, now: number): number | null {
  if (timestamp === null) return null;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, (now - parsed) / MS_PER_DAY);
}

function duration(days: number): string {
  const whole = Math.round(days);
  if (whole < 45) return `${whole} day${whole === 1 ? '' : 's'}`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} month${months === 1 ? '' : 's'}`;
  return `${(days / 365.25).toFixed(1)} years`;
}

function count(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function ratio(value: number): string {
  return value >= 10 ? `${Math.round(value)}x` : `${value.toFixed(1)}x`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function npmPackageUrl(name: string): string {
  return `https://www.npmjs.com/package/${name}`;
}

/** Where a human should be sent to check a repository-shaped claim. */
function repoOrRegistryUrl(signals: PackageSignals): string {
  return signals.repositoryUrl ?? npmPackageUrl(signals.name);
}

// ---------------------------------------------------------------------------
// Deprecation messages
// ---------------------------------------------------------------------------

const PACKAGE_NAME_SOURCE = '((?:@[a-z0-9~][a-z0-9._~-]*/)?[a-z0-9~][a-z0-9._~-]*)';

/**
 * Deprecation notices are free text, but the useful ones all say the same
 * handful of things. Naming the replacement in the evidence label is the
 * difference between "this is dead" and "here is where everyone went".
 */
const REPLACEMENT_PATTERNS: readonly RegExp[] = [
  new RegExp(`\\buse\\s+${PACKAGE_NAME_SOURCE}\\s+instead`, 'i'),
  new RegExp(`\\b(?:replaced|superseded|succeeded)\\s+by\\s+${PACKAGE_NAME_SOURCE}`, 'i'),
  new RegExp(`\\bin\\s+favou?r\\s+of\\s+${PACKAGE_NAME_SOURCE}`, 'i'),
  new RegExp(`\\b(?:switch|switched|move|moved|migrate|migrated|rename|renamed|upgrade)\\s+to\\s+${PACKAGE_NAME_SOURCE}`, 'i'),
  new RegExp(`\\bnpm\\s+(?:i|install|add)\\s+${PACKAGE_NAME_SOURCE}`, 'i'),
  new RegExp(`\\buse\\s+${PACKAGE_NAME_SOURCE}`, 'i'),
  new RegExp(`\\bsee\\s+${PACKAGE_NAME_SOURCE}\\s+instead`, 'i'),
];

/** Words that match the package-name shape but never name a package. */
const NOT_A_PACKAGE = new Set([
  'a', 'an', 'and', 'any', 'anything', 'another', 'com', 'github', 'http', 'https',
  'instead', 'it', 'latest', 'longer', 'maintained', 'new', 'newer', 'no', 'node',
  'npm', 'org', 'other', 'our', 'please', 'something', 'supported', 'that', 'the',
  'this', 'to', 'version', 'versions', 'www', 'yarn', 'your',
]);

/**
 * Pulls the replacement package out of a deprecation notice, or `null` when
 * the notice does not name one. Conservative on purpose: a wrong package name
 * in the output is worse than no package name.
 */
export function extractReplacement(message: string, self: string): string | null {
  const cleaned = message.replace(/[`'"*“”]/g, ' ');
  for (const pattern of REPLACEMENT_PATTERNS) {
    const match = pattern.exec(cleaned);
    const captured = match?.[1];
    if (captured === undefined) continue;

    // `foo@^2.0.0` names `foo`; a bare scope (`@babel/`) names nothing.
    const at = captured.indexOf('@', 1);
    const name = (at === -1 ? captured : captured.slice(0, at)).toLowerCase();

    if (name === '' || name.endsWith('/')) continue;
    if (NOT_A_PACKAGE.has(name)) continue;
    if (/^\d/.test(name)) continue;
    if (name === self.toLowerCase()) continue;
    return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Derived facts
// ---------------------------------------------------------------------------

type Adoption = 'none' | 'some' | 'strong';

interface DerivedFacts {
  readonly deprecated: boolean;
  readonly deprecationFromIndexOnly: boolean;
  readonly registryGone: boolean;
  readonly archived: boolean;
  readonly silenceDays: number | null;
  readonly cadenceDays: number | null;
  readonly silenceRatio: number | null;
  readonly quiet: boolean;
  readonly pushDays: number | null;
  readonly ageDays: number | null;
  readonly versionsPerYear: number | null;
  readonly hasIssueData: boolean;
  readonly closeRate: number | null;
  readonly unansweredIssues: number | null;
  readonly issuesIgnored: boolean;
  readonly adoption: Adoption;
  readonly unpatchedAdvisories: readonly AdvisorySummary[];
  readonly knownFields: number;
}

function deriveFacts(signals: PackageSignals, now: number): DerivedFacts {
  const status = signals.registryStatus?.toLowerCase() ?? null;
  const deprecationFromIndexOnly =
    signals.deprecationMessage === null && status === 'deprecated';

  const silenceDays = daysSince(signals.latestReleaseAt, now);
  const rawCadence = signals.historicalReleaseCadenceDays;
  const cadenceDays = rawCadence !== null && rawCadence > 0 ? rawCadence : null;
  const silenceRatio =
    silenceDays === null || cadenceDays === null
      ? null
      : silenceDays / Math.max(cadenceDays, CADENCE_FLOOR_DAYS);

  const ageDays = daysSince(signals.firstReleaseAt, now);
  const versionsPerYear =
    ageDays !== null && ageDays >= 365 && signals.versionsCount !== null
      ? signals.versionsCount / (ageDays / 365.25)
      : null;

  const issues = signals.pastYearIssues;
  const closed = signals.pastYearIssuesClosed ?? 0;
  const closeRate = issues !== null && issues > 0 ? Math.min(1, closed / issues) : null;
  const unansweredIssues = issues === null ? null : Math.max(0, issues - closed);

  const dependents = signals.dependentPackagesCount ?? 0;
  const downloads = signals.downloadsLastMonth ?? 0;
  let adoption: Adoption = 'none';
  if (dependents >= STRONG_ADOPTION_DEPENDENTS || downloads >= STRONG_ADOPTION_DOWNLOADS) {
    adoption = 'strong';
  } else if (dependents >= ADOPTION_DEPENDENTS || downloads >= ADOPTION_DOWNLOADS) {
    adoption = 'some';
  }

  const latestReleaseMs =
    signals.latestReleaseAt === null ? null : Date.parse(signals.latestReleaseAt);
  const unpatchedAdvisories = applicableAdvisories(signals).filter((advisory) => {
    const publishedMs =
      advisory.publishedAt === null ? null : Date.parse(advisory.publishedAt);
    if (publishedMs === null || !Number.isFinite(publishedMs)) return false;
    if (
      latestReleaseMs !== null &&
      Number.isFinite(latestReleaseMs) &&
      latestReleaseMs > publishedMs
    ) {
      return false;
    }
    return (now - publishedMs) / MS_PER_DAY >= ADVISORY_UNPATCHED_GRACE_DAYS;
  });

  const knownFields = [
    signals.latestReleaseAt !== null,
    signals.repoArchived !== null,
    signals.repoPushedAt !== null,
    signals.versionsCount !== null,
    signals.dependentPackagesCount !== null,
    signals.downloadsLastMonth !== null,
    signals.pastYearIssues !== null,
    signals.historicalReleaseCadenceDays !== null,
  ].filter(Boolean).length;

  return {
    deprecated: signals.deprecationMessage !== null || status === 'deprecated',
    deprecationFromIndexOnly,
    registryGone: status === 'removed' || status === 'unpublished',
    archived: signals.repoArchived === true,
    silenceDays,
    cadenceDays,
    silenceRatio,
    quiet: silenceDays !== null && silenceDays >= MIN_SILENCE_DAYS,
    pushDays: daysSince(signals.repoPushedAt, now),
    ageDays,
    versionsPerYear,
    hasIssueData:
      signals.freshness.issuesSyncedAt !== null ||
      signals.pastYearIssues !== null ||
      signals.pastYearPullRequests !== null,
    closeRate,
    unansweredIssues,
    issuesIgnored:
      issues !== null &&
      issues >= ISSUE_SAMPLE_MIN &&
      closeRate !== null &&
      closeRate <= ISSUE_CLOSE_RATE_WEAK,
    adoption,
    unpatchedAdvisories,
    knownFields,
  };
}

// ---------------------------------------------------------------------------
// Evidence collectors
// ---------------------------------------------------------------------------

function collectRegistryEvidence(
  signals: PackageSignals,
  facts: DerivedFacts,
  out: Evidence[],
): void {
  const url = npmPackageUrl(signals.name);

  if (signals.deprecationMessage !== null) {
    const message = truncate(signals.deprecationMessage, 160);
    const replacement = extractReplacement(signals.deprecationMessage, signals.name);
    const label =
      replacement === null
        ? `Deprecated on npm: "${message}"`
        : `Deprecated on npm, and the notice names "${replacement}" as the replacement: "${message}"`;
    out.push(
      evidence('registry-deprecation', label, WEIGHTS.deprecated, url, signals.freshness.packageSyncedAt),
    );
  } else if (facts.deprecationFromIndexOnly) {
    out.push(
      evidence(
        'registry-deprecation',
        'The ecosyste.ms index reports this package as deprecated on the registry; npm’s own record could not be read to confirm the wording.',
        WEIGHTS.deprecatedIndexOnly,
        url,
        signals.freshness.packageSyncedAt,
      ),
    );
  }

  if (facts.registryGone) {
    out.push(
      evidence(
        'registry-deprecation',
        `The registry lists this package as ${signals.registryStatus}; installs that resolve it today may stop working.`,
        WEIGHTS.registryRemoved,
        url,
        signals.freshness.packageSyncedAt,
      ),
    );
  }
}

function collectRepositoryEvidence(
  signals: PackageSignals,
  facts: DerivedFacts,
  out: Evidence[],
): void {
  if (facts.archived) {
    out.push(
      evidence(
        'repo-archived',
        'The source repository is archived: it is read-only, so no fix can be merged there.',
        WEIGHTS.repoArchived,
        signals.repositoryUrl,
        signals.freshness.repoSyncedAt,
      ),
    );
  }

  if (signals.repositoryUrl === null) {
    out.push(
      evidence(
        'repo-missing',
        'No repository is published on the registry, so there is no commit history to check.',
        WEIGHTS.repoMissing,
        npmPackageUrl(signals.name),
        signals.freshness.packageSyncedAt,
      ),
    );
    return;
  }

  if (facts.pushDays === null) return;

  if (facts.pushDays <= FRESH_PUSH_DAYS) {
    out.push(
      evidence(
        'commit-activity',
        `Commits were pushed to the repository ${duration(facts.pushDays)} ago.`,
        WEIGHTS.pushFresh,
        signals.repositoryUrl,
        signals.freshness.repoSyncedAt,
      ),
    );
  } else if (facts.pushDays >= STALE_PUSH_DAYS && !facts.archived) {
    out.push(
      evidence(
        'commit-activity',
        `No commits pushed to the repository in ${duration(facts.pushDays)}.`,
        WEIGHTS.pushStale,
        signals.repositoryUrl,
        signals.freshness.repoSyncedAt,
      ),
    );
  }
}

/**
 * Advisories the newest published version is still exposed to.
 *
 * An advisory that was fixed in a later release is evidence the maintainer
 * showed up, not evidence of abandonment — counting it flagged `ms@2.1.3` as a
 * hijack risk over a ReDoS patched back in 2.0.0. Applicability we could not
 * determine (`null`) keeps counting, because understating risk is worse than
 * overstating it.
 */
function applicableAdvisories(signals: PackageSignals): readonly AdvisorySummary[] {
  return signals.openAdvisories.filter((advisory) => advisory.affectsLatest !== false);
}

function advisoryBaseWeight(advisory: AdvisorySummary, unpatched: boolean): number {
  const severity = advisory.severity?.toLowerCase() ?? '';
  const base = ADVISORY_SEVERITY_WEIGHT[severity] ?? ADVISORY_DEFAULT_WEIGHT;
  // A release shipped after publication, so it may already carry the fix.
  return unpatched ? base + ADVISORY_UNPATCHED_BONUS : Math.round(base / 2);
}

function collectAdvisoryEvidence(
  signals: PackageSignals,
  facts: DerivedFacts,
  now: number,
  out: Evidence[],
): void {
  const advisories = applicableAdvisories(signals);
  if (advisories.length === 0) return;

  const unpatchedIds = new Set(facts.unpatchedAdvisories.map((advisory) => advisory.id));
  // Worst first, so the cap is spent on the advisories that matter.
  const ordered = [...advisories].sort((a, b) => {
    const aWeight = advisoryBaseWeight(a, unpatchedIds.has(a.id));
    const bWeight = advisoryBaseWeight(b, unpatchedIds.has(b.id));
    return bWeight - aWeight;
  });

  let budget = ADVISORY_WEIGHT_CAP;
  ordered.slice(0, ADVISORY_DISPLAY_LIMIT).forEach((advisory) => {
    const unpatched = unpatchedIds.has(advisory.id);
    const weight = Math.min(advisoryBaseWeight(advisory, unpatched), budget);
    budget -= weight;

    const severity = advisory.severity === null ? 'unrated' : advisory.severity;
    const age = daysSince(advisory.publishedAt, now);
    const timing =
      unpatched && age !== null
        ? ` — published ${duration(age)} ago with no release since`
        : age !== null
          ? ` — published ${duration(age)} ago; a release has shipped since, so it may already be fixed`
          : '';

    out.push(
      evidence(
        'security-advisory',
        `Open ${severity} advisory ${advisory.id}: ${truncate(advisory.title, 100)}${timing}.`,
        weight,
        advisory.url,
        advisory.publishedAt,
      ),
    );
  });

  const hidden = ordered.length - ADVISORY_DISPLAY_LIMIT;
  if (hidden > 0) {
    out.push(
      evidence(
        'security-advisory',
        `${count(hidden)} further open ${hidden === 1 ? 'advisory is' : 'advisories are'} recorded against this package.`,
        Math.min(WEIGHTS.advisoryOverflow, budget),
        `https://github.com/advisories?query=${encodeURIComponent(signals.name)}`,
      ),
    );
  }
}

function collectReleaseEvidence(
  signals: PackageSignals,
  facts: DerivedFacts,
  out: Evidence[],
): void {
  const { silenceDays, cadenceDays, silenceRatio } = facts;
  const url = npmPackageUrl(signals.name);
  const version = signals.latestVersion === null ? '' : ` (${signals.latestVersion})`;

  if (silenceDays === null) {
    out.push(
      evidence(
        'release-cadence',
        'No release date is available for this package, so its release rhythm could not be checked.',
        0,
        url,
      ),
    );
    return;
  }

  if (silenceDays <= FRESH_RELEASE_DAYS) {
    out.push(
      evidence(
        'release-cadence',
        `Released ${duration(silenceDays)} ago${version}.`,
        WEIGHTS.releaseFresh,
        url,
        signals.latestReleaseAt,
      ),
    );
    return;
  }

  if (cadenceDays !== null && silenceRatio !== null) {
    const rhythm = `its own median gap between releases is ${duration(cadenceDays)}`;
    if (silenceDays >= MIN_SILENCE_DAYS && silenceRatio >= SILENCE_SEVERE_MULTIPLE) {
      out.push(
        evidence(
          'release-cadence',
          `No release in ${duration(silenceDays)} — ${ratio(silenceRatio)} longer than this package has ever gone quiet before (${rhythm}).`,
          WEIGHTS.releaseSilenceSevere,
          url,
          signals.latestReleaseAt,
        ),
      );
    } else if (silenceDays >= MIN_SILENCE_DAYS && silenceRatio >= SILENCE_MILD_MULTIPLE) {
      out.push(
        evidence(
          'release-cadence',
          `No release in ${duration(silenceDays)}, about ${ratio(silenceRatio)} its usual gap (${rhythm}).`,
          WEIGHTS.releaseSilenceMild,
          url,
          signals.latestReleaseAt,
        ),
      );
    } else if (silenceDays >= MIN_SILENCE_DAYS) {
      // The quiet-but-normal case. This is the single most important negative
      // weight in the file: it is what stops `ms` from being called dead.
      out.push(
        evidence(
          'release-cadence',
          `Quiet for ${duration(silenceDays)}, but ${rhythm} — that is within this package’s normal rhythm.`,
          WEIGHTS.releaseWithinCadence,
          url,
          signals.latestReleaseAt,
        ),
      );
    } else if (silenceRatio >= SILENCE_MILD_MULTIPLE) {
      out.push(
        evidence(
          'release-cadence',
          `No release in ${duration(silenceDays)} from a package that normally ships every ${duration(cadenceDays)}.`,
          WEIGHTS.releaseEarlyQuiet,
          url,
          signals.latestReleaseAt,
        ),
      );
    }
    return;
  }

  // No cadence to compare against: fall back to absolute silence, gently.
  let weight = 0;
  if (silenceDays >= VERY_LONG_SILENCE_DAYS) weight = WEIGHTS.releaseSilenceVeryLong;
  else if (silenceDays >= LONG_SILENCE_DAYS) weight = WEIGHTS.releaseSilenceLong;
  else if (silenceDays >= MIN_SILENCE_DAYS) weight = WEIGHTS.releaseSilenceYear;
  if (weight === 0) return;

  out.push(
    evidence(
      'release-cadence',
      `No release in ${duration(silenceDays)}; too few releases exist to know what this package’s normal gap is.`,
      weight,
      url,
      signals.latestReleaseAt,
    ),
  );
}

function collectIssueEvidence(
  signals: PackageSignals,
  facts: DerivedFacts,
  out: Evidence[],
): void {
  const issues = signals.pastYearIssues;
  const url = signals.repositoryUrl;
  const observed = signals.freshness.issuesSyncedAt;

  if (issues !== null) {
    if (issues === 0) {
      out.push(
        evidence(
          'issue-responsiveness',
          'Nobody opened an issue in the past year. For a widely used package that usually means it works, not that it is unwatched.',
          facts.adoption === 'none' ? 0 : WEIGHTS.issuesNoDemand,
          url,
          observed,
        ),
      );
    } else if (issues < ISSUE_SAMPLE_MIN) {
      out.push(
        evidence(
          'issue-responsiveness',
          `Only ${count(issues)} issue${issues === 1 ? '' : 's'} opened in the past year — too few to judge responsiveness either way.`,
          0,
          url,
          observed,
        ),
      );
    } else {
      const closed = signals.pastYearIssuesClosed ?? 0;
      const rate = facts.closeRate ?? 0;
      const comments = signals.pastYearAvgCommentsPerIssue;
      const silentThread = comments !== null && comments <= ISSUE_SILENT_COMMENTS;
      const commentNote =
        comments === null ? '' : `, averaging ${comments.toFixed(1)} comments each`;
      const summary = `${count(issues)} issues opened in the past year, ${count(closed)} closed (${percent(rate)})${commentNote}`;

      if (rate <= ISSUE_CLOSE_RATE_DEAD) {
        out.push(
          evidence(
            'issue-responsiveness',
            `${summary} — people are asking and nobody is answering.`,
            WEIGHTS.issuesUnanswered + (silentThread ? WEIGHTS.issuesNoDiscussion : 0),
            url,
            observed,
          ),
        );
      } else if (rate <= ISSUE_CLOSE_RATE_WEAK) {
        out.push(
          evidence(
            'issue-responsiveness',
            `${summary} — most reports go unanswered.`,
            WEIGHTS.issuesSlow + (silentThread ? WEIGHTS.issuesNoDiscussion : 0),
            url,
            observed,
          ),
        );
      } else if (rate >= ISSUE_CLOSE_RATE_HEALTHY) {
        out.push(
          evidence(
            'issue-responsiveness',
            `${summary} — somebody is triaging.`,
            WEIGHTS.issuesResponsive,
            url,
            observed,
          ),
        );
      } else {
        out.push(evidence('issue-responsiveness', `${summary}.`, 0, url, observed));
      }
    }
  }

  const prs = signals.pastYearPullRequests;
  const merged = signals.pastYearMergedPullRequests;
  if (merged !== null && merged > 0) {
    out.push(
      evidence(
        'issue-responsiveness',
        `${count(merged)} pull request${merged === 1 ? '' : 's'} merged in the past year — someone with commit rights is still landing changes.`,
        WEIGHTS.prsMerged,
        url,
        observed,
      ),
    );
  } else if (prs !== null && prs >= PR_SAMPLE_MIN && (merged ?? 0) === 0) {
    out.push(
      evidence(
        'issue-responsiveness',
        `${count(prs)} pull requests opened in the past year and none merged — contributors are offering fixes that nobody lands.`,
        WEIGHTS.prsIgnored,
        url,
        observed,
      ),
    );
  }
}

function collectPeopleEvidence(
  signals: PackageSignals,
  facts: DerivedFacts,
  out: Evidence[],
): void {
  const url = signals.repositoryUrl;
  const observed = signals.freshness.issuesSyncedAt;

  if (signals.activeMaintainers.length > 0) {
    const names = signals.activeMaintainers.slice(0, 3).join(', ');
    const rest = signals.activeMaintainers.length - 3;
    out.push(
      evidence(
        'maintainer-activity',
        `Upstream still sees ${count(signals.activeMaintainers.length)} active maintainer${signals.activeMaintainers.length === 1 ? '' : 's'}: ${names}${rest > 0 ? ` and ${count(rest)} more` : ''}.`,
        WEIGHTS.maintainersActive,
        url,
        observed,
      ),
    );
  } else if (facts.hasIssueData) {
    // Only meaningful when the issue index answered: an empty list from a
    // source that returned nothing is absence of data, not absence of people.
    out.push(
      evidence(
        'maintainer-activity',
        'No maintainer has commented, closed an issue or merged a pull request in the past year.',
        WEIGHTS.maintainersNone,
        url,
        observed,
      ),
    );
  }

  const dds = signals.developmentDistributionScore;
  if (dds === null) return;
  const committers =
    signals.totalCommitters === null
      ? ''
      : `, ${count(signals.totalCommitters)} committer${signals.totalCommitters === 1 ? '' : 's'} in total`;

  if (dds <= DDS_SOLO_AUTHOR) {
    out.push(
      evidence(
        'bus-factor',
        `One author wrote effectively all of the code (distribution score ${dds.toFixed(2)} of 1.00${committers}): the bus factor is one.`,
        WEIGHTS.busFactorSolo,
        url,
        signals.freshness.repoSyncedAt,
      ),
    );
  } else if (dds >= DDS_DISTRIBUTED) {
    out.push(
      evidence(
        'bus-factor',
        `Commits are spread across several people (distribution score ${dds.toFixed(2)} of 1.00${committers}).`,
        WEIGHTS.busFactorDistributed,
        url,
        signals.freshness.repoSyncedAt,
      ),
    );
  }
}

function adoptionLabel(signals: PackageSignals): string {
  const parts: string[] = [];
  if (signals.dependentPackagesCount !== null) {
    parts.push(`${count(signals.dependentPackagesCount)} packages depend on it`);
  }
  if (signals.dependentReposCount !== null) {
    parts.push(`${count(signals.dependentReposCount)} repositories use it`);
  }
  if (signals.downloadsLastMonth !== null) {
    parts.push(`${count(signals.downloadsLastMonth)} downloads last month`);
  }
  return parts.join(', ');
}

function collectAdoptionEvidence(
  signals: PackageSignals,
  facts: DerivedFacts,
  out: Evidence[],
): void {
  if (facts.adoption === 'none') return;
  out.push(
    evidence(
      'dependent-flight',
      `Still widely relied on: ${adoptionLabel(signals)}.`,
      facts.adoption === 'strong' ? WEIGHTS.adoptionStrong : WEIGHTS.adoption,
      npmPackageUrl(signals.name),
      signals.freshness.packageSyncedAt,
    ),
  );
}

// ---------------------------------------------------------------------------
// The stable-complete guard
// ---------------------------------------------------------------------------

/**
 * Applied before any negative conclusion. A quiet package is *finished* rather
 * than abandoned when nothing is broken, nobody is waiting, the ecosystem
 * keeps depending on it, and its version history shows it converged years ago.
 *
 * Every clause here is a veto, and each one is deliberately hard to satisfy:
 * the cost of wrongly saying "finished" is one missed dead dependency, while
 * the cost of wrongly saying "abandoned" is the user deleting the tool.
 */
function isStableComplete(signals: PackageSignals, facts: DerivedFacts): boolean {
  if (!facts.quiet) return false;
  if (facts.deprecated || facts.registryGone) return false;
  if (facts.archived) return false;
  if (applicableAdvisories(signals).length > 0) return false;

  // The ecosystem has to be actively voting for the package.
  if (facts.adoption === 'none') return false;

  // Nobody may be waiting on a fix. With no issue data at all we can only
  // stand this claim up on overwhelming adoption.
  const demandIsSatisfied =
    facts.unansweredIssues === null
      ? facts.adoption === 'strong'
      : facts.unansweredIssues <= STABLE_COMPLETE_MAX_UNANSWERED_ISSUES;
  if (!demandIsSatisfied) return false;

  // Contributors must not be queueing up unmerged fixes either.
  const prs = signals.pastYearPullRequests ?? 0;
  if (prs >= PR_SAMPLE_MIN && (signals.pastYearMergedPullRequests ?? 0) === 0) return false;

  // And it must have actually converged: old, with few versions for its age.
  if (facts.ageDays === null || facts.ageDays < STABLE_COMPLETE_MIN_AGE_DAYS) return false;
  if (facts.versionsPerYear === null) return false;
  if (facts.versionsPerYear > STABLE_COMPLETE_MAX_VERSIONS_PER_YEAR) return false;

  return true;
}

function collectStableCompleteEvidence(
  signals: PackageSignals,
  facts: DerivedFacts,
  out: Evidence[],
): void {
  const reasons: string[] = ['not deprecated', 'repository not archived', 'no open advisories'];
  if (facts.unansweredIssues !== null) {
    reasons.push(
      facts.unansweredIssues === 0
        ? 'no unanswered issues from the past year'
        : `only ${count(facts.unansweredIssues)} unanswered issues from the past year`,
    );
  }
  const adoption = adoptionLabel(signals);
  if (adoption !== '') reasons.push(adoption);

  out.push(
    evidence(
      'stability-heuristic',
      `Not flagged: this looks finished rather than abandoned — ${reasons.join('; ')}.`,
      WEIGHTS.stableComplete,
      repoOrRegistryUrl(signals),
      signals.freshness.packageSyncedAt,
    ),
  );

  if (facts.versionsPerYear !== null && facts.ageDays !== null && signals.versionsCount !== null) {
    out.push(
      evidence(
        'stability-heuristic',
        `${count(signals.versionsCount)} versions in ${duration(facts.ageDays)} (${facts.versionsPerYear.toFixed(1)} per year): the API converged long ago and the silence is the expected end state.`,
        WEIGHTS.stableCompleteConverged,
        npmPackageUrl(signals.name),
        signals.latestReleaseAt,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Hijack risk
// ---------------------------------------------------------------------------

/**
 * An unattended package with a large blast radius is the classic supply-chain
 * takeover target. Both routes here require at least one open advisory — a
 * quiet package with nothing wrong with it is not a security finding — and
 * both are vetoed by visible attendance.
 */
function hijackEvidence(
  signals: PackageSignals,
  facts: DerivedFacts,
  out: Evidence[],
): boolean {
  if (applicableAdvisories(signals).length === 0) return false;

  // Somebody visibly minding the shop rules out both routes: an open advisory
  // on a slow but attended package is a bug report, not a takeover target.
  const attended =
    signals.activeMaintainers.length > 0 &&
    facts.closeRate !== null &&
    facts.closeRate >= ISSUE_CLOSE_RATE_HEALTHY;
  if (attended) return false;

  const unattended =
    signals.activeMaintainers.length === 0 &&
    facts.hasIssueData &&
    (facts.quiet || facts.issuesIgnored);

  const unpatched = facts.unpatchedAdvisories.length;
  const dependents = signals.dependentPackagesCount ?? 0;

  const viaUnpatched = unpatched > 0 && facts.quiet;
  const viaBlastRadius = unattended && dependents >= HIJACK_DEPENDENTS;
  if (!viaUnpatched && !viaBlastRadius) return false;

  const reach =
    adoptionLabel(signals) === ''
      ? 'it is still installed downstream'
      : adoptionLabel(signals);
  const lead = viaUnpatched
    ? `${count(unpatched)} advisor${unpatched === 1 ? 'y has' : 'ies have'} been open for months with no release to fix ${unpatched === 1 ? 'it' : 'them'}`
    : 'advisories are open against a package with nobody attending to it';

  out.push(
    evidence(
      'security-advisory',
      `Supply-chain exposure: ${lead}, while ${reach}. An unattended package with this much reach is the profile attackers look for.`,
      WEIGHTS.hijackProfile,
      npmPackageUrl(signals.name),
      signals.freshness.packageSyncedAt,
    ),
  );
  return true;
}

// ---------------------------------------------------------------------------
// Score and state
// ---------------------------------------------------------------------------

/** Squashes an unbounded signed weight sum into 0..100, monotonically. */
export function scoreFromWeight(total: number): number {
  return Math.round(100 / (1 + Math.exp(-(total - SCORE_CENTER) / SCORE_SLOPE)));
}

function clampToBand(score: number, state: MaintenanceState): number {
  const [min, max] = STATE_SCORE_BANDS[state];
  return Math.min(max, Math.max(min, score));
}

function decideState(
  signals: PackageSignals,
  facts: DerivedFacts,
  base: number,
  hijack: boolean,
  stableComplete: boolean,
): MaintenanceState {
  if (hijack) return 'hijack-risk';
  if (facts.registryGone) return 'abandoned';

  const longSilence = facts.silenceDays !== null && facts.silenceDays >= LONG_SILENCE_DAYS;

  // A formal deprecation outranks every inferred verdict. It is the one fact
  // stated by the maintainer rather than deduced from silence, it is usually
  // accompanied by a named replacement, and reporting such a package as merely
  // "abandoned" would discard the strongest thing we know about it. Whatever
  // else is true — archived repository, years of quiet — the honest word is
  // still `deprecated`. `abandoned` is reserved for packages that died without
  // anyone saying so, which leaves the user with no notice and no pointer.
  if (facts.deprecated) return 'deprecated';
  if (facts.archived && longSilence) return 'abandoned';

  if (stableComplete) return 'stable-complete';

  const nothingToJudge =
    signals.latestReleaseAt === null && signals.repoPushedAt === null && !facts.hasIssueData;
  if (nothingToJudge || facts.knownFields < MIN_KNOWN_SIGNAL_FIELDS) return 'unknown';

  // Archived without the long silence: the repo is closed but the release is
  // recent enough that a successor tag or a final publish may still land.
  if (facts.archived) return 'unmaintained';

  if (base >= UNMAINTAINED_SCORE) return 'unmaintained';
  if (base >= LOW_ACTIVITY_SCORE) return 'low-activity';
  return 'active';
}

function decideConfidence(
  signals: PackageSignals,
  facts: DerivedFacts,
  state: MaintenanceState,
): Assessment['confidence'] {
  if (state === 'unknown') return 'low';

  const noRepoMetadata =
    signals.repositoryUrl === null &&
    signals.repoArchived === null &&
    signals.repoPushedAt === null;
  if (signals.freshness.stale || signals.errors.length > 0 || noRepoMetadata) return 'low';

  const authoritative =
    signals.deprecationMessage !== null || facts.archived || facts.registryGone;
  return authoritative ? 'high' : 'medium';
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Turns raw signals into a verdict. Never throws and never invents a fact:
 * anything the sources did not supply simply produces no evidence, which
 * pushes the result toward `unknown` rather than toward a guess.
 *
 * `now` is injectable so the calibration harness can replay a fixture as of
 * the date it was captured.
 */
export function assess(signals: PackageSignals, now: number = Date.now()): Assessment {
  const facts = deriveFacts(signals, now);
  const collected: Evidence[] = [];

  collectRegistryEvidence(signals, facts, collected);
  collectRepositoryEvidence(signals, facts, collected);
  collectAdvisoryEvidence(signals, facts, now, collected);
  collectReleaseEvidence(signals, facts, collected);
  collectIssueEvidence(signals, facts, collected);
  collectPeopleEvidence(signals, facts, collected);
  collectAdoptionEvidence(signals, facts, collected);

  const hijack = hijackEvidence(signals, facts, collected);
  const stableComplete = !hijack && isStableComplete(signals, facts);
  if (stableComplete) collectStableCompleteEvidence(signals, facts, collected);

  const total = collected.reduce((sum, item) => sum + item.weight, 0);
  const base = scoreFromWeight(total);
  const state = decideState(signals, facts, base, hijack, stableComplete);

  // Lead with whatever argues for the verdict: incriminating evidence first
  // when the verdict is negative, exculpatory evidence first when it is not.
  const incriminating = STATE_SEVERITY[state] >= STATE_SEVERITY['low-activity'];
  const evidenceList = [...collected].sort((a, b) =>
    incriminating ? b.weight - a.weight : a.weight - b.weight,
  );

  return {
    name: signals.name,
    state,
    score: clampToBand(base, state),
    confidence: decideConfidence(signals, facts, state),
    evidence: evidenceList,
    signals,
  };
}
