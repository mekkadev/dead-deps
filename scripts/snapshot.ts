/**
 * The weekly sampler.
 *
 * Every index in this space publishes a package's *current* state and nothing
 * else — ecosyste.ms included, which returns no historical fields at all. So
 * "is this getting worse?" cannot be answered from outside; it can only be
 * answered by somebody who wrote the answer down every week. History cannot be
 * bought or backfilled. A week not sampled is gone for good.
 *
 * That is the whole job of this script: take one honest reading of the
 * packages that matter, project it onto `HealthSnapshot` — the narrow set of
 * fields whose *movement* means something — and hand it to the archive.
 *
 * Two rules follow from "a week not sampled is gone":
 *
 *   - One package must never take the run down. `gatherSignals` is already
 *     total, but anything that does throw is counted, named and skipped. Four
 *     hundred and seventy rows is a good week; zero rows because `left-pad`
 *     404'd is a lost one.
 *   - The exit code distinguishes "some packages failed" (fine, exit 0) from
 *     "nothing was written" (the only real failure). CI leans on that.
 *
 * stdout carries a single JSON summary object, so the workflow can name the
 * ISO week and the row count in its commit message without re-deriving them.
 * Everything meant for a human — progress, failures, the closing summary —
 * goes to stderr.
 *
 * Usage:
 *   node --import tsx scripts/snapshot.ts [--top <n>] [--contact <email>]
 *                                         [--concurrency <n>] [--no-cache]
 *                                         [--cache-ttl <hours>]
 */

import { readFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assess } from '../src/detect/score.js';
import { appendSnapshots, isoWeekKey } from '../src/history/index.js';
import { gatherSignals, HttpClient } from '../src/sources/index.js';
import { loadSuccessors } from '../src/successors/index.js';
import { EXIT } from '../src/types.js';
import type { HealthSnapshot } from '../src/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** How many of the most-depended-on packages to sample when nobody says. */
const DEFAULT_TOP = 500;
/** Hard ceiling, so a typo cannot ask upstream for a hundred thousand rows. */
const MAX_TOP = 5_000;
const DEFAULT_CONCURRENCY = 8;
/** A weekly run wants a day-old answer no more than it wants a stale one. */
const DEFAULT_CACHE_TTL_HOURS = 24;

/** The largest page ecosyste.ms will serve. */
const PAGE_SIZE = 100;

const POPULAR_PACKAGES_URL =
  'https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages';

/** Failed packages named individually before the rest are summarised. */
const FAILURE_DISPLAY_LIMIT = 20;
/** One progress line per this many packages, so a CI log stays readable. */
const PROGRESS_EVERY = 25;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message === '' ? error.name : error.message;
  return String(error);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function note(message: string): void {
  process.stderr.write(`snapshot: ${message}\n`);
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * Rows the week's file holds after the write.
 *
 * Not the same as the number sampled: `appendSnapshots` upserts by package, so
 * a re-run inside the same week replaces its own rows and leaves everybody
 * else's alone. The commit message wants the archive's count, not this run's.
 */
async function countRows(path: string): Promise<number> {
  try {
    const text = await readFile(path, 'utf8');
    return text.split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    return 0;
  }
}

function displayPath(path: string): string {
  const rel = relative(ROOT, path);
  return rel === '' || rel.startsWith('..') ? path : rel;
}

/**
 * Runs `fn` over `items` with a fixed number of workers.
 *
 * The HTTP client has its own gate, but that gate throttles *requests*; this
 * one throttles *packages*, which is what keeps memory flat when the list is
 * five thousand names long.
 */
async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        const item = items[index];
        if (item === undefined) return;
        results[index] = await fn(item, index);
      }
    }),
  );

  return results;
}

// ---------------------------------------------------------------------------
// The package list
// ---------------------------------------------------------------------------

interface PopularPage {
  readonly name?: unknown;
}

function popularPageUrl(page: number): string {
  const url = new URL(POPULAR_PACKAGES_URL);
  url.searchParams.set('sort', 'dependent_packages_count');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('per_page', String(PAGE_SIZE));
  url.searchParams.set('page', String(page));
  return url.toString();
}

/**
 * The most-depended-on npm packages, in descending order of dependents.
 *
 * Paged rather than parallel on purpose: the pages are cheap, the ordering is
 * only stable if upstream is not being hammered, and a page that comes back
 * empty means the end of the list rather than an error.
 */
async function fetchPopular(
  http: HttpClient,
  top: number,
  problems: string[],
): Promise<string[]> {
  const names: string[] = [];
  if (top <= 0) return names;

  const pages = Math.ceil(top / PAGE_SIZE);
  for (let page = 1; page <= pages; page += 1) {
    const url = popularPageUrl(page);
    const body = await http.getJson<readonly PopularPage[]>(url);

    if (body === null) {
      problems.push(`ecosyste.ms page ${page} of the popularity list did not answer.`);
      continue;
    }
    if (!Array.isArray(body)) {
      problems.push(`ecosyste.ms page ${page} was not a list of packages.`);
      continue;
    }
    if (body.length === 0) break;

    for (const entry of body) {
      const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
      if (name !== '') names.push(name);
    }
  }

  return names.slice(0, top);
}

/**
 * Every `from` in the curated dataset.
 *
 * These are the packages the tool makes claims about by name, so their history
 * matters more than anyone else's: a succession recorded in 2024 is a
 * falsifiable statement about a trajectory, and this archive is the only thing
 * that can ever check it. They are sampled whatever `--top` says.
 */
async function successorSubjects(problems: string[]): Promise<string[]> {
  try {
    const dataset = await loadSuccessors();
    return dataset.records
      .map((record) => record.from.trim())
      .filter((name) => name !== '');
  } catch (error) {
    problems.push(
      `Curated succession dataset could not be read (${describeError(error)}); ` +
        'this run samples popularity only.',
    );
    return [];
  }
}

/**
 * Popular packages plus curated subjects, deduplicated case-sensitively (npm
 * names are lowercase, but a scope typo should not silently merge two rows)
 * and sorted, so the week's file diffs against last week's line by line.
 */
function buildPackageList(popular: readonly string[], curated: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const name of [...popular, ...curated]) seen.add(name);
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Signals and a verdict, narrowed to the fields whose change over time means
 * something. Everything else — prose, evidence labels, repository URLs — is
 * either constant or re-derivable, and storing it weekly would multiply the
 * archive for nothing.
 */
function toSnapshot(
  name: string,
  observedAt: string,
  http: HttpClient,
): Promise<HealthSnapshot> {
  return gatherSignals(http, name).then((signals) => {
    const assessment = assess(signals);
    return {
      name: assessment.name,
      observedAt,
      state: assessment.state,
      score: assessment.score,
      latestReleaseAt: signals.latestReleaseAt,
      dependentPackagesCount: signals.dependentPackagesCount,
      dependentReposCount: signals.dependentReposCount,
      downloadsLastMonth: signals.downloadsLastMonth,
      pastYearIssues: signals.pastYearIssues,
      pastYearIssuesClosed: signals.pastYearIssuesClosed,
      activeMaintainers: signals.activeMaintainers.length,
      openAdvisories: signals.openAdvisories.length,
      developmentDistributionScore: signals.developmentDistributionScore,
    };
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Options {
  top: number;
  contact: string | null;
  concurrency: number;
  noCache: boolean;
  cacheTtlHours: number;
}

const USAGE = `dead-deps weekly health sampler

  node --import tsx scripts/snapshot.ts [options]

  --top <n>              How many of the most-depended-on npm packages to sample.
                         Default ${DEFAULT_TOP}, ceiling ${MAX_TOP}. Every package named in
                         data/successors.yaml is sampled on top of these.
  --contact <email>      Contact address sent upstream, for ecosyste.ms' polite
                         pool. Defaults to $DEAD_DEPS_CONTACT.
  --concurrency <n>      Packages in flight at once. Default ${DEFAULT_CONCURRENCY}.
  --no-cache             Bypass the on-disk HTTP cache and refetch everything.
  --cache-ttl <hours>    Cache time-to-live. Default ${DEFAULT_CACHE_TTL_HOURS}.
  -h, --help             Show this message.

  Writes one row per package to the NDJSON archive under data/history/, and a
  JSON summary of the run to stdout.
`;

function parseNumber(raw: string | undefined, flag: string): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value)) {
    throw new Error(`${flag} needs a number, got ${raw === undefined ? 'nothing' : `"${raw}"`}.`);
  }
  return value;
}

function parseArgs(argv: readonly string[]): Options | 'help' {
  const options: Options = {
    top: DEFAULT_TOP,
    contact: process.env['DEAD_DEPS_CONTACT']?.trim() || null,
    concurrency: DEFAULT_CONCURRENCY,
    noCache: false,
    cacheTtlHours: DEFAULT_CACHE_TTL_HOURS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        return 'help';
      case '--no-cache':
        options.noCache = true;
        break;
      case '--top': {
        i += 1;
        const value = Math.floor(parseNumber(argv[i], '--top'));
        if (value < 0) throw new Error('--top must not be negative.');
        if (value > MAX_TOP) throw new Error(`--top must not exceed ${MAX_TOP}.`);
        options.top = value;
        break;
      }
      case '--concurrency': {
        i += 1;
        const value = Math.floor(parseNumber(argv[i], '--concurrency'));
        if (value < 1 || value > 32) throw new Error('--concurrency must be between 1 and 32.');
        options.concurrency = value;
        break;
      }
      case '--cache-ttl': {
        i += 1;
        const value = parseNumber(argv[i], '--cache-ttl');
        if (value < 0) throw new Error('--cache-ttl must not be negative.');
        options.cacheTtlHours = value;
        break;
      }
      case '--contact': {
        i += 1;
        const value = argv[i];
        if (value === undefined) throw new Error('--contact needs an address.');
        options.contact = value.trim() === '' ? null : value.trim();
        break;
      }
      default:
        throw new Error(`Unknown argument "${arg ?? ''}".`);
    }
  }

  return options;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  let options: Options | 'help';
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n\n${USAGE}`);
    return EXIT.USAGE_ERROR;
  }
  if (options === 'help') {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }

  const startedAtMs = Date.now();
  const observedDate = new Date(startedAtMs);
  const observedAt = observedDate.toISOString();
  const problems: string[] = [];

  const http = new HttpClient({
    contact: options.contact,
    cacheTtlHours: options.cacheTtlHours,
    noCache: options.noCache,
    concurrency: options.concurrency,
  });

  const [popular, curated] = await Promise.all([
    fetchPopular(http, options.top, problems),
    successorSubjects(problems),
  ]);
  const packages = buildPackageList(popular, curated);

  if (packages.length === 0) {
    for (const problem of problems) note(problem);
    process.stderr.write(
      'Nothing to sample: the popularity list did not answer and the curated dataset ' +
        'named no packages. Refusing to write an empty reading — an absent week is ' +
        'honest, a week of nothing is a lie.\n',
    );
    return EXIT.RUNTIME_ERROR;
  }

  note(
    `${packages.length} ${plural(packages.length, 'package', 'packages')} ` +
      `(${popular.length} by popularity, ${curated.length} curated, ` +
      `${popular.length + curated.length - packages.length} overlapping), ` +
      `concurrency ${options.concurrency}, cache ` +
      `${options.noCache ? 'off' : `on (${options.cacheTtlHours}h)`}` +
      `${options.contact === null ? ', no contact address' : ''}`,
  );
  for (const problem of problems) note(problem);

  const failures: string[] = [];
  let done = 0;

  const rows = await mapPool(
    packages,
    options.concurrency,
    async (name): Promise<HealthSnapshot | null> => {
      try {
        return await toSnapshot(name, observedAt, http);
      } catch (error) {
        // `gatherSignals` is total, so reaching here means something structural
        // broke for this one package. Lose the row, keep the week.
        failures.push(`${name} (${describeError(error)})`);
        return null;
      } finally {
        done += 1;
        if (done % PROGRESS_EVERY === 0 || done === packages.length) {
          process.stderr.write(`  [${done}/${packages.length}] sampled\n`);
        }
      }
    },
  );

  const snapshots = rows.filter((row): row is HealthSnapshot => row !== null);

  for (const failure of failures.slice(0, FAILURE_DISPLAY_LIMIT)) {
    note(`could not sample ${failure}`);
  }
  const hiddenFailures = failures.length - FAILURE_DISPLAY_LIMIT;
  if (hiddenFailures > 0) {
    note(`${hiddenFailures} further ${plural(hiddenFailures, 'package', 'packages')} failed.`);
  }

  if (snapshots.length === 0) {
    process.stderr.write(
      `All ${packages.length} packages failed, so there is nothing to record. ` +
        'Not writing a file: an empty week would be indistinguishable from a week ' +
        'in which every package genuinely went dark.\n',
    );
    return EXIT.RUNTIME_ERROR;
  }

  // The archive decides which file a reading belongs in, from the same
  // timestamp every row carries.
  const file = await appendSnapshots(snapshots, observedDate);
  const [bytes, rowsInFile] = await Promise.all([fileSize(file), countRows(file)]);
  const week = isoWeekKey(observedDate);
  const durationMs = Date.now() - startedAtMs;

  if (rowsInFile === 0) {
    process.stderr.write(
      `Nothing reached ${displayPath(file)}: ${snapshots.length} rows were assembled but the ` +
        'archive holds none of them. Treating that as a failed run rather than a quiet one.\n',
    );
    return EXIT.RUNTIME_ERROR;
  }

  note(
    `sampled ${snapshots.length} of ${packages.length}, ` +
      `${failures.length} ${plural(failures.length, 'failure', 'failures')}, ` +
      `in ${(durationMs / 1000).toFixed(1)}s ` +
      `(${http.stats.requests} ${plural(http.stats.requests, 'request', 'requests')}, ` +
      `${http.stats.cacheHits} cached, ${http.stats.errors} failed)`,
  );
  note(
    `${displayPath(file)} now holds ${rowsInFile} ${plural(rowsInFile, 'row', 'rows')} ` +
      `for week ${week} (${bytes} bytes)`,
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        week,
        observedAt,
        file: displayPath(file),
        rows: rowsInFile,
        bytes,
        sampled: snapshots.length,
        requested: packages.length,
        failures: failures.length,
        failed: failures,
        durationMs,
        http: { ...http.stats },
        problems,
      },
      null,
      2,
    )}\n`,
  );

  return EXIT.OK;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`Snapshot failed: ${describeError(error)}\n`);
    process.exitCode = EXIT.RUNTIME_ERROR;
  },
);
