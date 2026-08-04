/**
 * The snapshot archive.
 *
 * Every index in this space publishes a package's *current* state and nothing
 * else — ecosyste.ms returns no historical fields at all — so "is this getting
 * worse?" cannot be answered from outside. History cannot be bought or
 * backfilled, only accumulated: a week that was never sampled is gone for good.
 * That is the whole reason this file exists, and it is why it is written to be
 * as boring and as hard to lose data with as possible.
 *
 * The format is newline-delimited JSON, one `HealthSnapshot` per line, one file
 * per ISO week (`data/history/2026-W31.ndjson`):
 *
 *   - **One file per week** keeps a year of samples at ~52 small files. A
 *     normal week only ever creates a new file, so the git diff is one-sided —
 *     nothing already committed moves.
 *   - **NDJSON rather than one JSON document** means a torn write costs the
 *     last line rather than the file, and a reader can skip the damaged line
 *     and keep the other eleven months.
 *   - **Rows sorted by package name** within a file, with a canonical field
 *     order and no whitespace, so re-writing a week produces the minimal diff
 *     and two runs over the same data produce byte-identical output.
 *
 * Nothing here throws on a read. A damaged archive line is not worth losing a
 * year of history over: bad lines are skipped, unreadable files are skipped, a
 * missing directory reads as "no history yet".
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STATE_SEVERITY } from '../types.js';
import type { HealthSnapshot, MaintenanceState } from '../types.js';

/** Extension of an archive file. Anything else in the directory is ignored. */
const SNAPSHOT_EXTENSION = '.ndjson';

const HISTORY_RELATIVE_PATH = join('data', 'history');

/**
 * Escape hatch for installs where the package directory is not writable — a
 * global `npm i -g`, a read-only container layer, a CI cache mount. Also the
 * hook a project uses to keep its own archive beside its own lockfile.
 */
const HISTORY_DIR_ENV = 'DEAD_DEPS_HISTORY_DIR';

/**
 * Locate `data/history` relative to this module.
 *
 * Same walk as `src/successors/index.ts` uses for its dataset, and for the same
 * reason: this source compiles to `dist/history/store.js`, so a hard-coded
 * `../../data` only works by accident of `rootDir`. Walk up from wherever the
 * module ended up, take the first `data/history` that exists, and stop at the
 * nearest `package.json` — past that point we would be looking at *another*
 * package's `data/` (in a published install, the user's own project), and
 * quietly writing our archive into it would be much worse than not finding it.
 *
 * When the directory does not exist yet — which is the normal case, since the
 * first run is what creates it — the path where it *should* live is returned so
 * `appendSnapshots` can create it and error messages can name it.
 */
function resolveHistoryDir(): string {
  const override = process.env[HISTORY_DIR_ENV]?.trim();
  if (override !== undefined && override !== '') return resolve(override);

  const here = dirname(fileURLToPath(import.meta.url));

  let dir = here;
  for (;;) {
    const candidate = join(dir, HISTORY_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;
    // Nearest package root: the archive belongs here even if it is missing.
    if (existsSync(join(dir, 'package.json'))) return candidate;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // No package.json anywhere above us (unbundled script, odd layout). Fall back
  // to the layout this repository actually ships.
  return resolve(here, '..', '..', HISTORY_RELATIVE_PATH);
}

export const HISTORY_DIR: string = resolveHistoryDir();

// ---------------------------------------------------------------------------
// Weeks
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

/**
 * ISO-8601 week key, `YYYY-Www`, computed in UTC.
 *
 * The year is the ISO week-numbering year, not the calendar year: 2027-01-01 is
 * a Friday and therefore belongs to `2026-W53`. Getting that wrong would split
 * one week across two files at every new year, which is exactly the kind of
 * seam a diff-friendly archive must not have. UTC throughout, because snapshots
 * are stamped in UTC and a machine's local zone must not decide which file a
 * sample lands in.
 */
export function isoWeekKey(date: Date): string {
  const time = date.getTime();
  if (!Number.isFinite(time)) {
    throw new RangeError('Cannot derive an ISO week from an invalid Date.');
  }

  // Midnight UTC on the observed day, then step to that week's Thursday: the
  // Thursday is what defines both the week number and the week-numbering year.
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
  day.setUTCDate(day.getUTCDate() + 4 - weekday);

  const year = day.getUTCFullYear();
  const week = Math.floor((day.getTime() - Date.UTC(year, 0, 1)) / MS_PER_WEEK) + 1;
  return `${String(year).padStart(4, '0')}-W${String(week).padStart(2, '0')}`;
}

/**
 * Absolute path of the file a sample taken at `observedAt` belongs in:
 * `<HISTORY_DIR>/YYYY-Www.ndjson`.
 *
 * Throws on an invalid `Date`. That is the one place this module is strict:
 * silently filing a sample under `NaN-WNaN` would create an archive file that
 * no later run could ever find again.
 */
export function snapshotPath(observedAt: Date): string {
  return join(HISTORY_DIR, `${isoWeekKey(observedAt)}${SNAPSHOT_EXTENSION}`);
}

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

/**
 * Canonical field order, matching the declaration order of `HealthSnapshot`.
 * Serialising through this rather than through the caller's object is what
 * makes the output byte-stable: two runs holding the same facts write the same
 * bytes, so git sees a change only when a fact changed.
 */
function serialize(row: HealthSnapshot): string {
  return JSON.stringify({
    name: row.name,
    observedAt: row.observedAt,
    state: row.state,
    score: row.score,
    latestReleaseAt: row.latestReleaseAt,
    dependentPackagesCount: row.dependentPackagesCount,
    dependentReposCount: row.dependentReposCount,
    downloadsLastMonth: row.downloadsLastMonth,
    pastYearIssues: row.pastYearIssues,
    pastYearIssuesClosed: row.pastYearIssuesClosed,
    activeMaintainers: row.activeMaintainers,
    openAdvisories: row.openAdvisories,
    developmentDistributionScore: row.developmentDistributionScore,
  });
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMaintenanceState(value: unknown): value is MaintenanceState {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(STATE_SEVERITY, value);
}

/** A number we are willing to store, or `null`. Anything else reads as absent. */
function optionalNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

/** A count. `null` when it is missing or unusable — never silently zero. */
function requiredCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Turn an arbitrary parsed value into a snapshot, or `null` if it is not one.
 *
 * Load-bearing fields — name, timestamp, state, score, and the two counts — must
 * be present and sane or the row is rejected. Defaulting a missing
 * `activeMaintainers` to zero would invent a maintainer exodus out of a
 * truncated line, and a fabricated trend is worse than a missing one. Optional
 * fields degrade to `null`, which every reader already has to handle.
 *
 * Unknown extra fields are dropped rather than rejected, so an archive written
 * by a later version stays readable by an earlier one.
 */
function normalize(value: unknown): HealthSnapshot | null {
  if (!isMapping(value)) return null;

  const name = optionalString(value['name']);
  if (name === null) return null;

  const observedAt = optionalString(value['observedAt']);
  if (observedAt === null || !Number.isFinite(Date.parse(observedAt))) return null;

  const state = value['state'];
  if (!isMaintenanceState(state)) return null;

  const score = optionalNumber(value['score']);
  if (score === null) return null;

  const activeMaintainers = requiredCount(value['activeMaintainers']);
  if (activeMaintainers === null) return null;

  const openAdvisories = requiredCount(value['openAdvisories']);
  if (openAdvisories === null) return null;

  return {
    name,
    observedAt,
    state,
    score,
    latestReleaseAt: optionalString(value['latestReleaseAt']),
    dependentPackagesCount: optionalNumber(value['dependentPackagesCount']),
    dependentReposCount: optionalNumber(value['dependentReposCount']),
    downloadsLastMonth: optionalNumber(value['downloadsLastMonth']),
    pastYearIssues: optionalNumber(value['pastYearIssues']),
    pastYearIssuesClosed: optionalNumber(value['pastYearIssuesClosed']),
    activeMaintainers,
    openAdvisories,
    developmentDistributionScore: optionalNumber(value['developmentDistributionScore']),
  };
}

/**
 * Identity of a package within the archive.
 *
 * Case-folded: npm treats `Base64` and `base64` as one package, and two rows
 * for the same package in one week — differing only in how a caller spelled it
 * — would show up as a phantom pair of trajectories. The stored `name` keeps
 * whatever casing the caller used; only the key is folded.
 */
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

function compareRows(a: HealthSnapshot, b: HealthSnapshot): number {
  const left = nameKey(a.name);
  const right = nameKey(b.name);
  if (left !== right) return left < right ? -1 : 1;
  if (a.observedAt !== b.observedAt) return a.observedAt < b.observedAt ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Parse one file's worth of NDJSON, skipping whatever cannot be understood.
 *
 * Blank lines, a leading BOM and CRLF endings are all tolerated — the archive
 * is a text file in a git repository and will be opened by editors. A line that
 * is not valid JSON, or is valid JSON that is not a snapshot, is dropped and
 * the rest of the file is still returned. That is the point: a partial write or
 * a bad merge conflict resolution costs one week's row for one package, not the
 * archive.
 */
function parseNdjson(text: string): HealthSnapshot[] {
  const rows: HealthSnapshot[] = [];

  for (const rawLine of text.replace(/^\uFEFF/, '').split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const row = normalize(parsed);
    if (row !== null) rows.push(row);
  }

  return rows;
}

/** One archive file. Missing or unreadable reads as empty; never throws. */
async function readSnapshotFile(file: string): Promise<HealthSnapshot[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  return parseNdjson(text);
}

/** Week files in a directory, oldest key first. `YYYY-Www` sorts chronologically. */
async function listSnapshotFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // A directory that does not exist yet is simply an empty archive, and a
    // directory we cannot read is not worth taking a scan down over either.
    return [];
  }

  return entries
    .filter((entry) => !entry.isDirectory() && entry.name.endsWith(SNAPSHOT_EXTENSION))
    .map((entry) => join(dir, entry.name))
    .sort();
}

/**
 * Every snapshot in the archive, sorted by package and then chronologically —
 * the order a trajectory wants to read them in.
 *
 * Reads all week files; there are 52 of them in a year and each is a few tens
 * of kilobytes, so this stays a handful of milliseconds. Never throws.
 */
export async function readAllSnapshots(dir?: string): Promise<HealthSnapshot[]> {
  const root = dir === undefined ? HISTORY_DIR : resolve(dir);
  const files = await listSnapshotFiles(root);
  const perFile = await Promise.all(files.map((file) => readSnapshotFile(file)));
  return perFile.flat().sort(compareRows);
}

/**
 * Every snapshot recorded for one package, oldest first.
 *
 * Matched case-insensitively for the same reason rows are keyed that way. An
 * unknown package is an empty array, not an error: "we have never sampled this"
 * is a normal answer, especially in the first weeks of an archive.
 */
export async function readSnapshotsFor(name: string, dir?: string): Promise<HealthSnapshot[]> {
  const key = nameKey(name);
  if (key === '') return [];
  const all = await readAllSnapshots(dir);
  return all.filter((row) => nameKey(row.name) === key);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Serialised writes per file.
 *
 * Appending is read-modify-write, so two overlapping calls for the same week
 * would race and one would lose its rows. Scans are concurrent by design, so
 * this is not hypothetical. A promise chain per path costs nothing and makes
 * the sequence deterministic within a process. Across processes the atomic
 * rename below is the guarantee: a reader sees the old file or the new one,
 * never a half-written one.
 */
const writeQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(file: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(file) ?? Promise.resolve();
  const next = previous.then(task, task);
  // Keep the chain alive on failure without leaving an unhandled rejection.
  writeQueues.set(
    file,
    next.catch(() => undefined),
  );
  return next;
}

/** Write via a temporary file in the same directory, then rename over the target. */
async function writeAtomic(file: string, content: string): Promise<void> {
  const temp = `${file}.tmp-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await writeFile(temp, content, 'utf8');
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/**
 * Record a week's samples, replacing whatever that week already held for the
 * packages named in `rows`. Returns the path written.
 *
 * Re-running a scan in the same week must not double the archive, so this is
 * an upsert keyed by package: rows for the packages present are replaced, rows
 * for every other package in that week are left exactly as they were. Within
 * `rows` the last entry for a package wins.
 *
 * `observedAt` chooses the file; each row keeps its own `observedAt` stamp, so
 * a batch assembled over a long-running scan stays honest about when each
 * package was actually sampled.
 *
 * Rows that could not survive a round-trip — no name, an unparseable timestamp,
 * an unknown state, a non-finite score — are dropped rather than written, since
 * a line that no reader will accept is worse than no line. When the merged
 * content is identical to what is already on disk, nothing is written at all,
 * which keeps `git status` quiet on a re-run.
 */
export async function appendSnapshots(
  rows: readonly HealthSnapshot[],
  observedAt: Date,
): Promise<string> {
  const file = snapshotPath(observedAt);

  const incoming = new Map<string, HealthSnapshot>();
  for (const row of rows) {
    const normalized = normalize(row);
    if (normalized === null) continue;
    incoming.set(nameKey(normalized.name), normalized);
  }

  if (incoming.size === 0) return file;

  return enqueue(file, async () => {
    const existing = await readSnapshotFile(file);
    const merged = [
      ...existing.filter((row) => !incoming.has(nameKey(row.name))),
      ...incoming.values(),
    ].sort(compareRows);

    const content = `${merged.map(serialize).join('\n')}\n`;

    let current: string | null = null;
    try {
      current = await readFile(file, 'utf8');
    } catch {
      current = null;
    }
    if (current === content) return file;

    await mkdir(dirname(file), { recursive: true });
    await writeAtomic(file, content);
    return file;
  });
}
