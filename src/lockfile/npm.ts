/**
 * `package-lock.json` and `npm-shrinkwrap.json`.
 *
 * npm has shipped three incompatible lockfile layouts:
 *
 *   v1 (npm 6)  — a nested `dependencies` tree keyed by bare package name.
 *   v2 (npm 7-8)— a flat `packages` map keyed by install path, plus the v1 tree
 *                 duplicated underneath it for backwards compatibility.
 *   v3 (npm 9+) — `packages` only.
 *
 * We prefer `packages` whenever it exists: the install-path keys disambiguate
 * nested copies of the same package, which the v1 tree cannot do without
 * walking it. The declared `lockfileVersion` only decides the reported format;
 * the actual parse strategy follows the content, because hand-edited and
 * tool-rewritten lockfiles disagree with their own version field often enough
 * to matter.
 */

import { resolve } from 'node:path';

import type { DependencyScope, LockfileFormat, ParsedDependency, ParsedLockfile } from '../types.js';
import {
  asRecord,
  collectDirect,
  finalizeDependencies,
  isLocalReference,
  isValidPackageName,
  normaliseVersion,
  readSiblingManifest,
  toDependency,
  type DirectMap,
} from './manifest.js';

const NODE_MODULES = 'node_modules/';

/** Depth guard for the v1 tree; real trees are shallow, corrupt ones may not be. */
const MAX_TREE_DEPTH = 64;

function truthy(value: unknown): boolean {
  return value === true;
}

/**
 * npm records `dev`, `optional`, `peer` and `devOptional` independently. Being
 * a dev dependency is the most consequential of those for a report, so it wins.
 */
function scopeFromFlags(entry: Record<string, unknown>): DependencyScope {
  if (truthy(entry['dev']) || truthy(entry['devOptional'])) return 'dev';
  if (truthy(entry['optional'])) return 'optional';
  if (truthy(entry['peer'])) return 'peer';
  return 'prod';
}

/** Derive the package name from an install path key such as
 *  `node_modules/a/node_modules/@scope/b` → `@scope/b`. */
export function nameFromPackagesKey(key: string): string | null {
  const index = key.lastIndexOf(NODE_MODULES);
  if (index < 0) return null;
  const name = key.slice(index + NODE_MODULES.length).replace(/\/+$/, '');
  return isValidPackageName(name) ? name : null;
}

function parsePackagesMap(
  packages: Record<string, unknown>,
  direct: DirectMap,
  warnings: string[],
): ParsedDependency[] {
  const dependencies: ParsedDependency[] = [];

  for (const [key, rawEntry] of Object.entries(packages)) {
    if (key === '') continue; // the root manifest, handled by the caller

    const entry = asRecord(rawEntry);
    if (entry === null) {
      warnings.push(`packages["${key}"] is not an object; skipped`);
      continue;
    }

    // Workspace roots are listed under their directory ("packages/app"), and
    // their node_modules aliases carry `link: true`. Neither is a dependency
    // the user can act on.
    if (truthy(entry['link'])) continue;
    if (!key.includes(NODE_MODULES)) continue;

    const pathName = nameFromPackagesKey(key);
    if (pathName === null) {
      warnings.push(`packages["${key}"]: could not derive a package name; skipped`);
      continue;
    }

    // npm writes an explicit `name` only when the install directory does not
    // match the published package — i.e. for `npm:` aliases. The published
    // name is the one worth assessing.
    const aliased = typeof entry['name'] === 'string' ? entry['name'] : null;
    const name = aliased !== null && isValidPackageName(aliased) ? aliased : pathName;

    const rawVersion = typeof entry['version'] === 'string' ? entry['version'] : null;
    const resolved = typeof entry['resolved'] === 'string' ? entry['resolved'] : null;
    if (isLocalReference(rawVersion) || isLocalReference(resolved)) continue;

    dependencies.push(toDependency(name, normaliseVersion(rawVersion), scopeFromFlags(entry), direct));
  }

  return dependencies;
}

function walkDependencyTree(
  node: Record<string, unknown>,
  direct: DirectMap,
  warnings: string[],
  dependencies: ParsedDependency[],
  depth: number,
  trail: string,
): void {
  if (depth > MAX_TREE_DEPTH) {
    warnings.push(`dependency tree deeper than ${MAX_TREE_DEPTH} levels at ${trail}; stopped descending`);
    return;
  }

  for (const [name, rawEntry] of Object.entries(node)) {
    const where = trail.length > 0 ? `${trail} > ${name}` : name;

    const entry = asRecord(rawEntry);
    if (entry === null) {
      warnings.push(`dependencies[${where}] is not an object; skipped`);
      continue;
    }
    if (!isValidPackageName(name)) {
      warnings.push(`dependencies[${where}] is not a usable package name; skipped`);
      continue;
    }

    const rawVersion = typeof entry['version'] === 'string' ? entry['version'] : null;
    const resolved = typeof entry['resolved'] === 'string' ? entry['resolved'] : null;

    if (!isLocalReference(rawVersion) && !isLocalReference(resolved)) {
      dependencies.push(toDependency(name, normaliseVersion(rawVersion), scopeFromFlags(entry), direct));
    }

    const nested = asRecord(entry['dependencies']);
    if (nested !== null) {
      walkDependencyTree(nested, direct, warnings, dependencies, depth + 1, where);
    }
  }
}

function detectVersion(root: Record<string, unknown>): number | null {
  const raw = root['lockfileVersion'];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatFor(version: number | null, hasPackages: boolean): LockfileFormat {
  if (version === 1) return 'npm-v1';
  if (version === 2) return 'npm-v2';
  if (version !== null && version >= 3) return 'npm-v3';
  return hasPackages ? 'npm-v3' : 'npm-v1';
}

export async function parseNpmLockfile(path: string, text: string): Promise<ParsedLockfile> {
  const absolute = resolve(path);
  const warnings: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`cannot parse ${absolute}: invalid JSON (${(error as Error).message})`);
  }

  const root = asRecord(parsed);
  if (root === null) {
    throw new Error(`cannot parse ${absolute}: expected a JSON object at the top level`);
  }

  const version = detectVersion(root);
  const packages = asRecord(root['packages']);
  const tree = asRecord(root['dependencies']);
  const format = formatFor(version, packages !== null);

  if (version === null) {
    warnings.push(`${absolute} has no lockfileVersion; assuming ${format}`);
  } else if (version > 3) {
    warnings.push(`lockfileVersion ${version} is newer than this tool understands; parsing it as v3`);
  }

  // The manifest is authoritative for directness. The lockfile's own root entry
  // is only a mirror of it, so it is a fallback, not a supplement.
  const sibling = await readSiblingManifest(absolute);
  let direct: DirectMap;
  if (sibling.direct !== null) {
    direct = sibling.direct;
  } else {
    const rootEntry = packages === null ? null : asRecord(packages['']);
    if (rootEntry !== null) {
      direct = collectDirect(rootEntry);
      warnings.push('using the lockfile root entry to identify direct dependencies');
    } else {
      direct = new Map();
      warnings.push(...sibling.warnings);
    }
  }

  let dependencies: ParsedDependency[];
  if (packages !== null) {
    dependencies = parsePackagesMap(packages, direct, warnings);
    if (dependencies.length === 0 && tree !== null) {
      // A v2 lockfile whose `packages` map is empty but whose legacy tree is not.
      walkDependencyTree(tree, direct, warnings, dependencies, 0, '');
    }
  } else if (tree !== null) {
    dependencies = [];
    walkDependencyTree(tree, direct, warnings, dependencies, 0, '');
  } else {
    dependencies = [];
    warnings.push(`${absolute} contains neither a "packages" map nor a "dependencies" tree`);
  }

  return {
    format,
    path: absolute,
    dependencies: finalizeDependencies(dependencies),
    warnings,
  };
}
