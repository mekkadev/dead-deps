/**
 * `yarn.lock`, both dialects.
 *
 * Yarn Berry (v2+) writes YAML and always carries a `__metadata` block. Yarn
 * Classic (v1) writes a bespoke two-space-indented format that looks like YAML
 * but is not — its field syntax is `version "1.2.3"` with a space instead of a
 * colon, so a YAML parser rejects it. The dialect is therefore detected from
 * the content, never guessed from a version comment (which is absent from
 * plenty of real v1 files and present in some rewritten ones).
 *
 * Neither dialect records dev/prod-ness, so scope comes entirely from the
 * sibling `package.json`.
 */

import { resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { LockfileFormat, ParsedDependency, ParsedLockfile } from '../types.js';
import {
  asRecord,
  asString,
  describeError,
  finalizeDependencies,
  isLocalReference,
  isValidPackageName,
  normaliseVersion,
  readSiblingManifest,
  toDependency,
  type DirectMap,
} from './manifest.js';

/** Descriptor protocols that point at something other than a published package. */
const SKIPPED_PROTOCOLS = ['workspace:', 'patch:', 'link:', 'portal:', 'file:', 'exec:'];

export function isBerryLockfile(text: string): boolean {
  return /^__metadata:/m.test(text);
}

export function detectYarnFormat(text: string): LockfileFormat {
  return isBerryLockfile(text) ? 'yarn-berry' : 'yarn-v1';
}

/**
 * Split `@scope/pkg@npm:^1.0.0` into its name and its range.
 *
 * The separator is the *first* `@` after index 0 — index 0 belongs to a scope.
 * Splitting on the last `@` instead would work for plain descriptors but breaks
 * on the ones that matter here: `tough-cookie@patch:tough-cookie@npm%3A2.5.0…`
 * and `foo@git+ssh://git@github.com/o/r.git` both carry a second `@` inside the
 * range, and a name is never allowed to.
 */
export function splitDescriptor(descriptor: string): { name: string; range: string } {
  const value = unquote(descriptor.trim());
  const at = value.indexOf('@', 1);
  if (at < 0) return { name: value, range: '' };
  return { name: value.slice(0, at), range: value.slice(at + 1) };
}

export function nameFromDescriptor(descriptor: string): string | null {
  const { name } = splitDescriptor(descriptor);
  return isValidPackageName(name) ? name : null;
}

function isSkippedDescriptor(descriptor: string): boolean {
  const range = splitDescriptor(descriptor).range.toLowerCase();
  return SKIPPED_PROTOCOLS.some((protocol) => range.startsWith(protocol));
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Split a key line into descriptors. Berry and Classic both allow
 * `a@^1, "b@^2"` on one line; quoted descriptors may themselves contain commas
 * in a range (`foo@">=1, <2"`), so the split respects quoting.
 */
export function splitDescriptors(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (const char of line) {
    if (quote !== null) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);

  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * The `resolution` field names the package that was actually installed, which
 * is what an alias like `foo@npm:bar@^1.0.0` hides: it resolves to
 * `foo@npm:bar@1.0.0`, and the package to assess is `bar`, not `foo`.
 */
function nameFromResolution(resolution: string | null): string | null {
  if (resolution === null) return null;

  const { name, range } = splitDescriptor(resolution);
  if (range.startsWith('npm:')) {
    const inner = range.slice('npm:'.length);
    const at = inner.indexOf('@', 1);
    if (at > 0) {
      const aliased = inner.slice(0, at);
      if (isValidPackageName(aliased)) return aliased;
    }
  }
  return isValidPackageName(name) ? name : null;
}

function parseBerry(
  absolute: string,
  text: string,
  direct: DirectMap,
  warnings: string[],
): ParsedDependency[] {
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

  const dependencies: ParsedDependency[] = [];

  for (const [keyLine, rawEntry] of Object.entries(root)) {
    if (keyLine === '__metadata') continue;

    const entry = asRecord(rawEntry);
    if (entry === null) {
      warnings.push(`entry "${keyLine}" is not a mapping; skipped`);
      continue;
    }

    const descriptors = splitDescriptors(keyLine).filter((d) => !isSkippedDescriptor(d));
    if (descriptors.length === 0) continue;

    const version = normaliseVersion(entry['version']);
    const resolution = asString(entry['resolution']);
    const names = new Set<string>();

    const resolved = nameFromResolution(resolution);
    if (resolved !== null) {
      names.add(resolved);
    } else {
      for (const descriptor of descriptors) {
        const name = nameFromDescriptor(descriptor);
        if (name !== null) names.add(name);
      }
    }

    if (names.size === 0) {
      warnings.push(`entry "${keyLine}" has no usable package name; skipped`);
      continue;
    }

    for (const name of names) {
      dependencies.push(toDependency(name, version, 'prod', direct));
    }
  }

  return dependencies;
}

/**
 * Yarn Classic, line by line.
 *
 * The grammar we care about is tiny: a block starts on a column-0 line ending
 * in `:`, and the block's own fields sit at exactly two spaces of indent. Deeper
 * indentation belongs to nested `dependencies:` maps and must be ignored, or
 * every transitive range would be mistaken for a resolved version.
 */
function parseClassic(text: string, direct: DirectMap, warnings: string[]): ParsedDependency[] {
  const dependencies: ParsedDependency[] = [];
  const lines = text.split(/\r?\n/);

  let names: string[] = [];
  let version: string | null = null;
  let resolved: string | null = null;
  let lineNumber = 0;
  let keyLineNumber = 0;

  const flush = (): void => {
    if (names.length === 0) return;
    if (version === null && resolved === null) {
      warnings.push(`line ${keyLineNumber}: entry for ${names.join(', ')} has no version; skipped`);
    } else if (!isLocalReference(resolved)) {
      for (const name of names) {
        dependencies.push(toDependency(name, version, 'prod', direct));
      }
    }
    names = [];
    version = null;
    resolved = null;
  };

  for (const rawLine of lines) {
    lineNumber += 1;
    const line = rawLine.replace(/\s+$/, '');
    if (line.length === 0) continue;

    const trimmedStart = line.replace(/^\s+/, '');
    if (trimmedStart.startsWith('#')) continue;

    const indent = line.length - trimmedStart.length;

    if (indent === 0) {
      flush();
      keyLineNumber = lineNumber;

      if (!line.endsWith(':')) {
        warnings.push(`line ${lineNumber}: expected a descriptor line ending in ":"; skipped`);
        continue;
      }

      const descriptors = splitDescriptors(line.slice(0, -1));
      const collected: string[] = [];
      let skippedProtocol = false;

      for (const descriptor of descriptors) {
        if (isSkippedDescriptor(descriptor)) {
          skippedProtocol = true;
          continue;
        }
        const name = nameFromDescriptor(descriptor);
        if (name === null) {
          warnings.push(`line ${lineNumber}: could not read a package name from "${descriptor}"; skipped`);
          continue;
        }
        if (!collected.includes(name)) collected.push(name);
      }

      if (collected.length === 0 && !skippedProtocol && descriptors.length > 0) {
        warnings.push(`line ${lineNumber}: no usable package name in "${line}"; skipped`);
      }
      names = collected;
      continue;
    }

    if (indent !== 2 || names.length === 0) continue;

    const versionMatch = /^version:?\s+(.+)$/.exec(trimmedStart);
    if (versionMatch !== null) {
      version = normaliseVersion(unquote(versionMatch[1] ?? ''));
      continue;
    }

    const resolvedMatch = /^resolved:?\s+(.+)$/.exec(trimmedStart);
    if (resolvedMatch !== null) {
      resolved = unquote(resolvedMatch[1] ?? '');
    }
  }

  flush();
  return dependencies;
}

export async function parseYarnLockfile(path: string, text: string): Promise<ParsedLockfile> {
  const absolute = resolve(path);
  const warnings: string[] = [];

  const sibling = await readSiblingManifest(absolute);
  const direct: DirectMap = sibling.direct ?? new Map();
  if (sibling.direct === null) warnings.push(...sibling.warnings);

  const format = detectYarnFormat(text);
  const dependencies =
    format === 'yarn-berry'
      ? parseBerry(absolute, text, direct, warnings)
      : parseClassic(text, direct, warnings);

  if (dependencies.length === 0) {
    warnings.push(`${absolute} yielded no dependencies`);
  }

  return {
    format,
    path: absolute,
    dependencies: finalizeDependencies(dependencies),
    warnings,
  };
}
