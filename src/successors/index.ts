/**
 * The curated succession dataset (`data/successors.yaml`).
 *
 * This file is hand-edited by contributors, so validation is deliberately
 * strict and the error messages are the user interface: every failure names the
 * row, the field and what was expected. Skipping a bad row would let a typo
 * silently delete a recommendation, so a malformed dataset throws instead.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import type {
  Confidence,
  SuccessionType,
  SuccessorDataset,
  SuccessorEvidence,
  SuccessorKind,
  SuccessorRecord,
} from '../types.js';

const SUCCESSION_TYPES: readonly SuccessionType[] = [
  'fork',
  'rename',
  'replacement',
  'absorbed',
  'self-declared',
  'reimplementation',
];

const CONFIDENCES: readonly Confidence[] = ['high', 'medium', 'low'];

const SUCCESSOR_KINDS: readonly SuccessorKind[] = ['package', 'platform', 'none'];

/** Exactly the fields documented in `data/SCHEMA.md`, nothing else. */
const ROW_FIELDS = [
  'from',
  'to',
  'toKind',
  'type',
  'confidence',
  'since',
  'dropIn',
  'alternatives',
  'notes',
  'migration',
  'evidence',
] as const;

const EVIDENCE_FIELDS = ['label', 'url'] as const;

const DATASET_RELATIVE_PATH = join('data', 'successors.yaml');

/** `YYYY-MM`, with a real month. */
const SINCE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

/**
 * Locate `data/successors.yaml` relative to this module.
 *
 * The same source compiles to `dist/successors/index.js`, so a hard-coded
 * `../../data` only happens to work because `rootDir` is `src` and both live
 * two levels below the package root. Rather than rely on that, walk up from
 * wherever this module ended up and take the first `data/successors.yaml` we
 * find. The ascent stops at the nearest `package.json`: past that point we
 * would be looking at *another* package's files — in a published install the
 * next `data/` up the tree belongs to the user's own project, and silently
 * reading it would be much worse than failing to find ours.
 *
 * The walk also tolerates the file not existing yet (fresh checkout, dataset
 * added later): it then returns the path where it *should* be, so callers get
 * a sensible path in error messages.
 */
function resolveDefaultDatasetPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));

  let dir = here;
  for (;;) {
    const candidate = join(dir, DATASET_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;
    // Nearest package root: the dataset belongs here even if it is missing.
    if (existsSync(join(dir, 'package.json'))) return candidate;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // No package.json anywhere above us (unbundled script, odd layout). Fall back
  // to the layout this repository actually ships.
  return resolve(here, '..', '..', DATASET_RELATIVE_PATH);
}

export const DEFAULT_DATASET_PATH: string = resolveDefaultDatasetPath();

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(allowed: readonly T[], value: string): value is T {
  return (allowed as readonly string[]).includes(value);
}

/** Human-readable type name, for "expected X, got Y" messages. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'nothing';
  if (Array.isArray(value)) return 'a list';
  if (value instanceof Date) return 'a date';
  if (typeof value === 'object') return 'a mapping';
  if (typeof value === 'string') return `a string (${JSON.stringify(value)})`;
  return `a ${typeof value} (${JSON.stringify(value)})`;
}

function quoteList(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(', ');
}

/** Catches `dropin:`, `Notes:`, `EVIDENCE:` — the usual hand-editing slips. */
function suggestField(key: string, allowed: readonly string[]): string {
  const folded = key.toLowerCase();
  const match = allowed.find((candidate) => candidate.toLowerCase() === folded);
  return match === undefined ? '' : ` (did you mean "${match}"?)`;
}

class RowContext {
  constructor(
    private readonly file: string,
    private readonly index: number,
    private readonly from: unknown,
  ) {}

  /** `…/successors.yaml: row 4 ("request"):` */
  prefix(): string {
    const named = typeof this.from === 'string' && this.from.trim() !== '' ? ` ("${this.from.trim()}")` : '';
    return `${this.file}: row ${this.index + 1}${named}:`;
  }

  fail(message: string): never {
    throw new Error(`${this.prefix()} ${message}`);
  }
}

function requireKey(row: Record<string, unknown>, field: string, ctx: RowContext): void {
  if (!(field in row)) {
    ctx.fail(`missing required field "${field}". See data/SCHEMA.md for the full row shape.`);
  }
}

function readRequiredString(row: Record<string, unknown>, field: string, ctx: RowContext): string {
  requireKey(row, field, ctx);
  const value = row[field];
  if (typeof value !== 'string' || value.trim() === '') {
    ctx.fail(`field "${field}" must be a non-empty string, got ${describe(value)}.`);
  }
  return value.trim();
}

/** Absent, `null` and `~` all mean "not known"; anything else must be a string. */
function readNullableString(row: Record<string, unknown>, field: string, ctx: RowContext): string | null {
  const value = row[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    ctx.fail(`field "${field}" must be a non-empty string or null, got ${describe(value)}.`);
  }
  return value.trim();
}

function readEvidence(row: Record<string, unknown>, ctx: RowContext): SuccessorEvidence[] {
  requireKey(row, 'evidence', ctx);
  const raw = row['evidence'];
  if (!Array.isArray(raw) || raw.length === 0) {
    ctx.fail(
      `field "evidence" must be a list with at least one { label, url } entry pointing at a primary source, got ${describe(raw)}.`,
    );
  }

  return raw.map((entry, position) => {
    const at = `evidence[${position + 1}]`;
    if (!isMapping(entry)) {
      ctx.fail(`${at} must be a mapping with "label" and "url", got ${describe(entry)}.`);
    }

    for (const key of Object.keys(entry)) {
      if (!(EVIDENCE_FIELDS as readonly string[]).includes(key)) {
        ctx.fail(
          `${at} has unknown field "${key}"${suggestField(key, EVIDENCE_FIELDS)}. Allowed: ${quoteList(EVIDENCE_FIELDS)}.`,
        );
      }
    }

    const label = entry['label'];
    if (typeof label !== 'string' || label.trim() === '') {
      ctx.fail(`${at} field "label" must be a non-empty string, got ${describe(label)}.`);
    }

    const url = entry['url'];
    if (typeof url !== 'string' || url.trim() === '') {
      ctx.fail(`${at} field "url" must be a non-empty string, got ${describe(url)}.`);
    }
    const trimmedUrl = url.trim();
    if (!URL.canParse(trimmedUrl) || !/^https?:$/.test(new URL(trimmedUrl).protocol)) {
      ctx.fail(`${at} field "url" must be an absolute http(s) URL, got "${trimmedUrl}".`);
    }

    return { label: label.trim(), url: trimmedUrl };
  });
}

function parseRow(file: string, index: number, raw: unknown): SuccessorRecord {
  if (!isMapping(raw)) {
    throw new Error(
      `${file}: row ${index + 1}: expected a mapping of the fields described in data/SCHEMA.md, got ${describe(raw)}.`,
    );
  }

  // The annotation is load-bearing: TypeScript only lets a `never`-returning
  // method end control flow when the callee's type is explicit.
  const ctx: RowContext = new RowContext(file, index, raw['from']);

  for (const key of Object.keys(raw)) {
    if (!(ROW_FIELDS as readonly string[]).includes(key)) {
      ctx.fail(`unknown field "${key}"${suggestField(key, ROW_FIELDS)}. Allowed fields: ${quoteList(ROW_FIELDS)}.`);
    }
  }

  const from = readRequiredString(raw, 'from', ctx);

  // `to` is the point of the row, so it must be written out even when it is
  // null ("nothing credible succeeded this"). Omitting it is an oversight.
  requireKey(raw, 'to', ctx);
  const to = readNullableString(raw, 'to', ctx);
  if (to !== null && to.toLowerCase() === from.toLowerCase()) {
    ctx.fail(`field "to" is the same package as "from" ("${to}"); a package cannot succeed itself.`);
  }

  // `toKind` is what stops the tool telling somebody to `npm install
  // String.prototype.padStart`. It may be omitted, in which case it is derived
  // from `to`, but when it is written down it has to agree with `to`.
  const rawToKind = raw['toKind'];
  let toKind: SuccessorKind;
  if (rawToKind === undefined || rawToKind === null) {
    toKind = to === null ? 'none' : 'package';
  } else {
    if (typeof rawToKind !== 'string' || !isOneOf(SUCCESSOR_KINDS, rawToKind.trim())) {
      ctx.fail(`field "toKind" must be one of ${quoteList(SUCCESSOR_KINDS)}, got ${describe(rawToKind)}.`);
    }
    toKind = rawToKind.trim() as SuccessorKind;
  }
  if (toKind === 'none' && to !== null) {
    ctx.fail(`field "toKind" is "none" but "to" names "${to}"; use "package" or "platform", or set "to" to null.`);
  }
  if (toKind !== 'none' && to === null) {
    ctx.fail(`field "toKind" is "${toKind}" but "to" is null; use "none" when nothing credible succeeded this package.`);
  }

  const typeValue = readRequiredString(raw, 'type', ctx);
  if (!isOneOf(SUCCESSION_TYPES, typeValue)) {
    ctx.fail(`field "type" must be one of ${quoteList(SUCCESSION_TYPES)}, got "${typeValue}".`);
  }

  const confidenceValue = readRequiredString(raw, 'confidence', ctx);
  if (!isOneOf(CONFIDENCES, confidenceValue)) {
    ctx.fail(`field "confidence" must be one of ${quoteList(CONFIDENCES)}, got "${confidenceValue}".`);
  }

  const since = readNullableString(raw, 'since', ctx);
  if (since !== null && !SINCE_PATTERN.test(since)) {
    ctx.fail(`field "since" must be "YYYY-MM" (quoted, so YAML keeps it a string) or null, got "${since}".`);
  }

  requireKey(raw, 'dropIn', ctx);
  const dropIn = raw['dropIn'];
  if (typeof dropIn !== 'boolean') {
    ctx.fail(`field "dropIn" must be true or false, got ${describe(dropIn)}.`);
  }
  if (dropIn && to === null) {
    ctx.fail('field "dropIn" cannot be true when "to" is null: there is no successor to swap in.');
  }
  if (dropIn && toKind !== 'package') {
    ctx.fail(`field "dropIn" cannot be true when "toKind" is "${toKind}": there is no package to swap in.`);
  }

  const rawAlternatives = raw['alternatives'];
  let alternatives: string[] = [];
  if (rawAlternatives !== undefined && rawAlternatives !== null) {
    if (!Array.isArray(rawAlternatives)) {
      ctx.fail(`field "alternatives" must be a list of package names (possibly empty), got ${describe(rawAlternatives)}.`);
    }
    alternatives = rawAlternatives.map((entry, position) => {
      if (typeof entry !== 'string' || entry.trim() === '') {
        ctx.fail(`alternatives[${position + 1}] must be a non-empty package name, got ${describe(entry)}.`);
      }
      return entry.trim();
    });
  }

  const notes = readRequiredString(raw, 'notes', ctx);
  const migration = readNullableString(raw, 'migration', ctx);
  const evidence = readEvidence(raw, ctx);

  return { from, to, toKind, type: typeValue, confidence: confidenceValue, since, dropIn, alternatives, notes, migration, evidence };
}

/**
 * The dataset is a top-level list. A mapping wrapper (`successors:` / `records:`)
 * is accepted too so the file can grow front-matter later without breaking.
 */
function extractRows(file: string, doc: unknown): unknown[] {
  if (doc === null || doc === undefined) return [];
  if (Array.isArray(doc)) return doc;

  if (isMapping(doc)) {
    for (const key of ['successors', 'records']) {
      const value = doc[key];
      if (value === undefined) continue;
      if (!Array.isArray(value)) {
        throw new Error(`${file}: top-level "${key}" must be a list of rows, got ${describe(value)}.`);
      }
      return value;
    }
  }

  throw new Error(
    `${file}: expected a top-level list of succession rows (or a mapping with a "successors" list), got ${describe(doc)}.`,
  );
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function emptyDataset(): SuccessorDataset {
  return { records: [], byFrom: new Map() };
}

function buildDataset(file: string, rows: unknown[]): SuccessorDataset {
  const records: SuccessorRecord[] = [];
  const byFrom = new Map<string, SuccessorRecord>();
  const rowOf = new Map<string, number>();

  rows.forEach((raw, index) => {
    const record = parseRow(file, index, raw);
    const key = normalizeName(record.from);
    const previous = rowOf.get(key);
    if (previous !== undefined) {
      throw new Error(
        `${file}: row ${index + 1} ("${record.from}"): duplicate "from" — row ${previous + 1} already covers this package. Merge the two rows.`,
      );
    }
    rowOf.set(key, index);
    byFrom.set(key, record);
    records.push(record);
  });

  return { records, byFrom };
}

function isMissingFile(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function readDataset(file: string): Promise<{ dataset: SuccessorDataset; cacheable: boolean }> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    // The bundled dataset may legitimately be absent (fresh checkout, a build
    // that did not copy `data/`). Degrade to "no curated successors" instead of
    // taking the whole scan down — but never cache that, so the file appearing
    // later is picked up. An explicitly requested path is a different story: a
    // typo there must be reported.
    if (isMissingFile(error) && file === DEFAULT_DATASET_PATH) {
      return { dataset: emptyDataset(), cacheable: false };
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read succession dataset at ${file}: ${detail}`, { cause: error });
  }

  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${file}: invalid YAML: ${detail}`, { cause: error });
  }

  return { dataset: buildDataset(file, extractRows(file, doc)), cacheable: true };
}

/** Keyed by absolute path: parsing is pure, so one load per file per process. */
const datasetCache = new Map<string, Promise<SuccessorDataset>>();

export async function loadSuccessors(path?: string): Promise<SuccessorDataset> {
  const file = path === undefined ? DEFAULT_DATASET_PATH : resolve(path);

  const cached = datasetCache.get(file);
  if (cached !== undefined) return cached;

  const pending = readDataset(file).then(
    (result) => {
      if (!result.cacheable) datasetCache.delete(file);
      return result.dataset;
    },
    (error: unknown) => {
      // Do not memoise failures: a contributor fixing the file mid-session
      // should not have to restart the process.
      datasetCache.delete(file);
      throw error;
    },
  );

  datasetCache.set(file, pending);
  return pending;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

function stripScope(name: string): string {
  if (!name.startsWith('@')) return name;
  const slash = name.indexOf('/');
  return slash === -1 ? name : name.slice(slash + 1);
}

/**
 * Secondary index for the scope-insensitive fallback. Kept beside the dataset
 * rather than inside it because `SuccessorDataset` is a fixed contract; the
 * WeakMap also means a caller-built dataset (tests) works without extra setup.
 * Datasets are treated as immutable once loaded.
 */
const bareNameIndexes = new WeakMap<SuccessorDataset, Map<string, SuccessorRecord[]>>();

function bareNameIndex(dataset: SuccessorDataset): Map<string, SuccessorRecord[]> {
  const existing = bareNameIndexes.get(dataset);
  if (existing !== undefined) return existing;

  const index = new Map<string, SuccessorRecord[]>();
  for (const record of dataset.records) {
    const bare = stripScope(normalizeName(record.from));
    if (bare === '') continue;
    const bucket = index.get(bare);
    if (bucket === undefined) index.set(bare, [record]);
    else bucket.push(record);
  }

  bareNameIndexes.set(dataset, index);
  return index;
}

/**
 * Exact (case-insensitive) match first, then a scope-insensitive fallback so
 * `@scope/foo` can find a row written for `foo` and vice versa. The fallback
 * only fires when exactly one row shares the bare name: recommending the wrong
 * `@a/parser` for `@b/parser` is worse than recommending nothing.
 */
export function lookupSuccessor(ds: SuccessorDataset, name: string): SuccessorRecord | null {
  const key = normalizeName(name);
  if (key === '') return null;

  const exact = ds.byFrom.get(key);
  if (exact !== undefined) return exact;

  const candidates = bareNameIndex(ds).get(stripScope(key));
  if (candidates === undefined || candidates.length !== 1) return null;
  return candidates[0] ?? null;
}
