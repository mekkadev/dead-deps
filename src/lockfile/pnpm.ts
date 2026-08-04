/**
 * `pnpm-lock.yaml`, versions 5.x, 6.x and 9.x.
 *
 * The three generations differ in how a package is keyed:
 *
 *   v5  `/foo/1.2.3`            `/@scope/foo/1.2.3`   peers: `/foo/1.2.3_bar@2.0.0`
 *   v6  `/foo@1.2.3`            `/@scope/foo@1.2.3`   peers: `/foo@1.2.3(bar@2.0.0)`
 *   v9  `foo@1.2.3`             `@scope/foo@1.2.3`    peers: `foo@1.2.3(bar@2.0.0)`
 *
 * and in where direct dependencies live: v5 and v6 put them at the top level
 * for a single-project repo and under `importers` for a workspace, while v9
 * always uses `importers`. Rather than branching on the declared version — which
 * a partially-migrated lockfile can lie about — one tolerant key parser handles
 * every shape and both dependency locations are read.
 */

import { resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { DependencyScope, ParsedDependency, ParsedLockfile } from '../types.js';
import {
  asRecord,
  asString,
  describeError,
  finalizeDependencies,
  isLocalReference,
  isValidPackageName,
  MANIFEST_FIELDS,
  normaliseVersion,
  readSiblingManifest,
  toDependency,
  type DirectMap,
} from './manifest.js';

const KNOWN_MAJORS = new Set([5, 6, 9]);

type KeyParse =
  | { kind: 'package'; name: string; version: string | null }
  /** A `link:`/`file:`/`workspace:` reference — inside the project, not a dependency. */
  | { kind: 'local' }
  | { kind: 'unknown' };

/** Peer-dependency suffixes: `(react@18.0.0)` in v6/v9, `_react@18.0.0` in v5. */
function stripPeerSuffix(value: string): string {
  const paren = value.indexOf('(');
  return paren >= 0 ? value.slice(0, paren) : value;
}

/**
 * Parse any pnpm package key or resolved-version string into name + version.
 *
 * Handles all three key dialects, scoped names, aliases (`a@npm:b@1.0.0`) and
 * both peer-suffix encodings.
 */
export function parsePnpmKey(raw: string): KeyParse {
  let key = stripPeerSuffix(raw.trim());
  if (key.length === 0) return { kind: 'unknown' };
  if (isLocalReference(key)) return { kind: 'local' };

  // `left-pad@npm:pad-left@1.0.0` resolves to the aliased package, not the alias.
  const alias = key.indexOf('@npm:');
  if (alias > 0) key = key.slice(alias + '@npm:'.length);

  if (key.startsWith('/')) key = key.slice(1);
  if (key.length === 0) return { kind: 'unknown' };

  let name: string;
  let version: string;

  const lastSlash = key.lastIndexOf('/');
  const tail = lastSlash >= 0 ? key.slice(lastSlash + 1) : '';
  if (lastSlash > 0 && /^\d/.test(tail)) {
    // v5: the final path segment is the version.
    name = key.slice(0, lastSlash);
    version = tail;
  } else {
    const at = key.lastIndexOf('@');
    if (at <= 0) return { kind: 'unknown' };
    name = key.slice(0, at);
    version = key.slice(at + 1);
  }

  const underscore = version.indexOf('_');
  if (underscore > 0) version = version.slice(0, underscore);

  if (isLocalReference(version)) return { kind: 'local' };
  if (!isValidPackageName(name)) return { kind: 'unknown' };

  return { kind: 'package', name, version: normaliseVersion(version) };
}

function scopeFromEntry(entry: Record<string, unknown> | null): DependencyScope {
  if (entry === null) return 'prod';
  if (entry['dev'] === true) return 'dev';
  if (entry['optional'] === true) return 'optional';
  return 'prod';
}

/**
 * Read one importer (or the top-level maps of a v5/v6 single-project lockfile).
 *
 * Dependency values are either a bare resolved version (v5) or a
 * `{ specifier, version }` record (v6/v9).
 */
function readImporter(
  source: unknown,
  direct: DirectMap,
  entries: ParsedDependency[],
): void {
  const importer = asRecord(source);
  if (importer === null) return;

  for (const [field, scope] of MANIFEST_FIELDS) {
    const block = asRecord(importer[field]);
    if (block === null) continue;

    for (const [name, rawValue] of Object.entries(block)) {
      if (!isValidPackageName(name)) continue;

      let specifier: string | null = null;
      let resolved: string | null = null;

      if (typeof rawValue === 'string') {
        resolved = rawValue;
      } else {
        const record = asRecord(rawValue);
        if (record === null) continue;
        specifier = asString(record['specifier']);
        resolved = asString(record['version']);
      }

      if (isLocalReference(resolved) || isLocalReference(specifier)) continue;

      if (!direct.has(name)) {
        direct.set(name, { scope, range: specifier ?? resolved });
      }

      if (resolved !== null) {
        const parsed = parsePnpmKey(resolved.startsWith('/') ? resolved : `${name}@${resolved}`);
        if (parsed.kind === 'package') {
          entries.push({ name, version: parsed.version, direct: true, scope });
        }
      }
    }
  }
}

function majorOf(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === 'string') {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

export async function parsePnpmLockfile(path: string, text: string): Promise<ParsedLockfile> {
  const absolute = resolve(path);
  const warnings: string[] = [];

  let parsed: unknown;
  try {
    parsed = parseYaml(text) as unknown;
  } catch (error) {
    throw new Error(`cannot parse ${absolute}: invalid YAML (${describeError(error)})`);
  }

  const root = asRecord(parsed);
  if (root === null) {
    throw new Error(`cannot parse ${absolute}: expected a YAML mapping at the top level`);
  }

  const major = majorOf(root['lockfileVersion']);
  if (major === null) {
    warnings.push(`${absolute} has no lockfileVersion; parsing it generically`);
  } else if (!KNOWN_MAJORS.has(major)) {
    warnings.push(`pnpm lockfileVersion ${major}.x is not one this tool was written against; parsing it generically`);
  }

  const direct: DirectMap = new Map();
  const dependencies: ParsedDependency[] = [];

  const importers = asRecord(root['importers']);
  if (importers !== null) {
    for (const importer of Object.values(importers)) {
      readImporter(importer, direct, dependencies);
    }
  }
  // v5/v6 single-project lockfiles keep the same maps at the top level.
  readImporter(root, direct, dependencies);

  // The manifest fills any gap left by the importers — and is the only source
  // at all for a lockfile whose importers block is missing or empty.
  const sibling = await readSiblingManifest(absolute);
  if (sibling.direct !== null) {
    for (const [name, declared] of sibling.direct) {
      if (!direct.has(name)) direct.set(name, declared);
    }
  } else if (direct.size === 0) {
    warnings.push(...sibling.warnings);
  }

  // v9 splits metadata (`packages`) from the resolved graph (`snapshots`); the
  // two key spaces overlap but neither is guaranteed to be complete on its own.
  const keyed: Array<[string, Record<string, unknown> | null]> = [];
  for (const field of ['packages', 'snapshots']) {
    const block = asRecord(root[field]);
    if (block === null) continue;
    for (const [key, value] of Object.entries(block)) {
      keyed.push([key, asRecord(value)]);
    }
  }

  if (keyed.length === 0 && importers === null) {
    warnings.push(`${absolute} contains no "packages", "snapshots" or "importers" section`);
  }

  for (const [key, entry] of keyed) {
    const result = parsePnpmKey(key);
    if (result.kind === 'local') continue;
    if (result.kind === 'unknown') {
      warnings.push(`could not parse package key "${key}"; skipped`);
      continue;
    }
    dependencies.push(toDependency(result.name, result.version, scopeFromEntry(entry), direct));
  }

  return {
    format: 'pnpm',
    path: absolute,
    dependencies: finalizeDependencies(dependencies),
    warnings,
  };
}
