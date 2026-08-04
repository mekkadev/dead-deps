/**
 * The codemod: turning a report into an action.
 *
 * This is the only module in dead-deps that writes to files the user did not
 * ask us to create, which makes it the highest-risk thing in the project. The
 * governing rule is that a refusal is always cheaper than a bad edit. A fix
 * that does not happen costs the user five minutes with an editor; a fix that
 * happens wrongly costs them a debugging session, and their trust. So every
 * ambiguity in this file resolves the same way: put the package in `skipped`
 * with a sentence explaining why, and change nothing.
 *
 * What that means in practice:
 *
 *   - **Only mechanical successions.** A curated row qualifies only when it is
 *     a `rename` or a `reimplementation`, to a package, marked `dropIn`, at
 *     `high` confidence. `rollup-plugin-commonjs` moving to
 *     `@rollup/plugin-commonjs` is the shape this exists for. A fork, a
 *     replacement, or anything needing judgement is refused by construction.
 *   - **All or nothing per package.** If a project mentions the package
 *     anywhere this codemod cannot rewrite — a subpath import, a `jest.mock`,
 *     a `declare module`, a bundler `external` list — the whole finding is
 *     refused. Half a migration is worse than none, because it looks finished.
 *   - **Textual edits, never reformatting.** `package.json` is edited by
 *     replacing the dependency key in place, so indentation, key order,
 *     comments-by-convention and the trailing newline all survive untouched.
 *     A `JSON.parse` / `JSON.stringify` round-trip would produce a diff nobody
 *     asked for.
 *   - **Never a lockfile.** Lockfiles are generated, and a hand-edited one is
 *     a landmine. The user reinstalls; see `REINSTALL_NOTICE`.
 *   - **`planFixes` is pure.** It reads, it decides, it returns. `applyFixes`
 *     is the only function here that writes, and it writes exactly the bytes
 *     the plan carries — re-verifying first that every file is still byte-for
 *     -byte what the plan was built from.
 */

import { readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { MANIFEST_FIELDS, isValidPackageName } from './lockfile/manifest.js';
import type { Finding, ScanResult, SuccessorRecord } from './types.js';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/**
 * One package swap in one file.
 *
 * `before` and `after` are the **whole file**, not a fragment. That is what
 * lets `applyFixes` refuse to write when the file has moved underneath the
 * plan, and what lets a caller render a real diff without re-deriving
 * anything. When several packages are swapped in the same file the edits
 * chain: each one's `before` is the previous one's `after`, so the file's
 * final state is the last edit's `after`.
 */
export interface FixEdit {
  /** Absolute path. */
  file: string;
  /** Package name being replaced. */
  from: string;
  /** Package name replacing it. */
  to: string;
  kind: 'manifest' | 'import';
  before: string;
  after: string;
}

export interface FixPlan {
  edits: FixEdit[];
  /** Every finding that was not fixed, and the reason it was not. */
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * The sentence a caller must show after applying a plan.
 *
 * Renaming a dependency key invalidates the lockfile, and this codemod will
 * not touch one: a hand-edited lockfile is worse than a stale one, because it
 * can pin a tree that no resolver would ever produce.
 */
export const REINSTALL_NOTICE =
  'Lockfiles were not touched. Run your package manager\'s install to resolve the new ' +
  'names, and check the version range that was carried over: a renamed package often ' +
  'continues a different version line than the one it replaced.';

// ---------------------------------------------------------------------------
// Walking the project
// ---------------------------------------------------------------------------

/** Files whose module specifiers this codemod understands. */
const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** Directories that hold somebody else's code, or a build of ours. */
const SKIP_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', 'dist', 'build']);

/**
 * Never written, at any point, for any reason. Checked again in `applyFixes`
 * rather than only where the plan is built, because the plan is a plain object
 * that a caller could have assembled or edited themselves.
 */
const LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'shrinkwrap.yaml',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
]);

/**
 * Files above this are build output that landed outside `dist/`, not hand
 * written source. Reading a hundred megabyte bundle to look for an import
 * would cost more than the fix is worth.
 */
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

/** Guards against a pathologically deep tree; no real project comes close. */
const MAX_WALK_DEPTH = 24;

const READ_CONCURRENCY = 32;

function hasSourceExtension(file: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension));
}

interface ProjectTree {
  /** Files whose imports may need rewriting, sorted. */
  sources: string[];
  /**
   * `package.json` files below the root, sorted.
   *
   * Collected so a workspace can be refused rather than half-migrated: if
   * `packages/api/package.json` also declares the dead package, rewriting the
   * imports in `packages/api/src` while leaving that manifest alone would
   * break exactly the package the fix was meant to help.
   */
  nestedManifests: string[];
}

/**
 * Walk `dir`, excluding vendored and generated trees.
 *
 * Dotted *directories* are skipped — `.git`, `.next`, `.yarn` — but dotted
 * *files* are not: `.eslintrc.js` and `.babelrc.cjs` require packages like any
 * other module, and leaving them behind would be exactly the half-migration
 * this file exists to avoid. Symlinks are not followed: `isDirectory()` on a
 * `Dirent` is false for a symlink, so a link loop cannot be walked into.
 */
async function collectProjectTree(dir: string): Promise<ProjectTree> {
  const sources: string[] = [];
  const nestedManifests: string[] = [];

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH) return;

    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      // An unreadable directory holds nothing we can fix; a permissions
      // problem in one corner must not sink the whole plan.
      return;
    }

    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === 'package.json' && depth > 0) {
        nestedManifests.push(full);
        continue;
      }
      if (!hasSourceExtension(entry.name)) continue;
      sources.push(full);
    }
  }

  await walk(dir, 0);
  return { sources: sources.sort(), nestedManifests: nestedManifests.sort() };
}

async function readSourceFile(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_SOURCE_BYTES) return null;
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<R | undefined>> {
  const out: Array<R | undefined> = new Array<R | undefined>(items.length).fill(undefined);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      out[index] = await fn(item);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// Lexing just enough JavaScript
// ---------------------------------------------------------------------------

/**
 * Why there is a lexer here at all.
 *
 * The brief is "match only exact module specifiers, never a substring of a
 * longer name, and never inside a string that merely mentions the package".
 * The last clause is the one a regular expression cannot honour: `const help =
 * "import x from 'koa-router'"` and a real import are the same characters, and
 * only the surrounding syntax tells them apart. So the file is lexed far enough
 * to know what is a string literal, what is a comment, and what is code — and
 * then a candidate is accepted only when the token immediately before it is
 * `from`, `import`, `import(`, `require(` or `require.resolve(`.
 *
 * This is a lexer, not a parser: it knows nothing about statements. Two known
 * limits follow, and both are handled by refusing rather than guessing. JSX
 * prose that happens to read like an import statement would be rewritten (see
 * `specifierContext`); and any mention of the package this lexer classifies as
 * "a string literal that is not a specifier" causes the whole finding to be
 * refused, which is what catches `jest.mock`, `declare module`, bundler
 * `external` arrays and everything else in that family.
 */
interface StringLiteral {
  /** Index of the opening quote. */
  start: number;
  /** Index one past the closing quote. */
  end: number;
  /** Characters between the quotes, exactly as written. */
  raw: string;
}

interface LexResult {
  literals: StringLiteral[];
  /**
   * The file with every comment, string literal and template-literal text run
   * replaced by spaces. Looking backwards through this is how a token is found
   * without tripping over the contents of the thing being classified.
   *
   * Held as an array of UTF-16 code units rather than a string, so masking is
   * in place and every index lines up with an index into the original text.
   * Splitting by code point instead would shift every offset after the first
   * emoji in a comment.
   */
  masked: string[];
}

const IDENT = /[A-Za-z0-9_$]/;

function isIdentChar(char: string | undefined): boolean {
  return char !== undefined && IDENT.test(char);
}

function isSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v';
}

/** Last non-whitespace character before `before`, in the masked text. */
function lastCodeChar(masked: readonly string[], before: number): { char: string; index: number } | null {
  for (let k = before - 1; k >= 0; k -= 1) {
    const char = masked[k];
    if (char === undefined) return null;
    if (isSpace(char)) continue;
    return { char, index: k };
  }
  return null;
}

/** The maximal identifier run ending at `endExclusive`. */
function wordBefore(masked: readonly string[], endExclusive: number): string {
  let k = endExclusive;
  while (k > 0 && isIdentChar(masked[k - 1])) k -= 1;
  return masked.slice(k, endExclusive).join('');
}

/**
 * Keywords after which a `/` begins a regular expression rather than a
 * division. Everything else that ends an expression — an identifier, a number,
 * `)`, `]` — means division.
 */
const REGEX_AFTER_KEYWORD: ReadonlySet<string> = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

function regexCanStartHere(masked: readonly string[], at: number): boolean {
  const previous = lastCodeChar(masked, at);
  if (previous === null) return true;
  if (previous.char === ')' || previous.char === ']') return false;
  if (isIdentChar(previous.char)) {
    const word = wordBefore(masked, previous.index + 1);
    if (/^\d/.test(word)) return false;
    return REGEX_AFTER_KEYWORD.has(word);
  }
  return true;
}

/**
 * End of a regular expression literal starting at `start`, or `null`.
 *
 * A literal that does not close on its own line is treated as "not a regular
 * expression", which bounds the damage of the heuristic above to one line: the
 * `/` is read as a division operator instead and lexing carries on in step.
 */
function scanRegexLiteral(text: string, start: number): number | null {
  let k = start + 1;
  let inClass = false;

  while (k < text.length) {
    const char = text[k];
    if (char === undefined) return null;
    if (char === '\\') {
      k += 2;
      continue;
    }
    if (char === '\n' || char === '\r') return null;
    if (inClass) {
      if (char === ']') inClass = false;
      k += 1;
      continue;
    }
    if (char === '[') {
      inClass = true;
      k += 1;
      continue;
    }
    if (char === '/') {
      k += 1;
      while (k < text.length && isIdentChar(text[k])) k += 1;
      return k;
    }
    k += 1;
  }
  return null;
}

/**
 * Lex a module, or return `null` when it cannot be lexed with confidence.
 *
 * `null` means an unterminated string, template or block comment — a file that
 * does not compile, or one this lexer has lost its place in. Callers treat that
 * as a reason to refuse the fix, never as "no matches found".
 */
function lex(text: string): LexResult | null {
  const n = text.length;
  // `split('')` and not `[...text]`: the latter iterates code points, which
  // would desynchronise every index after an astral character.
  const chars = text.split('');
  const literals: StringLiteral[] = [];

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k += 1) chars[k] = ' ';
  };

  let i = 0;

  if (text.startsWith('#!')) {
    const newline = text.indexOf('\n');
    const stop = newline === -1 ? n : newline;
    blank(0, stop);
    i = stop;
  }

  const templates: Array<{ start: number; hasSubstitution: boolean; savedBraceDepth: number }> = [];
  let braceDepth = 0;
  let inTemplateText = false;

  while (i < n) {
    const char = text[i];
    if (char === undefined) break;

    if (inTemplateText) {
      const frame = templates[templates.length - 1];
      if (frame === undefined) return null;

      if (char === '\\') {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (char === '`') {
        templates.pop();
        // A template with no `${}` is a perfectly good module specifier:
        // `require(`koa-router`)` is legal, and missing it would leave the
        // project half-migrated.
        if (!frame.hasSubstitution) {
          literals.push({ start: frame.start, end: i + 1, raw: text.slice(frame.start + 1, i) });
        }
        blank(i, i + 1);
        braceDepth = frame.savedBraceDepth;
        inTemplateText = false;
        i += 1;
        continue;
      }
      if (char === '$' && text[i + 1] === '{') {
        frame.hasSubstitution = true;
        blank(i, i + 2);
        inTemplateText = false;
        braceDepth = 0;
        i += 2;
        continue;
      }
      blank(i, i + 1);
      i += 1;
      continue;
    }

    if (char === '/') {
      const next = text[i + 1];
      if (next === '/') {
        const newline = text.indexOf('\n', i);
        const stop = newline === -1 ? n : newline;
        blank(i, stop);
        i = stop;
        continue;
      }
      if (next === '*') {
        const close = text.indexOf('*/', i + 2);
        if (close === -1) return null;
        blank(i, close + 2);
        i = close + 2;
        continue;
      }
      if (regexCanStartHere(chars, i)) {
        const end = scanRegexLiteral(text, i);
        if (end !== null) {
          blank(i, end);
          i = end;
          continue;
        }
      }
      i += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      let k = i + 1;
      let closed = false;
      while (k < n) {
        const inner = text[k];
        if (inner === undefined) break;
        if (inner === '\\') {
          // Covers `\'` and the line continuation `\` + newline alike.
          k += 2;
          continue;
        }
        if (inner === char) {
          closed = true;
          break;
        }
        if (inner === '\n') break;
        k += 1;
      }
      if (!closed) return null;
      literals.push({ start: i, end: k + 1, raw: text.slice(i + 1, k) });
      blank(i, k + 1);
      i = k + 1;
      continue;
    }

    if (char === '`') {
      templates.push({ start: i, hasSubstitution: false, savedBraceDepth: braceDepth });
      blank(i, i + 1);
      inTemplateText = true;
      i += 1;
      continue;
    }

    if (char === '{') {
      braceDepth += 1;
      i += 1;
      continue;
    }
    if (char === '}') {
      if (braceDepth === 0 && templates.length > 0) {
        // Closing a `${}`: back into the template's text run.
        blank(i, i + 1);
        inTemplateText = true;
        i += 1;
        continue;
      }
      if (braceDepth > 0) braceDepth -= 1;
      i += 1;
      continue;
    }

    i += 1;
  }

  if (inTemplateText || templates.length > 0) return null;
  return { literals, masked: chars };
}

type SpecifierContext = 'from' | 'import' | 'import-call' | 'require' | 'require-resolve';

/**
 * Classify what sits immediately before a string literal.
 *
 * Deliberately narrow. `Array.from('x')` reaches this with `(` before the
 * literal and `from` before that, and is rejected because the callee is not
 * `import` or `require`. `{ from: 'x' }` is rejected because the preceding
 * character is a colon. Only the five real module-specifier positions return
 * non-null.
 *
 * The one false positive this cannot see is JSX prose — literally the text
 * `import x from 'pkg'` rendered inside a JSX element — because at the lexical
 * level it is indistinguishable from the statement. It needs a package rename
 * to be documented inside JSX body text to bite, which has not been observed
 * in the wild.
 */
function specifierContext(masked: readonly string[], quoteStart: number): SpecifierContext | null {
  const previous = lastCodeChar(masked, quoteStart);
  if (previous === null) return null;

  if (previous.char === '(') {
    const callee = lastCodeChar(masked, previous.index);
    if (callee === null || !isIdentChar(callee.char)) return null;
    const word = wordBefore(masked, callee.index + 1);
    if (word === 'import') return 'import-call';
    if (word === 'require') return 'require';
    if (word === 'resolve') {
      const dot = lastCodeChar(masked, callee.index + 1 - word.length);
      if (dot === null || dot.char !== '.') return null;
      const owner = lastCodeChar(masked, dot.index);
      if (owner === null || !isIdentChar(owner.char)) return null;
      return wordBefore(masked, owner.index + 1) === 'require' ? 'require-resolve' : null;
    }
    return null;
  }

  if (isIdentChar(previous.char)) {
    const word = wordBefore(masked, previous.index + 1);
    if (word === 'from') return 'from';
    if (word === 'import') return 'import';
  }
  return null;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let k = 0; k < index && k < text.length; k += 1) {
    if (text[k] === '\n') line += 1;
  }
  return line;
}

interface SourceScan {
  /** Rewritten file, or `null` when the package is not imported here. */
  text: string | null;
  /**
   * A mention this codemod will not rewrite: a subpath specifier, or the bare
   * name in a string that is not an import. Its presence refuses the finding.
   */
  blocker: { raw: string; line: number; kind: 'subpath' | 'mention' } | null;
}

/**
 * Rewrite every exact import of `from` in one file.
 *
 * Returns `null` when the file cannot be lexed. A subpath specifier
 * (`koa-router/lib/router`) is reported as a blocker rather than rewritten:
 * the successor's internal layout is not guaranteed to match, and inventing a
 * path is exactly the kind of guess this module does not make.
 */
function rewriteSource(text: string, from: string, to: string): SourceScan | null {
  const lexed = lex(text);
  if (lexed === null) return null;

  const prefix = `${from}/`;
  const replacements: StringLiteral[] = [];
  let blocker: SourceScan['blocker'] = null;

  for (const literal of lexed.literals) {
    const isExact = literal.raw === from;
    const isSubpath = literal.raw.startsWith(prefix);
    if (!isExact && !isSubpath) continue;

    const context = specifierContext(lexed.masked, literal.start);
    if (isExact && context !== null) {
      replacements.push(literal);
      continue;
    }
    if (blocker === null) {
      blocker = {
        raw: literal.raw,
        line: lineOf(text, literal.start),
        kind: isSubpath ? 'subpath' : 'mention',
      };
    }
  }

  if (blocker !== null) return { text: null, blocker };
  if (replacements.length === 0) return { text: null, blocker: null };

  let out = text;
  for (let k = replacements.length - 1; k >= 0; k -= 1) {
    const literal = replacements[k];
    if (literal === undefined) continue;
    // Splice the name only; the quote characters the author chose stay put.
    out = `${out.slice(0, literal.start + 1)}${to}${out.slice(literal.end - 1)}`;
  }
  return { text: out, blocker: null };
}

// ---------------------------------------------------------------------------
// Editing package.json without reformatting it
// ---------------------------------------------------------------------------

interface JsonMember {
  key: string;
  /** Index of the key's opening quote. */
  keyStart: number;
  /** Index one past the key's closing quote. */
  keyEnd: number;
  valueStart: number;
  valueEnd: number;
}

function skipJsonSpace(text: string, index: number): number {
  let k = index;
  for (;;) {
    const char = text[k];
    if (char === undefined) return k;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') k += 1;
    else return k;
  }
}

function readJsonString(text: string, index: number): number | null {
  if (text[index] !== '"') return null;
  let k = index + 1;
  while (k < text.length) {
    const char = text[k];
    if (char === undefined) return null;
    if (char === '\\') {
      k += 2;
      continue;
    }
    if (char === '"') return k + 1;
    k += 1;
  }
  return null;
}

function readJsonValue(text: string, index: number): number | null {
  const char = text[index];
  if (char === undefined) return null;
  if (char === '"') return readJsonString(text, index);

  if (char === '{' || char === '[') {
    let k = index;
    let depth = 0;
    while (k < text.length) {
      const inner = text[k];
      if (inner === undefined) return null;
      if (inner === '"') {
        const end = readJsonString(text, k);
        if (end === null) return null;
        k = end;
        continue;
      }
      if (inner === '{' || inner === '[') depth += 1;
      else if (inner === '}' || inner === ']') {
        depth -= 1;
        if (depth === 0) return k + 1;
      }
      k += 1;
    }
    return null;
  }

  let k = index;
  while (k < text.length) {
    const inner = text[k];
    if (inner === undefined) break;
    if (inner === ',' || inner === '}' || inner === ']') break;
    if (inner === ' ' || inner === '\t' || inner === '\n' || inner === '\r') break;
    k += 1;
  }
  return k === index ? null : k;
}

/**
 * Direct members of the JSON object opening at `open`, with the source span of
 * every key and value.
 *
 * Spans are the whole point: they are what allows a key to be replaced without
 * disturbing a single other byte of the file. Returns `null` for anything this
 * scanner does not recognise, which the caller treats as "do not touch this
 * file".
 */
function scanJsonObject(text: string, open: number): JsonMember[] | null {
  if (text[open] !== '{') return null;

  const members: JsonMember[] = [];
  let i = skipJsonSpace(text, open + 1);
  if (text[i] === '}') return members;

  for (;;) {
    const keyStart = i;
    const keyEnd = readJsonString(text, i);
    if (keyEnd === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(keyStart, keyEnd));
    } catch {
      return null;
    }
    if (typeof parsed !== 'string') return null;

    i = skipJsonSpace(text, keyEnd);
    if (text[i] !== ':') return null;
    i = skipJsonSpace(text, i + 1);

    const valueStart = i;
    const valueEnd = readJsonValue(text, i);
    if (valueEnd === null) return null;
    members.push({ key: parsed, keyStart, keyEnd, valueStart, valueEnd });

    i = skipJsonSpace(text, valueEnd);
    if (text[i] === ',') {
      i = skipJsonSpace(text, i + 1);
      continue;
    }
    if (text[i] === '}') return members;
    return null;
  }
}

const DEPENDENCY_FIELDS: readonly string[] = MANIFEST_FIELDS.map(([field]) => field);

/**
 * A version range whose operator survives a rename.
 *
 * The range itself is carried over verbatim — which is what preserves the
 * operator — because there is no way to know the successor's version line
 * without a network round trip, and `planFixes` does not make one. A range that
 * turns out not to resolve fails loudly at install time, which is the right
 * failure: widening it to `*` to make the install succeed would silently pull a
 * major version nobody chose.
 *
 * Anything that is not a single plain comparator is refused outright: a git
 * URL, an `npm:` alias, `workspace:*`, a union like `^1 || ^2`. Those carry
 * meaning tied to the old package that cannot be transplanted.
 */
const PLAIN_RANGE = /^(?:\^|~|>=|<=|>|<|=)?\s?v?\d+(?:\.(?:\d+|[xX*]))*(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const WILDCARD_SPECS: ReadonlySet<string> = new Set(['', '*', 'x', 'X', 'latest']);

function isTransplantableRange(spec: string): boolean {
  const trimmed = spec.trim();
  return WILDCARD_SPECS.has(trimmed) || PLAIN_RANGE.test(trimmed);
}

type ManifestOutcome = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Whether a manifest declares `name` in any of its dependency blocks.
 *
 * Used on *other* packages' manifests, where the answer only ever decides
 * whether to refuse. A manifest this scanner cannot read therefore counts as
 * declaring the package whenever the name appears in it at all: guessing "no"
 * about a file we could not parse is the one guess that could break a build.
 */
function declaresDependency(text: string, name: string): boolean {
  const root = scanJsonObject(text, skipJsonSpace(text, text.charCodeAt(0) === 0xfeff ? 1 : 0));
  if (root === null) return text.includes(JSON.stringify(name));

  for (const field of DEPENDENCY_FIELDS) {
    const block = root.find((member) => member.key === field);
    if (block === undefined || text[block.valueStart] !== '{') continue;
    const entries = scanJsonObject(text, block.valueStart);
    if (entries === null) {
      if (text.includes(JSON.stringify(name))) return true;
      continue;
    }
    if (entries.some((entry) => entry.key === name)) return true;
  }
  return false;
}

/**
 * Rewrite the dependency key `from` to `to` everywhere the four dependency
 * blocks declare it.
 *
 * All four blocks are rewritten in one pass, because a plugin legitimately
 * declaring a package as both a peer and a dev dependency must not end up half
 * renamed. Two declarations of the same name inside one block, or a manifest
 * that already declares `to`, are refused: both would produce a duplicate key,
 * and resolving that is a judgement call.
 */
function rewriteManifest(text: string, from: string, to: string): ManifestOutcome {
  const start = skipJsonSpace(text, text.charCodeAt(0) === 0xfeff ? 1 : 0);
  const root = scanJsonObject(text, start);
  if (root === null) {
    return { ok: false, reason: 'package.json could not be read as a plain JSON object, so it was left alone' };
  }

  const spans: Array<{ start: number; end: number }> = [];

  for (const field of DEPENDENCY_FIELDS) {
    const block = root.find((member) => member.key === field);
    if (block === undefined) continue;
    // `"dependencies": null` and friends declare nothing; that is not an error.
    if (text[block.valueStart] !== '{') continue;

    const entries = scanJsonObject(text, block.valueStart);
    if (entries === null) {
      return { ok: false, reason: `the "${field}" block of package.json could not be read, so it was left alone` };
    }

    const matches = entries.filter((entry) => entry.key === from);
    if (matches.length > 1) {
      return { ok: false, reason: `package.json declares it ${matches.length} times under "${field}"` };
    }
    if (entries.some((entry) => entry.key === to)) {
      return {
        ok: false,
        reason: `package.json already depends on ${to} under "${field}"; merge the two entries by hand first`,
      };
    }

    const match = matches[0];
    if (match === undefined) continue;

    let spec: unknown;
    try {
      spec = JSON.parse(text.slice(match.valueStart, match.valueEnd));
    } catch {
      spec = null;
    }
    if (typeof spec !== 'string') {
      return { ok: false, reason: `its "${field}" entry in package.json is not a version string` };
    }
    if (!isTransplantableRange(spec)) {
      return {
        ok: false,
        reason: `its version range "${spec}" is not a plain semver range, so it cannot be carried across the rename`,
      };
    }

    spans.push({ start: match.keyStart, end: match.keyEnd });
  }

  if (spans.length === 0) {
    return { ok: false, reason: 'package.json in the target directory does not declare it, so there is no key to rewrite' };
  }

  spans.sort((a, b) => a.start - b.start);
  let out = text;
  for (let k = spans.length - 1; k >= 0; k -= 1) {
    const span = spans[k];
    if (span === undefined) continue;
    out = `${out.slice(0, span.start)}${JSON.stringify(to)}${out.slice(span.end)}`;
  }
  return { ok: true, text: out };
}

// ---------------------------------------------------------------------------
// Deciding what is safe to fix
// ---------------------------------------------------------------------------

/**
 * The gate. Returns the reason a finding must not be auto-fixed, or `null` when
 * it passes every test.
 *
 * The four conditions in the brief — `toKind === 'package'`, `dropIn`, a
 * `rename` or `reimplementation`, `high` confidence — are each checked
 * separately so the refusal says which one failed. A fork like `faker` to
 * `@faker-js/faker` is drop-in and high confidence and is still refused,
 * because a fork is a change of maintainer as well as of name and that is a
 * decision the user makes, not this file.
 */
function refuseFinding(finding: Finding): string | null {
  const record: SuccessorRecord | null = finding.successor;
  const name = finding.dependency.name;

  if (record === null) {
    return 'no curated successor is recorded for it, so there is nothing to rewrite it to';
  }

  if (record.toKind !== 'package' || record.to === null) {
    if (record.toKind === 'platform' && record.to !== null) {
      return `the capability moved into the platform (${record.to}); delete the dependency and its imports by hand`;
    }
    if (record.toKind === 'bundled' && record.to !== null) {
      return `${record.to} now carries this itself; delete the dependency by hand, there is nothing to install`;
    }
    return 'nothing credible succeeded it, so there is no package to swap in';
  }

  if (!record.dropIn) {
    return `${record.to} is not recorded as a drop-in replacement, so the swap needs a human`;
  }
  if (record.type !== 'rename' && record.type !== 'reimplementation') {
    return `the succession is recorded as "${record.type}", not a rename, so the swap needs a human`;
  }
  if (record.confidence !== 'high') {
    return `the curated record is only ${record.confidence} confidence`;
  }
  if (!isValidPackageName(record.to)) {
    return `the recorded successor "${record.to}" is not a usable package name`;
  }
  if (record.to.toLowerCase() === name.toLowerCase()) {
    return 'the recorded successor is the package itself';
  }
  if (!finding.dependency.direct) {
    return 'it is a transitive dependency: nothing here declares it, so the rename belongs to whichever package does';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message === '' ? error.name : error.message;
  return String(error);
}

function display(root: string, file: string): string {
  const rel = relative(root, file);
  return rel === '' || rel.startsWith('..') ? file : rel;
}

/**
 * Work out every edit that would turn `result` into an action, and change
 * nothing.
 *
 * `dir` is the project root: its `package.json` is the manifest that gets
 * rewritten, and the tree beneath it is what gets scanned for imports. Only
 * findings that clear `refuseFinding` are considered, and each of those is
 * still all-or-nothing — a single unrewritable mention anywhere in the project
 * refuses the whole package.
 *
 * Throws only when `dir` cannot serve as a project root. Everything else — a
 * missing manifest, an unparseable file, a package declared twice — is a
 * `skipped` entry, because a plan that explains itself is more useful than an
 * exception.
 */
export async function planFixes(result: ScanResult, dir: string): Promise<FixPlan> {
  const root = resolve(dir);
  const edits: FixEdit[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  let info;
  try {
    info = await stat(root);
  } catch (error) {
    throw new Error(`Cannot plan fixes for ${root}: ${describeError(error)}`, { cause: error });
  }
  if (!info.isDirectory()) {
    throw new Error(`Cannot plan fixes for ${root}: it is not a directory.`);
  }

  const candidates: Array<{ finding: Finding; to: string }> = [];
  for (const finding of result.findings) {
    const reason = refuseFinding(finding);
    if (reason !== null) {
      skipped.push({ name: finding.dependency.name, reason });
      continue;
    }
    // `refuseFinding` returning null guarantees a package successor with a
    // usable name; re-reading it here is what carries that past the compiler
    // without an assertion that could outlive the guarantee.
    const to = finding.successor?.to;
    if (to === undefined || to === null || to === '') continue;
    candidates.push({ finding, to });
  }

  if (candidates.length === 0) return { edits, skipped };

  const manifestPath = join(root, 'package.json');
  let manifestText: string;
  try {
    manifestText = await readFile(manifestPath, 'utf8');
  } catch (error) {
    const detail = describeError(error);
    for (const candidate of candidates) {
      skipped.push({
        name: candidate.finding.dependency.name,
        reason: `${display(root, manifestPath)} could not be read (${detail}), so no dependency key could be rewritten`,
      });
    }
    return { edits, skipped };
  }

  // One read of the tree, shared by every candidate. Files that mention none of
  // the names are dropped straight away so the plan holds only what it needs.
  const names = candidates.map((candidate) => candidate.finding.dependency.name);
  const tree = await collectProjectTree(root);
  const contents = await mapLimit(tree.sources, READ_CONCURRENCY, readSourceFile);

  const current = new Map<string, string>([[manifestPath, manifestText]]);
  const sourceFiles: string[] = [];
  tree.sources.forEach((file, index) => {
    const text = contents[index];
    if (text === undefined || text === null) return;
    if (!names.some((name) => text.includes(name))) return;
    sourceFiles.push(file);
    current.set(file, text);
  });

  const nested = await mapLimit(tree.nestedManifests, READ_CONCURRENCY, readSourceFile);

  for (const { finding, to } of candidates) {
    const from = finding.dependency.name;

    const manifestNow = current.get(manifestPath);
    if (manifestNow === undefined) continue;

    const manifest = rewriteManifest(manifestNow, from, to);
    if (!manifest.ok) {
      skipped.push({ name: from, reason: manifest.reason });
      continue;
    }

    let refusal: string | null = null;

    // A workspace member that declares the package too. Only the root manifest
    // is ever rewritten, so renaming imports underneath one of these would
    // leave that package importing something it does not depend on.
    for (let index = 0; index < tree.nestedManifests.length; index += 1) {
      const file = tree.nestedManifests[index];
      if (file === undefined) continue;
      const text = nested[index];
      if (text === undefined || text === null) {
        refusal =
          `${display(root, file)} could not be read, so there is no telling whether it declares ` +
          'the package too';
        break;
      }
      if (declaresDependency(text, from)) {
        refusal =
          `${display(root, file)} declares it as well, and only the root manifest is rewritten; ` +
          'rename it there first, or fix that package on its own';
        break;
      }
    }

    if (refusal !== null) {
      skipped.push({ name: from, reason: refusal });
      continue;
    }

    const sourceEdits: Array<{ file: string; before: string; after: string }> = [];

    for (const file of sourceFiles) {
      const before = current.get(file);
      if (before === undefined || !before.includes(from)) continue;

      const scanned = rewriteSource(before, from, to);
      if (scanned === null) {
        refusal =
          `${display(root, file)} mentions it but could not be parsed as JavaScript, ` +
          'so its imports could not be checked';
        break;
      }
      if (scanned.blocker !== null) {
        const where = `${display(root, file)}:${scanned.blocker.line}`;
        refusal =
          scanned.blocker.kind === 'subpath'
            ? `${where} imports "${scanned.blocker.raw}", and the successor is not guaranteed to lay its ` +
              'subpaths out the same way; a partial rename would leave the project half-migrated'
            : `${where} names "${scanned.blocker.raw}" somewhere that is not an import — a mock, a module ` +
              'declaration, a bundler config — which this codemod will not rewrite; a partial rename would ' +
              'leave the project half-migrated';
        break;
      }
      if (scanned.text !== null) sourceEdits.push({ file, before, after: scanned.text });
    }

    if (refusal !== null) {
      skipped.push({ name: from, reason: refusal });
      continue;
    }

    // Commit: the manifest first, then the sources in path order.
    edits.push({ file: manifestPath, from, to, kind: 'manifest', before: manifestNow, after: manifest.text });
    current.set(manifestPath, manifest.text);
    for (const edit of sourceEdits) {
      edits.push({ file: edit.file, from, to, kind: 'import', before: edit.before, after: edit.after });
      current.set(edit.file, edit.after);
    }
  }

  return { edits, skipped };
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/**
 * Write through a temporary file in the same directory, then rename over the
 * target, so a crash mid-write cannot leave a truncated source file behind.
 * The original's permission bits are carried over; a rename does not preserve
 * them on its own.
 */
async function writeAtomic(file: string, content: string): Promise<void> {
  let mode: number | undefined;
  try {
    mode = (await stat(file)).mode & 0o777;
  } catch {
    mode = undefined;
  }

  const suffix = `${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const temp = join(dirname(file), `.${basename(file)}.dead-deps-${suffix}.tmp`);

  try {
    await writeFile(temp, content, mode === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', mode });
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/**
 * Write a plan to disk and return the files that changed.
 *
 * Everything is verified before anything is written. Each file must still be
 * byte-for-byte the `before` its first edit was built from — if it is not, the
 * user or another tool has touched it since planning, and applying a stale
 * `after` would silently discard their work, so nothing is written and the
 * error names the file. The edits for a file must also chain, which catches a
 * plan that was assembled or filtered by hand into an inconsistent state.
 *
 * Lockfiles are rejected here as well as never being planned: the plan is a
 * plain object, and this is the last place to stop one.
 */
export async function applyFixes(plan: FixPlan): Promise<string[]> {
  const byFile = new Map<string, FixEdit[]>();
  for (const edit of plan.edits) {
    const bucket = byFile.get(edit.file);
    if (bucket === undefined) byFile.set(edit.file, [edit]);
    else bucket.push(edit);
  }
  if (byFile.size === 0) return [];

  const targets: Array<{ file: string; content: string }> = [];

  for (const [file, list] of byFile) {
    const name = basename(file);
    if (LOCKFILE_NAMES.has(name)) {
      throw new Error(
        `Refusing to edit ${file}: dead-deps never writes lockfiles. ${REINSTALL_NOTICE}`,
      );
    }

    const first = list[0];
    const last = list[list.length - 1];
    if (first === undefined || last === undefined) continue;

    for (const edit of list) {
      const expected = edit.kind === 'manifest' ? name === 'package.json' : hasSourceExtension(name);
      if (!expected) {
        throw new Error(`Refusing to edit ${file}: it is not a ${edit.kind} file dead-deps knows how to write.`);
      }
    }

    for (let k = 1; k < list.length; k += 1) {
      const previous = list[k - 1];
      const next = list[k];
      if (previous === undefined || next === undefined) continue;
      if (next.before !== previous.after) {
        throw new Error(
          `Refusing to apply: the edits for ${file} do not chain (the ${next.from} edit was built ` +
            'from different content than the one before it left behind). Re-run the plan. Nothing was written.',
        );
      }
    }

    let disk: string;
    try {
      disk = await readFile(file, 'utf8');
    } catch (error) {
      throw new Error(`Cannot read ${file} to apply the plan: ${describeError(error)}. Nothing was written.`, {
        cause: error,
      });
    }
    if (disk !== first.before) {
      throw new Error(
        `${file} has changed since the plan was made. Re-run the scan and plan again. Nothing was written.`,
      );
    }

    if (last.after !== disk) targets.push({ file, content: last.after });
  }

  const written: string[] = [];
  for (const target of targets) {
    try {
      await writeAtomic(target.file, target.content);
    } catch (error) {
      const done = written.length === 0 ? 'no files had been written yet' : `already written: ${written.join(', ')}`;
      throw new Error(`Failed to write ${target.file} (${done}): ${describeError(error)}`, { cause: error });
    }
    written.push(target.file);
  }

  return written.sort();
}
