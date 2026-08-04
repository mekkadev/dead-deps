/**
 * Lockfile discovery and dispatch.
 *
 * `detectLockfiles` answers "what does this project use?" in preference order,
 * and `parseLockfile` turns one of those files into a `ParsedLockfile`. The
 * dispatch is filename-first because filenames are unambiguous in practice, with
 * a content sniff as the fallback so that a copied or renamed file still parses.
 */

import { stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import type { ParsedLockfile } from '../types.js';
import { parseManifestFile, readTextFile } from './manifest.js';
import { parseNpmLockfile } from './npm.js';
import { parsePnpmLockfile } from './pnpm.js';
import { parseYarnLockfile } from './yarn.js';

/**
 * Most specific first. A repo with both `pnpm-lock.yaml` and a stale
 * `package-lock.json` is installed with pnpm; `package.json` is last because it
 * is only a fallback for projects with no lockfile at all.
 */
export const LOCKFILE_PREFERENCE: readonly string[] = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'package.json',
];

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * List the lockfiles present in `dir`, most preferred first.
 *
 * Passing a path to a file rather than a directory returns just that file, so
 * callers can accept either from a user without special-casing it.
 */
export async function detectLockfiles(dir: string): Promise<string[]> {
  const target = resolve(dir);

  if (await isFile(target)) return [target];

  const found: string[] = [];
  for (const name of LOCKFILE_PREFERENCE) {
    const candidate = join(target, name);
    if (await isFile(candidate)) found.push(candidate);
  }
  return found;
}

type Dialect = 'npm' | 'pnpm' | 'yarn' | 'package-json';

function dialectFromName(name: string): Dialect | null {
  switch (name) {
    case 'pnpm-lock.yaml':
    case 'pnpm-lock.yml':
      return 'pnpm';
    case 'package-lock.json':
    case 'npm-shrinkwrap.json':
      return 'npm';
    case 'yarn.lock':
      return 'yarn';
    case 'package.json':
      return 'package-json';
    default:
      return null;
  }
}

/**
 * Identify a lockfile that does not have one of the standard names — a fixture
 * copied to a temp path, a file passed with `--lockfile`, a renamed backup.
 */
function dialectFromContent(text: string): Dialect | null {
  const head = text.slice(0, 4096);

  if (/^\s*\{/.test(text)) {
    if (/"lockfileVersion"\s*:/.test(head)) return 'npm';
    if (/"(?:dependencies|devDependencies|name|version)"\s*:/.test(head)) return 'package-json';
    return null;
  }
  if (/^__metadata:/m.test(text)) return 'yarn';
  if (/^lockfileVersion:/m.test(head)) return 'pnpm';
  // Classic yarn: a column-0 descriptor line followed by an indented `version "x"`.
  if (/^ {2}version "/m.test(text)) return 'yarn';
  return null;
}

/**
 * Parse a lockfile (or a bare `package.json`) into the shared representation.
 *
 * Throws only when the file cannot be read or its top-level structure is
 * unusable. Anything smaller — an unknown key, a malformed entry, a line that
 * does not fit the grammar — is recorded in `warnings` and skipped, so one bad
 * row never costs the caller the whole file.
 */
export async function parseLockfile(path: string): Promise<ParsedLockfile> {
  const absolute = resolve(path);
  const name = basename(absolute);

  // `package.json` needs no pre-read: its parser owns the file.
  if (dialectFromName(name) === 'package-json') return parseManifestFile(absolute);

  const read = await readTextFile(absolute);
  if (!read.ok) {
    throw new Error(`cannot read ${absolute}: ${read.message}`);
  }

  const dialect = dialectFromName(name) ?? dialectFromContent(read.value);

  switch (dialect) {
    case 'npm':
      return parseNpmLockfile(absolute, read.value);
    case 'pnpm':
      return parsePnpmLockfile(absolute, read.value);
    case 'yarn':
      return parseYarnLockfile(absolute, read.value);
    case 'package-json':
      return parseManifestFile(absolute);
    default:
      throw new Error(`cannot parse ${absolute}: unrecognised lockfile format`);
  }
}

export { parseManifestFile } from './manifest.js';
export { parseNpmLockfile } from './npm.js';
export { parsePnpmLockfile } from './pnpm.js';
export { parseYarnLockfile } from './yarn.js';
