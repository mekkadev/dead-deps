/**
 * `package.json` handling, plus the small helpers every lockfile parser needs.
 *
 * Two jobs live here:
 *
 * 1. Reading a project manifest and turning its four dependency fields into a
 *    lookup table. Every lockfile parser cross-references that table to decide
 *    whether an entry is *direct* — the flag that drives the default report.
 * 2. Acting as the fallback parser when a project has no lockfile at all.
 *
 * This module is the leaf of `src/lockfile/`: it imports no sibling parser, so
 * the shared primitives (name validation, scope merging, de-duplication) can
 * live here without creating an import cycle.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { DependencyScope, ParsedDependency, ParsedLockfile } from '../types.js';

/** A dependency as declared by the project's own manifest. */
export interface DirectDependency {
  scope: DependencyScope;
  /** The declared range, e.g. `^1.2.3`. `null` when the value was not a string. */
  range: string | null;
}

export type DirectMap = Map<string, DirectDependency>;

export type ReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; missing: boolean; message: string };

/**
 * Manifest fields in resolution order: the first field a package appears in
 * wins. `optionalDependencies` leads because npm treats an entry there as
 * overriding the same name in `dependencies`.
 */
export const MANIFEST_FIELDS: ReadonlyArray<readonly [string, DependencyScope]> = [
  ['optionalDependencies', 'optional'],
  ['dependencies', 'prod'],
  ['devDependencies', 'dev'],
  ['peerDependencies', 'peer'],
];

/**
 * Which scope survives when the same name+version turns up twice. A package
 * reachable as both a production and a dev dependency is a production
 * dependency; `dev` is the weakest claim and loses to everything.
 */
const SCOPE_RANK: Record<DependencyScope, number> = {
  prod: 0,
  peer: 1,
  optional: 2,
  dev: 3,
};

/** Version strings that point back inside the project rather than a registry. */
const LOCAL_PROTOCOLS = ['file:', 'link:', 'workspace:', 'portal:'];

const NAME_PATTERN = /^(?:@[^/@\s]+\/)?[^/@\s][^/\s]*$/;

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Deliberately looser than npm's own validator: lockfiles in the wild still
 * carry legacy names with capitals. We only need to reject things that are
 * obviously not package names (paths, empty strings, descriptor fragments).
 */
export function isValidPackageName(name: string): boolean {
  if (name.length === 0 || name.length > 214) return false;
  if (name.startsWith('.') || name.startsWith('_')) return false;
  return NAME_PATTERN.test(name);
}

/** True for `file:`/`link:`/`workspace:` style references we must not report. */
export function isLocalReference(version: string | null): boolean {
  if (version === null) return false;
  const lowered = version.toLowerCase();
  return LOCAL_PROTOCOLS.some((protocol) => lowered.startsWith(protocol));
}

/**
 * Normalise a resolved version. Git and tarball references pin something, but
 * not a version, and callers should not be told otherwise.
 */
export function normaliseVersion(raw: unknown): string | null {
  // YAML happily turns an unquoted `version: 1.2` into a number.
  const value = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : asString(raw);
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^\d/.test(trimmed)) return trimmed;
  // `v1.2.3` shows up in git-tag resolutions often enough to be worth keeping.
  if (/^v\d/.test(trimmed)) return trimmed.slice(1);
  return null;
}

export function strongerScope(a: DependencyScope, b: DependencyScope): DependencyScope {
  return SCOPE_RANK[a] <= SCOPE_RANK[b] ? a : b;
}

/**
 * Collapse duplicates and impose a stable order.
 *
 * Lockfiles routinely list the same name+version several times (hoisted copies,
 * per-importer entries, multiple peer permutations). Merging keeps the strongest
 * claim: direct beats transitive, and production beats dev.
 */
export function finalizeDependencies(entries: readonly ParsedDependency[]): ParsedDependency[] {
  const merged = new Map<string, ParsedDependency>();

  for (const entry of entries) {
    const key = `${entry.name}@${entry.version ?? ''}`;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, { ...entry });
      continue;
    }
    existing.direct = existing.direct || entry.direct;
    existing.scope = strongerScope(existing.scope, entry.scope);
  }

  return [...merged.values()].sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    const av = a.version ?? '';
    const bv = b.version ?? '';
    if (av !== bv) return av < bv ? -1 : 1;
    return 0;
  });
}

/**
 * Build a `ParsedDependency`, resolving directness against the manifest.
 *
 * When a package is direct the manifest decides its scope: the manifest field
 * is what the user can actually edit. Transitive entries keep whatever the
 * lockfile said about them.
 */
export function toDependency(
  name: string,
  version: string | null,
  lockScope: DependencyScope,
  direct: DirectMap,
): ParsedDependency {
  const declared = direct.get(name);
  if (declared !== undefined) {
    return { name, version, direct: true, scope: declared.scope };
  }
  return { name, version, direct: false, scope: lockScope };
}

export async function readTextFile(path: string): Promise<ReadResult<string>> {
  try {
    return { ok: true, value: await readFile(path, 'utf8') };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const missing = code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR';
    return { ok: false, missing, message: describeError(error) };
  }
}

export async function readJsonFile(path: string): Promise<ReadResult<unknown>> {
  const text = await readTextFile(path);
  if (!text.ok) return text;
  try {
    return { ok: true, value: JSON.parse(text.value) as unknown };
  } catch (error) {
    return { ok: false, missing: false, message: `invalid JSON: ${describeError(error)}` };
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Read the four dependency fields off an already-parsed manifest-shaped object.
 *
 * Also used for the `""` root entry of an npm v2/v3 lockfile and for pnpm
 * importer records, which have the same shape.
 */
export function collectDirect(source: unknown, into?: DirectMap): DirectMap {
  const map = into ?? new Map<string, DirectDependency>();
  const record = asRecord(source);
  if (record === null) return map;

  for (const [field, scope] of MANIFEST_FIELDS) {
    const block = asRecord(record[field]);
    if (block === null) continue;
    for (const [name, rawRange] of Object.entries(block)) {
      if (!isValidPackageName(name)) continue;
      if (map.has(name)) continue;
      map.set(name, { scope, range: asString(rawRange) });
    }
  }

  return map;
}

/**
 * Load the `package.json` that sits next to a lockfile.
 *
 * A missing manifest is survivable — every dependency simply reports as
 * transitive — but it is worth a warning, because it silently empties the
 * default report.
 */
export async function readSiblingManifest(
  lockfilePath: string,
): Promise<{ direct: DirectMap | null; warnings: string[] }> {
  const manifestPath = join(dirname(lockfilePath), 'package.json');
  const result = await readJsonFile(manifestPath);

  if (!result.ok) {
    const reason = result.missing ? 'not found' : result.message;
    return {
      direct: null,
      warnings: [
        `could not read ${manifestPath} (${reason}); direct dependencies cannot be identified from the manifest`,
      ],
    };
  }

  if (asRecord(result.value) === null) {
    return {
      direct: null,
      warnings: [`${manifestPath} is not a JSON object; ignoring it`],
    };
  }

  return { direct: collectDirect(result.value), warnings: [] };
}

/**
 * Parse a bare `package.json` as if it were a lockfile.
 *
 * Used when a project has no lockfile: everything declared is direct, and the
 * "version" is the declared range rather than a resolved version.
 */
export async function parseManifestFile(path: string): Promise<ParsedLockfile> {
  const absolute = resolve(path);
  const warnings: string[] = [];
  const result = await readJsonFile(absolute);

  if (!result.ok) {
    throw new Error(`cannot read ${absolute}: ${result.message}`);
  }
  const record = asRecord(result.value);
  if (record === null) {
    throw new Error(`cannot read ${absolute}: expected a JSON object at the top level`);
  }

  const direct = collectDirect(record);
  const dependencies: ParsedDependency[] = [];

  for (const [name, declared] of direct) {
    if (isLocalReference(declared.range)) continue;
    dependencies.push({ name, version: declared.range, direct: true, scope: declared.scope });
  }

  if (dependencies.length === 0) {
    warnings.push(`${absolute} declares no dependencies`);
  }

  return {
    format: 'package-json',
    path: absolute,
    dependencies: finalizeDependencies(dependencies),
    warnings,
  };
}
