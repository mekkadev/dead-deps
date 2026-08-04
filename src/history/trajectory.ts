/**
 * What the archive is for.
 *
 * Every index in this space publishes a package's *current* state and nothing
 * else, so the one question a user actually asks — "is this getting worse?" —
 * cannot be answered by any single fetch. Two snapshots can answer it, and this
 * file is the whole of that answer: given the rows `store` has accumulated for
 * one package, say which way it is moving and why.
 *
 * Three rules shape everything here.
 *
 *   - **Say nothing rather than guess.** A young archive holds two samples a
 *     week apart, and almost nothing moves meaningfully in a week. Coming back
 *     `steady` from a real comparison, or `unknown` from too few samples, is the
 *     correct answer to most inputs — not a disappointing one. Every threshold
 *     below is set so that noise reads as silence.
 *   - **A trend is a claim about the package, not about our data.** Upstream
 *     indexes rewrite themselves: a package can appear to shed nine tenths of
 *     its dependents between two Tuesdays because somebody re-ran an importer.
 *     Anything that looks more like an indexing artefact than like reality is
 *     dropped as missing data, because a fabricated collapse is far worse than
 *     an unreported one.
 *   - **Mixed evidence is not a direction.** A package that lost dependents but
 *     shipped a release is `steady`. Only a one-sided reading earns a verdict.
 *
 * Nothing here throws, reads the disk or reaches the network. It is a pure
 * function of the rows it is handed.
 */

import { STATE_SEVERITY } from '../types.js';
import type { HealthSnapshot, Trajectory, TrendDirection } from '../types.js';

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Samples needed before a direction means anything.
 *
 * Below this the answer is `unknown`, never `steady`: "we have not watched this
 * package for long enough" and "this package is not moving" are different
 * statements, and only one of them is true in the first week of an archive.
 */
export const MIN_SAMPLES_FOR_TRAJECTORY: number = 2;

/**
 * Score movement worth calling a movement, in points of 0..100.
 *
 * The scorer squashes its weight sum through a logistic curve whose steepest
 * region yields roughly 1.4 score points per unit of weight, so eight points is
 * about six weight units — the size of the *smallest* single piece of evidence
 * the scorer can add or drop (a stale push, a solo bus factor, an adoption
 * credit). Anything under that is the curve drifting as the clock advances, not
 * a fact changing.
 */
export const SCORE_DELTA_MATERIAL = 8;

/**
 * Score movement that cannot be drift: roughly fourteen weight units, the size
 * of a load-bearing signal appearing or vanishing outright (issues going
 * unanswered, maintainers disappearing, a repository being archived).
 */
export const SCORE_DELTA_SEVERE = 20;

/**
 * Share of dependent packages that must be lost before the loss is reported.
 *
 * Dependent counts wobble by a percent or two on their own as the index adds
 * and drops repositories it manages to resolve. Five percent is an exodus that
 * churn does not explain.
 */
export const DEPENDENT_FLIGHT_MATERIAL = 0.05;

/** A fifth of the ecosystem gone. Packages do not lose that by accident. */
export const DEPENDENT_FLIGHT_SEVERE = 0.2;

/**
 * Dependents required at the start of the window before a share is meaningful.
 *
 * With eight dependents, one of them moving on is "12% of dependent packages
 * left", which is arithmetically true and journalistically false. Twenty is the
 * point where a single downstream package stops being able to swing the number
 * past the material threshold on its own.
 */
export const DEPENDENT_FLIGHT_MIN_BASELINE = 20;

/**
 * How far two adjacent dependent readings may differ before the *step* is
 * treated as missing data rather than as news.
 *
 * Half, in either direction. Dependent counts are cumulative and slow: an
 * established package does not shed half its dependents in a week, and it does
 * not double them either. When that shows up it is an index reset — an importer
 * re-run, a resolver change, a partial sync — and the two readings simply are
 * not comparable. The symmetry matters: a reset produces a cliff *and then* a
 * recovery, and counting only the cliff would turn the rebound into phantom
 * growth. The archive is cut at both, and only the most recent uninterrupted
 * run is measured.
 */
export const IMPLAUSIBLE_STEP_RATIO = 0.5;

/**
 * Change in the share of trailing-year issues closed worth reporting, as a
 * fraction (0.15 = fifteen percentage points).
 *
 * Deliberately large. Consecutive samples measure overlapping trailing years —
 * two rows a month apart share eleven twelfths of their window — so a genuine
 * change in how a maintainer behaves arrives heavily damped. Anything smaller
 * than fifteen points is the tail of the year rolling off.
 */
export const RESPONSIVENESS_MATERIAL = 0.15;

/**
 * Issues in the trailing year before a close rate is usable at all. Matches the
 * sample floor the scorer applies for the same reason: three issues and one
 * closure is not a responsiveness measurement.
 */
export const RESPONSIVENESS_MIN_ISSUES = 5;

// ---------------------------------------------------------------------------
// Prose helpers
// ---------------------------------------------------------------------------

/** Same shape the scorer uses, so trajectory prose reads like verdict prose. */
function span(days: number): string {
  const whole = Math.round(days);
  if (whole < 45) return `${whole} day${whole === 1 ? '' : 's'}`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} month${months === 1 ? '' : 's'}`;
  return `${(days / 365.25).toFixed(1)} years`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function scorePoints(value: number): string {
  const whole = Math.abs(Math.round(value));
  return `${whole} point${whole === 1 ? '' : 's'}`;
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Reading the rows
// ---------------------------------------------------------------------------

/** Folded exactly like the archive folds it: npm treats `Base64` as `base64`. */
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

function observedMs(row: HealthSnapshot): number {
  return Date.parse(row.observedAt);
}

/** One dependent-count reading, with the moment it was taken. */
interface Point {
  readonly at: number;
  readonly value: number;
}

function dependentPoints(rows: readonly HealthSnapshot[]): Point[] {
  const points: Point[] = [];
  for (const row of rows) {
    const value = row.dependentPackagesCount;
    if (value === null || !Number.isFinite(value) || value < 0) continue;
    points.push({ at: observedMs(row), value });
  }
  return points;
}

/**
 * True when two adjacent readings are too far apart to be the same measurement.
 *
 * The small-numbers guard matters: a package going from four dependents to one
 * has "lost three quarters of its ecosystem", but four to one is ordinary noise
 * at that scale rather than an index reset, and cutting the series there would
 * throw away history for no reason. Below the baseline the share is unusable
 * anyway, so such a step is left in place.
 */
function implausibleStep(previous: number, current: number): boolean {
  const low = Math.min(previous, current);
  const high = Math.max(previous, current);
  if (high < DEPENDENT_FLIGHT_MIN_BASELINE) return false;
  return low < high * IMPLAUSIBLE_STEP_RATIO;
}

/**
 * The most recent run of readings with no index reset inside it.
 *
 * Most recent rather than longest: after the index rewrites itself, the new
 * regime is the one the package now lives under, and the pre-reset numbers are
 * measurements of something else.
 */
function trustedRun(points: readonly Point[]): Point[] {
  let start = points.length - 1;
  while (start > 0) {
    const previous = points[start - 1];
    const current = points[start];
    if (previous === undefined || current === undefined) break;
    if (implausibleStep(previous.value, current.value)) break;
    start -= 1;
  }
  return points.slice(Math.max(0, start));
}

/** Share of trailing-year issues closed, or `null` when the sample is too thin. */
function closeRate(row: HealthSnapshot): number | null {
  const issues = row.pastYearIssues;
  if (issues === null || !Number.isFinite(issues) || issues < RESPONSIVENESS_MIN_ISSUES) {
    return null;
  }
  const closed = row.pastYearIssuesClosed ?? 0;
  if (!Number.isFinite(closed) || closed < 0) return null;
  return Math.min(1, closed / issues);
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

/**
 * Running tally of what the window says. `declining` and `improving` are counts
 * of one-sided observations, not weights: a direction is only claimed when
 * every observation points the same way.
 */
interface Tally {
  declining: number;
  improving: number;
  readonly notes: string[];
}

function compareScore(
  first: HealthSnapshot,
  last: HealthSnapshot,
  delta: number,
  windowDays: number,
  tally: Tally,
): void {
  if (delta >= SCORE_DELTA_MATERIAL) {
    tally.declining += 1;
    tally.notes.push(
      `The abandonment score rose ${scorePoints(delta)}, from ${Math.round(first.score)} to ${Math.round(last.score)}, over the last ${span(windowDays)}.`,
    );
  } else if (delta <= -SCORE_DELTA_MATERIAL) {
    tally.improving += 1;
    tally.notes.push(
      `The abandonment score fell ${scorePoints(delta)}, from ${Math.round(first.score)} to ${Math.round(last.score)}, over the last ${span(windowDays)}.`,
    );
  }
}

/**
 * A change of verdict, and whether it counts as one.
 *
 * `unknown` at either end is excluded from the vote: moving in or out of it
 * means our coverage changed, and we cannot tell from here whether the package
 * did. That is still worth a sentence — it explains a jump the reader can see —
 * but it is not evidence about the package's health.
 */
function compareState(first: HealthSnapshot, last: HealthSnapshot, tally: Tally): void {
  if (first.state === last.state) return;

  if (first.state === 'unknown') {
    tally.notes.push(
      `Enough data arrived to move the verdict off unknown; it now reads ${last.state}.`,
    );
    return;
  }
  if (last.state === 'unknown') {
    tally.notes.push(
      `Coverage was lost: the verdict was ${first.state} and is now unknown for want of data.`,
    );
    return;
  }

  if (STATE_SEVERITY[last.state] > STATE_SEVERITY[first.state]) {
    tally.declining += 1;
    tally.notes.push(`The verdict moved from ${first.state} to ${last.state}.`);
  } else {
    tally.improving += 1;
    tally.notes.push(`The verdict recovered from ${first.state} to ${last.state}.`);
  }
}

function compareDependents(flight: number | null, flightDays: number, tally: Tally): void {
  if (flight === null) return;

  if (flight >= DEPENDENT_FLIGHT_MATERIAL) {
    tally.declining += 1;
    tally.notes.push(
      `${percent(flight)} of dependent packages left over the last ${span(flightDays)}.`,
    );
  } else if (flight <= -DEPENDENT_FLIGHT_MATERIAL) {
    tally.improving += 1;
    tally.notes.push(
      `${percent(-flight)} more packages depend on it than ${span(flightDays)} ago.`,
    );
  }
}

function compareResponsiveness(
  delta: number | null,
  fromRate: number | null,
  toRate: number | null,
  tally: Tally,
): void {
  if (delta === null || fromRate === null || toRate === null) return;

  if (delta <= -RESPONSIVENESS_MATERIAL) {
    tally.declining += 1;
    tally.notes.push(
      `The share of issues closed within the trailing year fell from ${percent(fromRate)} to ${percent(toRate)}.`,
    );
  } else if (delta >= RESPONSIVENESS_MATERIAL) {
    tally.improving += 1;
    tally.notes.push(
      `The share of issues closed within the trailing year rose from ${percent(fromRate)} to ${percent(toRate)}.`,
    );
  }
}

function comparePeople(first: HealthSnapshot, last: HealthSnapshot, tally: Tally): void {
  if (first.activeMaintainers > 0 && last.activeMaintainers === 0) {
    tally.declining += 1;
    tally.notes.push(
      `Upstream saw ${first.activeMaintainers} active ${plural(first.activeMaintainers, 'maintainer', 'maintainers')} at the start of this window and none by the end.`,
    );
  } else if (first.activeMaintainers === 0 && last.activeMaintainers > 0) {
    tally.improving += 1;
    tally.notes.push(
      `Somebody came back: upstream now sees ${last.activeMaintainers} active ${plural(last.activeMaintainers, 'maintainer', 'maintainers')} where it saw none.`,
    );
  }
}

function compareAdvisories(first: HealthSnapshot, last: HealthSnapshot, tally: Tally): void {
  const delta = last.openAdvisories - first.openAdvisories;
  if (delta > 0) {
    tally.declining += 1;
    tally.notes.push(
      `${delta} new security ${plural(delta, 'advisory was', 'advisories were')} opened against it during this window.`,
    );
  } else if (delta < 0) {
    tally.improving += 1;
    tally.notes.push(
      `${-delta} ${plural(-delta, 'advisory that was', 'advisories that were')} open at the start of this window ${plural(-delta, 'is', 'are')} no longer counted against it.`,
    );
  }
}

/**
 * A release landing inside the window is the least ambiguous good news there
 * is: it is the one event that reaches the person who installed the package.
 */
function compareReleases(first: HealthSnapshot, last: HealthSnapshot, tally: Tally): void {
  const before = first.latestReleaseAt === null ? Number.NaN : Date.parse(first.latestReleaseAt);
  const after = last.latestReleaseAt === null ? Number.NaN : Date.parse(last.latestReleaseAt);
  if (!Number.isFinite(before) || !Number.isFinite(after) || after <= before) return;

  tally.improving += 1;
  tally.notes.push(
    `A new version shipped during this window, ${span((after - before) / MS_PER_DAY)} after the release before it.`,
  );
}

/**
 * The verdict-shaped routes to `collapsing`, the loudest thing this module can
 * say. Both require an event rather than an accumulation: a formal deprecation
 * or worse arriving, or a whole load-bearing signal flipping while the verdict
 * crossed into `unmaintained` or beyond.
 *
 * The end state has to be a serious one. A package sliding from `active` to
 * `low-activity` has moved, and twenty points is a real move, but "collapsing"
 * is not the word for a package that is merely quieter than it was.
 *
 * Callers must have established that both states are comparable; movement in or
 * out of `unknown` is our coverage changing, not the package.
 */
function verdictCollapsed(
  first: HealthSnapshot,
  last: HealthSnapshot,
  scoreDelta: number,
): boolean {
  if (STATE_SEVERITY[last.state] <= STATE_SEVERITY[first.state]) return false;
  if (STATE_SEVERITY[last.state] >= STATE_SEVERITY.deprecated) return true;
  return (
    STATE_SEVERITY[last.state] >= STATE_SEVERITY.unmaintained && scoreDelta >= SCORE_DELTA_SEVERE
  );
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Compare every snapshot recorded for one package and say which way it is
 * moving.
 *
 * Expects the rows for a *single* package, in any order — `readSnapshotsFor()`
 * hands back exactly that. `null` comes back in two cases: nothing usable was
 * passed, or the rows name more than one package. The second is a caller
 * mistake rather than a fact about a package, and picking one of the names by
 * sort order would publish a trend for a package nobody asked about.
 *
 * A single sample is *not* null: it is a real `Trajectory` with `direction:
 * 'unknown'`, which is what lets a report say "sampled once, ask again next
 * week" instead of pretending the package has no history at all.
 */
export function computeTrajectory(snapshots: readonly HealthSnapshot[]): Trajectory | null {
  const rows = snapshots
    .filter(
      (row) =>
        typeof row.name === 'string' &&
        row.name.trim() !== '' &&
        Number.isFinite(observedMs(row)) &&
        Number.isFinite(row.score),
    )
    .sort((a, b) => observedMs(a) - observedMs(b));

  const first = rows[0];
  const last = rows[rows.length - 1];
  if (first === undefined || last === undefined) return null;

  const key = nameKey(last.name);
  if (rows.some((row) => nameKey(row.name) !== key)) return null;

  const windowDays = (observedMs(last) - observedMs(first)) / MS_PER_DAY;

  const base: Trajectory = {
    name: last.name,
    from: first.observedAt,
    to: last.observedAt,
    samples: rows.length,
    direction: 'unknown',
    scoreDelta: 0,
    dependentFlight: null,
    responsivenessDelta: null,
    notes: [],
  };

  if (rows.length < MIN_SAMPLES_FOR_TRAJECTORY) {
    return {
      ...base,
      notes: [
        `Only ${rows.length === 1 ? 'one sample has' : `${rows.length} samples have`} been recorded for this package, so there is nothing to compare against yet; a direction needs at least ${MIN_SAMPLES_FOR_TRAJECTORY}.`,
      ],
    };
  }

  if (windowDays <= 0) {
    return {
      ...base,
      notes: [
        'Every sample carries the same timestamp, so no time has passed to measure a trend across.',
      ],
    };
  }

  // Dependent flight, measured over the most recent uninterrupted run rather
  // than over the whole window: an index reset inside the window makes the
  // readings on either side of it incomparable.
  const run = trustedRun(dependentPoints(rows));
  const runFirst = run[0];
  const runLast = run[run.length - 1];
  let dependentFlight: number | null = null;
  let flightDays = 0;
  if (
    runFirst !== undefined &&
    runLast !== undefined &&
    run.length >= MIN_SAMPLES_FOR_TRAJECTORY &&
    runLast.at > runFirst.at &&
    runFirst.value >= DEPENDENT_FLIGHT_MIN_BASELINE
  ) {
    dependentFlight = round((runFirst.value - runLast.value) / runFirst.value, 4);
    flightDays = (runLast.at - runFirst.at) / MS_PER_DAY;
  }

  // Responsiveness needs two *different* samples that both carry enough issues
  // to measure. One usable row and one blank one is not a change of zero.
  const rates = rows.map(closeRate);
  const firstRated = rates.findIndex((rate) => rate !== null);
  const lastRated = rates.length - 1 - [...rates].reverse().findIndex((rate) => rate !== null);
  const twoRated = firstRated !== -1 && lastRated > firstRated;
  const fromRate = twoRated ? (rates[firstRated] ?? null) : null;
  const toRate = twoRated ? (rates[lastRated] ?? null) : null;
  const responsivenessDelta =
    fromRate === null || toRate === null ? null : round(toRate - fromRate, 4);

  const scoreDelta = round(last.score - first.score, 2);

  const tally: Tally = { declining: 0, improving: 0, notes: [] };
  compareState(first, last, tally);
  compareScore(first, last, scoreDelta, windowDays, tally);
  compareDependents(dependentFlight, flightDays, tally);
  compareResponsiveness(responsivenessDelta, fromRate, toRate, tally);
  comparePeople(first, last, tally);
  compareAdvisories(first, last, tally);
  compareReleases(first, last, tally);

  /**
   * A window with `unknown` at either end is not a comparison.
   *
   * `unknown` is the scorer admitting it knew almost nothing about the package
   * at that moment — a source that failed, a registry entry with no repository,
   * no release date and no issue tracker. Whatever moved between such a sample
   * and a real one is at least as likely to be our coverage arriving or
   * departing as the package changing, and there is no way to tell which from
   * here. The observations still get their sentences; the direction does not
   * get invented.
   *
   * The one exception is a severe dependent exodus, which rests on a count the
   * package index returned at both ends and needs no verdict to interpret. It
   * is also the earliest warning that exists, so it is not worth losing to a
   * gap in unrelated fields.
   */
  const comparableStates = first.state !== 'unknown' && last.state !== 'unknown';
  const severeFlight = dependentFlight !== null && dependentFlight >= DEPENDENT_FLIGHT_SEVERE;

  let direction: TrendDirection;
  if (severeFlight) direction = 'collapsing';
  else if (!comparableStates) direction = 'unknown';
  else if (verdictCollapsed(first, last, scoreDelta)) direction = 'collapsing';
  else if (tally.declining > 0 && tally.improving === 0) direction = 'declining';
  else if (tally.improving > 0 && tally.declining === 0) direction = 'improving';
  else direction = 'steady';

  if (direction === 'unknown' && first.state === 'unknown' && last.state === 'unknown') {
    tally.notes.push(
      'Every sample in this window read unknown: there has never been enough data to judge this package, let alone to compare it against itself.',
    );
  }

  const notes =
    tally.notes.length > 0
      ? tally.notes
      : [
          `Nothing moved materially across ${rows.length} samples spanning ${span(windowDays)}.`,
        ];

  return {
    ...base,
    direction,
    scoreDelta,
    dependentFlight,
    responsivenessDelta,
    notes,
  };
}

/**
 * One line for a terminal, e.g.
 *
 *   `enzyme: collapsing over 7 months — score +23, 31% of dependents gone (5 samples)`
 *
 * Plain text: colour belongs to the reporter, which owns the `NO_COLOR` and
 * TTY decisions. Only measurements that cleared their own threshold appear, so
 * a quiet package produces a short, honest line rather than a row of zeroes.
 */
export function summarise(trajectory: Trajectory): string {
  const samples = `${trajectory.samples} ${plural(trajectory.samples, 'sample', 'samples')}`;
  const windowDays = (Date.parse(trajectory.to) - Date.parse(trajectory.from)) / MS_PER_DAY;
  const over = Number.isFinite(windowDays) && windowDays > 0 ? ` over ${span(windowDays)}` : '';

  if (trajectory.direction === 'unknown') {
    // Two different silences: not watched for long enough, versus watched and
    // still not knowable. Saying "no trend yet" for the second would promise a
    // trend next week that more samples of the same nothing will not produce.
    return trajectory.samples < MIN_SAMPLES_FOR_TRAJECTORY
      ? `${trajectory.name}: no trend yet — ${samples}, ${MIN_SAMPLES_FOR_TRAJECTORY} needed`
      : `${trajectory.name}: not comparable${over} — too little was known to say (${samples})`;
  }

  const parts: string[] = [];
  if (Math.abs(trajectory.scoreDelta) >= SCORE_DELTA_MATERIAL) {
    parts.push(`score ${signed(Math.round(trajectory.scoreDelta))}`);
  }

  const flight = trajectory.dependentFlight;
  if (flight !== null && Math.abs(flight) >= DEPENDENT_FLIGHT_MATERIAL) {
    parts.push(
      flight > 0 ? `${percent(flight)} of dependents gone` : `${percent(-flight)} more dependents`,
    );
  }

  const responsiveness = trajectory.responsivenessDelta;
  if (responsiveness !== null && Math.abs(responsiveness) >= RESPONSIVENESS_MATERIAL) {
    parts.push(`issues closed ${signed(Math.round(responsiveness * 100))}pt`);
  }

  const detail = parts.length === 0 ? '' : ` — ${parts.join(', ')}`;
  return `${trajectory.name}: ${trajectory.direction}${over}${detail} (${samples})`;
}
