/**
 * The npm registry packument.
 *
 * Two things live here that no other source has authoritatively: the
 * `deprecated` field on the latest version — the strongest "this is dead"
 * signal in the ecosystem — and the full `time` map, from which the
 * package's historical release rhythm can be reconstructed.
 */

import type { PackageSignals } from '../types.js';
import type { HttpClient } from './http.js';

const NPM_REGISTRY_BASE = 'https://registry.npmjs.org';

const MS_PER_DAY = 86_400_000;

/** `time` keys that are not releases. */
const NON_RELEASE_TIME_KEYS = new Set(['created', 'modified', 'unpublished']);

// ---------------------------------------------------------------------------
// Upstream shape (only the fields this tool reads)
// ---------------------------------------------------------------------------

export interface NpmRepository {
  type?: string | null;
  url?: string | null;
}

export interface NpmVersion {
  version?: string | null;
  /**
   * npm stores the deprecation message here. `npm deprecate pkg ""` clears it,
   * but some publishers leave `true` or an empty string behind — both still
   * mean deprecated.
   */
  deprecated?: string | boolean | null;
  repository?: NpmRepository | string | null;
}

export interface NpmPackument {
  name?: string | null;
  'dist-tags'?: Record<string, string> | null;
  versions?: Record<string, NpmVersion> | null;
  /** Version number -> ISO publish date, plus `created` and `modified`. */
  time?: Record<string, string> | null;
  repository?: NpmRepository | string | null;
  homepage?: string | null;
  deprecated?: string | boolean | null;
}

// ---------------------------------------------------------------------------
// JSON narrowing
// ---------------------------------------------------------------------------

function asObject<T extends object>(value: T | null | undefined): T | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function asTimestamp(value: unknown): string | null {
  const text = asString(value);
  if (text === null) return null;
  return Number.isFinite(Date.parse(text)) ? text : null;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export function npmPackumentUrl(name: string): string {
  // Scoped names need `%2F` for the slash; encodeURIComponent also handles `@`.
  return `${NPM_REGISTRY_BASE}/${encodeURIComponent(name)}`;
}

export async function fetchNpmPackument(
  http: HttpClient,
  name: string,
): Promise<NpmPackument | null> {
  if (name.trim() === '') return null;
  const doc = await http.getJson<NpmPackument>(npmPackumentUrl(name));
  return asObject(doc);
}

// ---------------------------------------------------------------------------
// Deprecation
// ---------------------------------------------------------------------------

/**
 * Normalises npm's tri-state `deprecated` field to a non-empty message, or
 * `null` when the package is not deprecated. `true` and `""` both count as
 * deprecated and get a synthesised message.
 */
export function normaliseDeprecation(
  raw: unknown,
  name: string,
  version: string | null,
): string | null {
  if (raw === undefined || raw === null || raw === false) return null;
  if (typeof raw === 'string') {
    const message = raw.trim();
    if (message !== '') return message;
  } else if (raw !== true) {
    return null;
  }
  const subject = version === null ? name : `${name}@${version}`;
  return `${subject} is marked deprecated on the npm registry (no message given).`;
}

// ---------------------------------------------------------------------------
// Release cadence
// ---------------------------------------------------------------------------

function isPrerelease(version: string): boolean {
  const core = version.split('+')[0] ?? version;
  return core.includes('-');
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  if (lower === undefined || upper === undefined) return null;
  return (lower + upper) / 2;
}

/**
 * Median gap in days between consecutive releases across the package's life.
 * The median rather than the mean: a single burst of ten releases in one
 * afternoon must not make a decade-old package look fast-moving.
 *
 * Returns `null` for fewer than three releases, where a "typical gap" is not
 * a meaningful thing to compute.
 */
export function medianReleaseGapDays(time: NpmPackument['time']): number | null {
  const releases = asObject(time);
  if (releases === null) return null;

  const all: number[] = [];
  const stable: number[] = [];
  for (const [version, published] of Object.entries(releases)) {
    if (NON_RELEASE_TIME_KEYS.has(version)) continue;
    const text = asString(published);
    if (text === null) continue;
    const parsed = Date.parse(text);
    if (!Number.isFinite(parsed)) continue;
    all.push(parsed);
    if (!isPrerelease(version)) stable.push(parsed);
  }

  // Prereleases are excluded unless doing so leaves too little to measure.
  const timestamps = stable.length >= 3 ? stable : all;
  if (timestamps.length < 3) return null;
  timestamps.sort((a, b) => a - b);

  const gaps: number[] = [];
  let previous = timestamps[0];
  if (previous === undefined) return null;
  for (let i = 1; i < timestamps.length; i += 1) {
    const current = timestamps[i];
    if (current === undefined) continue;
    gaps.push((current - previous) / MS_PER_DAY);
    previous = current;
  }

  const value = median(gaps);
  return value === null ? null : Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function normaliseRepositoryUrl(repository: NpmRepository | string | null | undefined): string | null {
  const raw =
    typeof repository === 'string'
      ? asString(repository)
      : asString(asObject(repository)?.url);
  if (raw === null) return null;

  let url = raw.replace(/^git\+/, '').replace(/\.git$/, '');
  const sshMatch = /^(?:git\+)?ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/.exec(url);
  if (sshMatch !== null) {
    url = `https://${sshMatch[1]}/${sshMatch[2]}`;
  } else if (url.startsWith('git://')) {
    url = `https://${url.slice('git://'.length)}`;
  }
  return url;
}

/**
 * Folds a packument into `signals`. npm is authoritative for deprecation and
 * for release cadence; for everything else it only fills gaps the package
 * index left behind. `registryStatus` is deliberately not touched here — the
 * caller reconciles it, because only the caller knows whether ecosyste.ms
 * answered at all.
 */
export function applyNpmSignals(signals: PackageSignals, doc: NpmPackument): void {
  const versions = asObject(doc.versions);
  const distTags = asObject(doc['dist-tags']);
  const latest = asString(distTags?.['latest']);
  const time = asObject(doc.time);

  if (latest !== null) signals.latestVersion = latest;

  const latestManifest = latest === null ? null : asObject(versions?.[latest]);
  const rawDeprecation = latestManifest?.deprecated ?? doc.deprecated;
  signals.deprecationMessage =
    normaliseDeprecation(rawDeprecation, signals.name, latest) ?? signals.deprecationMessage;

  if (signals.versionsCount === null && versions !== null) {
    signals.versionsCount = Object.keys(versions).length;
  }

  if (time !== null) {
    if (signals.latestReleaseAt === null && latest !== null) {
      signals.latestReleaseAt = asTimestamp(time[latest]);
    }
    if (signals.firstReleaseAt === null) {
      signals.firstReleaseAt = asTimestamp(time['created']);
    }
  }

  signals.historicalReleaseCadenceDays =
    medianReleaseGapDays(doc.time) ?? signals.historicalReleaseCadenceDays;

  if (signals.repositoryUrl === null) {
    signals.repositoryUrl =
      normaliseRepositoryUrl(doc.repository) ??
      normaliseRepositoryUrl(latestManifest?.repository);
  }
}
