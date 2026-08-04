/**
 * The scan pipeline.
 *
 *   target → lockfile → candidate packages → signals → verdicts → ScanResult
 *
 * Two rules shape everything here. First, one package must never be able to
 * take the scan down: every per-package step is wrapped, and a failure becomes
 * a warning attached to the result rather than a rejected promise. Second,
 * stdout belongs to the report — progress goes to stderr so `--json` stays
 * pipeable.
 */

import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { STATE_SCORE_BANDS, assess } from './detect/score.js';
import { LOCKFILE_PREFERENCE, detectLockfiles, parseLockfile } from './lockfile/index.js';
import { strongerScope } from './lockfile/manifest.js';
import { HttpClient, emptySignals, gatherSignals } from './sources/index.js';
import { loadSuccessors, lookupSuccessor } from './successors/index.js';
import { DEFAULT_SCAN_OPTIONS, STATE_SEVERITY } from './types.js';
import type {
  Assessment,
  Finding,
  MaintenanceState,
  ParsedDependency,
  ScanOptions,
  ScanResult,
  SuccessorDataset,
  SuccessorRecord,
} from './types.js';

/** Failed packages listed by name before the rest are summarised in one line. */
const FAILURE_DISPLAY_LIMIT = 3;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function isMaintenanceState(value: string): value is MaintenanceState {
  return Object.prototype.hasOwnProperty.call(STATE_SEVERITY, value);
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** `Infinity` means "no limit"; anything unusable falls back to the default. */
function resolveLimit(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return DEFAULT_SCAN_OPTIONS.limit;
  if (value === Number.POSITIVE_INFINITY) return value;
  if (!Number.isFinite(value)) return DEFAULT_SCAN_OPTIONS.limit;
  return Math.max(0, Math.floor(value));
}

/**
 * Merge caller options over the defaults, ignoring `undefined` so that a
 * partially-filled options object from a CLI parser behaves as expected, and
 * repairing values that would otherwise break downstream (a concurrency of 0
 * would deadlock the request gate, an unknown state would sort as `NaN`).
 */
function resolveScanOptions(options?: Partial<ScanOptions>): ScanOptions {
  const given = options ?? {};
  const minState = given.minState;
  const contact = given.contact?.trim();

  return {
    all: given.all ?? DEFAULT_SCAN_OPTIONS.all,
    limit: resolveLimit(given.limit),
    minState:
      typeof minState === 'string' && isMaintenanceState(minState)
        ? minState
        : DEFAULT_SCAN_OPTIONS.minState,
    noCache: given.noCache ?? DEFAULT_SCAN_OPTIONS.noCache,
    cacheTtlHours: clampInt(given.cacheTtlHours, DEFAULT_SCAN_OPTIONS.cacheTtlHours, 0, 24 * 365),
    contact: contact === undefined || contact === '' ? DEFAULT_SCAN_OPTIONS.contact : contact,
    concurrency: clampInt(given.concurrency, DEFAULT_SCAN_OPTIONS.concurrency, 1, 64),
    quiet: given.quiet ?? DEFAULT_SCAN_OPTIONS.quiet,
  };
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/**
 * Turn whatever the user pointed at — a directory, a lockfile, a `package.json`
 * — into the absolute path of one file to parse.
 */
async function resolveTarget(target: string): Promise<string> {
  const absolute = resolve(target === '' ? '.' : target);

  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new Error(
      `Cannot scan ${absolute}: no such file or directory. Pass a project directory or a lockfile path.`,
    );
  }

  // A file the user named explicitly is used as-is; `parseLockfile` sniffs the
  // format and reports precisely if it cannot.
  if (info.isFile()) return absolute;

  if (!info.isDirectory()) {
    throw new Error(`Cannot scan ${absolute}: it is neither a file nor a directory.`);
  }

  const found = await detectLockfiles(absolute);
  const first = found[0];
  if (first === undefined) {
    throw new Error(
      `No lockfile found in ${absolute}. Looked for ${LOCKFILE_PREFERENCE.join(', ')}. ` +
        'Run the scan from a project directory, or pass the lockfile path directly.',
    );
  }
  return first;
}

// ---------------------------------------------------------------------------
// Candidate packages
// ---------------------------------------------------------------------------

/**
 * One entry per package name.
 *
 * Lockfiles pin the same name at several versions (workspaces, peer
 * permutations). A verdict is about the package, not the pin, so those collapse
 * into a single row keeping the strongest claim — and the version is dropped
 * when they disagree rather than picking an arbitrary winner.
 */
function uniquePackages(dependencies: readonly ParsedDependency[]): ParsedDependency[] {
  const byName = new Map<string, ParsedDependency>();

  for (const dependency of dependencies) {
    const name = dependency.name.trim();
    if (name === '') continue;

    const existing = byName.get(name);
    if (existing === undefined) {
      byName.set(name, { ...dependency, name });
      continue;
    }
    existing.direct = existing.direct || dependency.direct;
    existing.scope = strongerScope(existing.scope, dependency.scope);
    if (existing.version !== dependency.version) existing.version = null;
  }

  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function worstFirst(a: Finding, b: Finding): number {
  const severity = STATE_SEVERITY[b.assessment.state] - STATE_SEVERITY[a.assessment.state];
  if (severity !== 0) return severity;
  const score = b.assessment.score - a.assessment.score;
  if (score !== 0) return score;
  return a.assessment.name < b.assessment.name ? -1 : a.assessment.name > b.assessment.name ? 1 : 0;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message === '' ? error.name : error.message;
  return String(error);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/**
 * Progress goes to stderr and nowhere else. On a TTY it is a single repainted
 * line; in a pipe or a CI log it degrades to two plain lines, because a few
 * hundred carriage returns in a build log help nobody.
 */
class Progress {
  private readonly stream = process.stderr;
  private readonly interactive: boolean;
  private completed = 0;
  /** Last painted text, so it can be blanked before the next paint. */
  private painted = '';

  constructor(
    private readonly enabled: boolean,
    private readonly total: number,
  ) {
    this.interactive = enabled && this.stream.isTTY === true;
  }

  note(message: string): void {
    if (!this.enabled) return;
    this.clear();
    this.stream.write(`dead-deps: ${message}\n`);
  }

  tick(name: string): void {
    this.completed += 1;
    if (!this.interactive) return;

    const width = Math.max(20, (this.stream.columns ?? 80) - 1);
    const text = `  [${this.completed}/${this.total}] ${name}`;
    this.paint(text.length > width ? `${text.slice(0, width - 1)}…` : text);
  }

  private paint(text: string): void {
    const pad = Math.max(0, this.painted.length - text.length);
    this.stream.write(`\r${text}${' '.repeat(pad)}`);
    this.painted = text;
  }

  clear(): void {
    if (this.painted === '') return;
    this.stream.write(`\r${' '.repeat(this.painted.length)}\r`);
    this.painted = '';
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Scan a project and return everything the reporters need.
 *
 * Throws only for problems that make a scan impossible: an unreadable target,
 * a directory with no lockfile, a lockfile whose top-level structure cannot be
 * parsed. Everything else — an unreachable source, a package that blows up
 * mid-assessment, a missing succession dataset — lands in `warnings`.
 */
export async function scan(target: string, options?: Partial<ScanOptions>): Promise<ScanResult> {
  const opts = resolveScanOptions(options);
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const warnings: string[] = [];

  const lockfilePath = await resolveTarget(target);
  const lockfile = await parseLockfile(lockfilePath);

  const candidates = opts.all
    ? lockfile.dependencies
    : lockfile.dependencies.filter((dependency) => dependency.direct);

  if (!opts.all && candidates.length === 0 && lockfile.dependencies.length > 0) {
    warnings.push(
      `None of the ${lockfile.dependencies.length} entries in ${basename(lockfilePath)} could be ` +
        'matched to a dependency declared in package.json, so there was nothing direct to examine. ' +
        'Scan with transitive dependencies included to look at the rest.',
    );
  }

  const packages = uniquePackages(candidates);
  const examined = packages.length;
  // Everything in the lockfile that never reached an assessment: transitive
  // entries filtered out, plus duplicate pins folded into one package.
  const skipped = Math.max(0, lockfile.dependencies.length - examined);

  let successors: SuccessorDataset = { records: [], byFrom: new Map() };
  try {
    successors = await loadSuccessors();
  } catch (error) {
    warnings.push(
      `Curated succession dataset could not be loaded (${describeError(error)}); ` +
        'findings will not name replacements.',
    );
  }

  const progress = new Progress(!opts.quiet, examined);
  progress.note(
    `${examined} ${opts.all ? '' : 'direct '}${plural(examined, 'dependency', 'dependencies')} ` +
      `from ${basename(lockfilePath)} (${lockfile.format})`,
  );

  // One HttpClient for the whole scan: its semaphore is the concurrency limit,
  // so every package can be launched at once and the gate does the throttling.
  const http = new HttpClient({
    contact: opts.contact,
    cacheTtlHours: opts.cacheTtlHours,
    noCache: opts.noCache,
    concurrency: opts.concurrency,
  });

  const failures: string[] = [];
  const assessments = await Promise.all(
    packages.map(async (dependency): Promise<Assessment | null> => {
      try {
        return assess(await gatherSignals(http, dependency.name));
      } catch (error) {
        const reason = describeError(error);
        failures.push(`${dependency.name} (${reason})`);
        try {
          // Still produce a verdict, so the package is visibly `unknown`
          // rather than silently absent from the run.
          const signals = emptySignals(dependency.name);
          signals.errors.push(reason);
          return assess(signals);
        } catch {
          return null;
        }
      } finally {
        progress.tick(dependency.name);
      }
    }),
  );

  const threshold = STATE_SEVERITY[opts.minState];

  /**
   * Raises a verdict to match hand-verified knowledge.
   *
   * `assess()` reasons only from upstream signals, and some genuinely dead
   * packages look alive through that lens — `enzyme` and `browserify` still
   * carry recent repository activity and healthy download counts. When a human
   * has already checked a package against primary sources and recorded its
   * succession, that beats any inference, so the curated row sets a floor.
   *
   * This deliberately lives in `scan()` rather than in `assess()`: keeping the
   * scorer free of the dataset is what stops the calibration harness from
   * grading the detector on answers it was handed.
   */
  function applyCuratedFloor(
    assessment: Assessment,
    record: SuccessorRecord | null,
  ): Assessment {
    if (record === null || record.confidence === 'low') return assessment;
    const floor: MaintenanceState = 'unmaintained';
    if (STATE_SEVERITY[assessment.state] >= STATE_SEVERITY[floor]) return assessment;

    const target =
      record.toKind === 'platform'
        ? `the platform (${record.to})`
        : record.to === null
          ? 'no direct successor'
          : record.to;
    return {
      ...assessment,
      state: floor,
      score: Math.max(assessment.score, STATE_SCORE_BANDS[floor][0]),
      evidence: [
        ...assessment.evidence,
        {
          kind: 'curated-dataset',
          label:
            `Hand-verified as no longer maintained, superseded by ${target}. ` +
            `Upstream activity signals alone did not show this.`,
          url: record.evidence[0]?.url,
          weight: 0,
        },
      ],
    };
  }

  const flagged: Finding[] = [];
  packages.forEach((dependency, index) => {
    const raw = assessments[index];
    if (raw === undefined || raw === null) return;
    const successor = lookupSuccessor(successors, dependency.name);
    const assessment = applyCuratedFloor(raw, successor);
    if (STATE_SEVERITY[assessment.state] < threshold) return;
    flagged.push({ dependency, assessment, successor });
  });
  flagged.sort(worstFirst);

  const findings =
    opts.limit === Number.POSITIVE_INFINITY ? flagged : flagged.slice(0, opts.limit);
  const withheld = flagged.length - findings.length;
  if (withheld > 0) {
    warnings.push(
      `${withheld} further ${plural(withheld, 'dependency', 'dependencies')} met the reporting ` +
        `threshold but ${plural(withheld, 'is', 'are')} not shown; raise the limit (currently ` +
        `${opts.limit}) to see ${plural(withheld, 'it', 'them')}.`,
    );
  }

  for (const failure of failures.slice(0, FAILURE_DISPLAY_LIMIT)) {
    warnings.push(`Could not assess ${failure}.`);
  }
  const hiddenFailures = failures.length - FAILURE_DISPLAY_LIMIT;
  if (hiddenFailures > 0) {
    warnings.push(
      `${hiddenFailures} further ${plural(hiddenFailures, 'package', 'packages')} could not be assessed.`,
    );
  }

  if (http.stats.errors > 0) {
    warnings.push(
      `${http.stats.errors} upstream ${plural(http.stats.errors, 'request', 'requests')} failed ` +
        'after retries; verdicts here rest on incomplete data.',
    );
  }

  const durationMs = Date.now() - startedAtMs;

  progress.clear();
  progress.note(
    `examined ${examined} in ${(durationMs / 1000).toFixed(1)}s ` +
      `(${http.stats.requests} ${plural(http.stats.requests, 'request', 'requests')}, ` +
      `${http.stats.cacheHits} cached), ${flagged.length} flagged`,
  );

  return { lockfile, findings, examined, skipped, startedAt, durationMs, warnings };
}
