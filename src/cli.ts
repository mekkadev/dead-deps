#!/usr/bin/env node
/**
 * The front door.
 *
 * `npx dead-deps` is how almost everyone meets this project, so this file is
 * held to a few rules:
 *
 *   - stdout carries the report and nothing else. Progress, warnings and
 *     errors go to stderr, so `dead-deps --json > out.json` is always valid
 *     JSON and `dead-deps | less` is always the report.
 *   - Expected failures (no lockfile, unreadable path, network down) print one
 *     clear sentence and an actionable hint. Stacks appear only under
 *     DEAD_DEPS_DEBUG.
 *   - Exit codes are a contract with CI, documented in `--help`: 0 clean,
 *     1 findings, 2 usage, 3 runtime.
 *   - Defaults are read from DEFAULT_SCAN_OPTIONS rather than restated, so the
 *     help text cannot drift away from the behaviour.
 *   - `--fix` is the only path in this file that writes to the user's files,
 *     and it refuses far more often than it acts. See `guardWorkingTree`.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import { REINSTALL_NOTICE, applyFixes, planFixes } from './fix.js';
import { HISTORY_DIR, readAllSnapshots } from './history/index.js';
import { MIN_SAMPLES_FOR_TRAJECTORY, computeTrajectory, summarise } from './history/trajectory.js';
import { renderJson } from './report/json.js';
import { renderTerminal } from './report/terminal.js';
import { scan } from './scan.js';
import { DEFAULT_SCAN_OPTIONS, EXIT, STATE_SEVERITY } from './types.js';
import type { FixEdit, FixPlan } from './fix.js';
import type {
  HealthSnapshot,
  MaintenanceState,
  ScanOptions,
  ScanResult,
  Trajectory,
  TrendDirection,
} from './types.js';

type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** States a human may pass to `--min-state`, mildest first. */
const STATES: readonly MaintenanceState[] = (
  Object.keys(STATE_SEVERITY) as MaintenanceState[]
).sort((a, b) => STATE_SEVERITY[a] - STATE_SEVERITY[b]);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Something the user typed. Always exit 2, never a stack. */
class UsageError extends Error {
  readonly hint: string | null;

  constructor(message: string, hint: string | null = null) {
    super(message);
    this.name = 'UsageError';
    this.hint = hint;
  }
}

/** Walks the `cause` chain looking for an errno-style code. */
function errorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = current.cause;
  }
  return null;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause instanceof Error && cause.message !== '' && cause.message !== error.message) {
    return `${error.message} (${cause.message})`;
  }
  return error.message === '' ? error.name : error.message;
}

const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'EPROTO',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

interface Failure {
  message: string;
  hint: string | null;
  code: ExitCode;
  /** True only for failures we could not explain, where a stack would help. */
  unexplained?: boolean;
}

/**
 * Turns whatever came out of the scan into one sentence a human can act on.
 * Anything not recognised here falls through to its own message, which is
 * still better than a stack trace for the reader who just wants to know
 * whether it was them or us.
 */
function classify(error: unknown, target: string): Failure {
  if (error instanceof UsageError) {
    return { message: error.message, hint: error.hint, code: EXIT.USAGE_ERROR };
  }

  const code = errorCode(error);
  const message = errorMessage(error);

  if (code === 'ENOENT') {
    return {
      message: `no such file or directory: ${tidyPath(target)}`,
      hint: 'Pass a directory, a lockfile, or a package.json — or nothing at all to scan the current directory.',
      code: EXIT.USAGE_ERROR,
    };
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return {
      message: `permission denied reading ${tidyPath(target)}`,
      hint: 'Check the file permissions, or run the scan from a directory you own.',
      code: EXIT.RUNTIME_ERROR,
    };
  }
  if (code !== null && NETWORK_CODES.has(code)) {
    return {
      message: `cannot reach the upstream indexes (${code.toLowerCase()})`,
      hint: 'dead-deps needs network access to api.ecosyste.ms and registry.npmjs.org. Behind a proxy, set HTTPS_PROXY.',
      code: EXIT.RUNTIME_ERROR,
    };
  }
  if (/fetch failed/i.test(message)) {
    return {
      message: 'cannot reach the upstream indexes',
      hint: 'dead-deps needs network access to api.ecosyste.ms and registry.npmjs.org. Behind a proxy, set HTTPS_PROXY.',
      code: EXIT.RUNTIME_ERROR,
    };
  }
  if (/unrecognised lockfile format|unrecognized lockfile format/i.test(message)) {
    return {
      message: `${tidyPath(target)} is not a lockfile dead-deps understands`,
      hint: 'Supported: package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml, yarn.lock, and package.json as a fallback.',
      code: EXIT.RUNTIME_ERROR,
    };
  }
  if (/no lockfile|no package\.json|nothing to scan/i.test(message)) {
    // The lockfile layer already names what it looked for and where.
    return { message, hint: null, code: EXIT.RUNTIME_ERROR };
  }

  return { message, hint: null, code: EXIT.RUNTIME_ERROR, unexplained: true };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Paint = (text: string) => string;

function painter(code: string, enabled: boolean): Paint {
  if (!enabled) return (text) => text;
  return (text) => (text === '' ? '' : `\x1b[${code}m${text}\x1b[0m`);
}

function tidyPath(path: string): string {
  const home = homedir();
  if (home !== '' && home !== '/' && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

/**
 * A path as the user would type it from the project root. Anything outside the
 * root keeps its absolute form: `../../etc/hosts` is harder to read than the
 * real path, and for a file this tool has edited the real path is the point.
 */
function relativeTo(root: string, file: string): string {
  const rel = relative(root, file);
  return rel === '' || rel.startsWith('..') ? tidyPath(file) : rel;
}

function envSet(name: string): boolean {
  const value = process.env[name];
  return value !== undefined && value !== '';
}

function wrap(text: string, width: number): string[] {
  const limit = Math.max(20, width);
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    if (current === '') current = word;
    else if (current.length + 1 + word.length <= limit) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  if (text === '') return Promise.resolve();
  return new Promise((done) => {
    // The callback fires once the chunk is flushed, which is what makes it safe
    // to process.exit() immediately afterwards even when stdout is a pipe.
    stream.write(text, () => done());
  });
}

const VERSION = readVersion();

/**
 * The version comes from package.json at runtime rather than a constant, so a
 * published build can never disagree with what npm installed. `dist/cli.js` and
 * `src/cli.ts` are both exactly one directory below the manifest.
 */
function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, '..', 'package.json'), join(here, '..', '..', 'package.json')]) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) continue;
      const manifest = parsed as { name?: unknown; version?: unknown };
      if (manifest.name === 'dead-deps' && typeof manifest.version === 'string') return manifest.version;
    } catch {
      // Missing or unreadable manifest: try the next candidate.
    }
  }
  return '0.0.0-unknown';
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const OPTION_CONFIG = {
  all: { type: 'boolean' },
  limit: { type: 'string' },
  'min-state': { type: 'string' },
  json: { type: 'boolean' },
  history: { type: 'boolean' },
  fix: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  force: { type: 'boolean' },
  'no-cache': { type: 'boolean' },
  'cache-ttl': { type: 'string' },
  contact: { type: 'string' },
  concurrency: { type: 'string' },
  quiet: { type: 'boolean', short: 'q' },
  'no-color': { type: 'boolean' },
  version: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
} as const;

interface Invocation {
  target: string;
  options: ScanOptions;
  json: boolean;
  /** Show each finding's trajectory from the local snapshot archive. */
  history: boolean;
  /** Apply the safe mechanical renames. The only writing this tool does. */
  fix: boolean;
  /** With `fix`: plan and print, write nothing. */
  dryRun: boolean;
  /** With `fix`: write even over uncommitted changes. */
  force: boolean;
  /** Colour for stdout, already reconciled with --json, NO_COLOR and TTY. */
  color: boolean;
  /** Colour for stderr, decided separately: the two can be redirected apart. */
  errColor: boolean;
  help: boolean;
  version: boolean;
  /** Non-fatal complaints raised while parsing, printed unless --quiet. */
  notes: string[];
}

function isMaintenanceState(value: string): value is MaintenanceState {
  return Object.prototype.hasOwnProperty.call(STATE_SEVERITY, value);
}

function wholeNumber(raw: string, flag: string, min: number, max: number): number {
  const text = raw.trim();
  if (text === '') throw new UsageError(`${flag} expects a number, but got an empty value`);
  const value = Number(text);
  if (!Number.isInteger(value)) {
    throw new UsageError(`${flag} expects a whole number, but got "${raw}"`);
  }
  if (value < min || value > max) {
    throw new UsageError(`${flag} must be between ${min} and ${max}, but got ${value}`);
  }
  return value;
}

function decimalNumber(raw: string, flag: string, min: number, max: number): number {
  const text = raw.trim();
  if (text === '') throw new UsageError(`${flag} expects a number, but got an empty value`);
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new UsageError(`${flag} expects a number, but got "${raw}"`);
  }
  if (value < min || value > max) {
    throw new UsageError(`${flag} must be between ${min} and ${max}, but got ${value}`);
  }
  return value;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(value);
}

function parseMinState(raw: string): MaintenanceState {
  const value = raw.trim().toLowerCase();
  if (isMaintenanceState(value)) return value;
  throw new UsageError(
    `--min-state does not accept "${raw}"`,
    `Valid states, mildest first: ${STATES.join(', ')}. The default is ${DEFAULT_SCAN_OPTIONS.minState}.`,
  );
}

/** stdout colour: TTY, no NO_COLOR, TERM is not dumb, and never under --json. */
function wantsColor(stream: NodeJS.WriteStream, disabled: boolean): boolean {
  if (disabled) return false;
  if (envSet('NO_COLOR')) return false;
  if (process.env['TERM'] === 'dumb') return false;
  return stream.isTTY === true;
}

/**
 * parseArgs' own wording explains how to pass a positional beginning with a
 * dash, which is rarely what went wrong. The interesting part is the token.
 */
function describeParseFailure(error: unknown): string {
  const message = errorMessage(error);
  const token = /'(-{1,2}[^']*)'/.exec(message)?.[1]?.replace(/\s*<value>$/, '');
  switch (errorCode(error)) {
    case 'ERR_PARSE_ARGS_UNKNOWN_OPTION':
      return token === undefined ? message : `unknown option: ${token}`;
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE':
      if (token === undefined) return message;
      return /argument missing/i.test(message)
        ? `${token} needs a value`
        : `${token} does not take a value`;
    default:
      return message;
  }
}

function parseCli(argv: string[]): Invocation {
  let values: {
    all?: boolean;
    limit?: string;
    'min-state'?: string;
    json?: boolean;
    history?: boolean;
    fix?: boolean;
    'dry-run'?: boolean;
    force?: boolean;
    'no-cache'?: boolean;
    'cache-ttl'?: string;
    contact?: string;
    concurrency?: string;
    quiet?: boolean;
    'no-color'?: boolean;
    version?: boolean;
    help?: boolean;
  };
  let positionals: string[];

  try {
    const parsed = parseArgs({
      args: argv,
      options: OPTION_CONFIG,
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    throw new UsageError(describeParseFailure(error), 'Run `dead-deps --help` to see every option.');
  }

  if (positionals.length > 1) {
    const extra = positionals.slice(1).join(', ');
    throw new UsageError(
      `expected one path to scan, but got ${positionals.length} (${extra} left over)`,
      'Run it once per project, or point it at the workspace lockfile that covers them all.',
    );
  }

  const notes: string[] = [];
  const json = values.json === true;
  const quiet = values.quiet === true;
  const noColorFlag = values['no-color'] === true;
  const fix = values.fix === true;
  const dryRun = values['dry-run'] === true;
  const force = values.force === true;

  // `--dry-run` on its own would silently do nothing, which reads as a bug.
  if (dryRun && !fix) {
    throw new UsageError(
      '--dry-run has nothing to preview on its own',
      'It shows what --fix would write. Run `dead-deps --fix --dry-run`.',
    );
  }
  // `--force` is not silently ignored: a user who typed it believes it matters.
  if (force && !fix) notes.push('--force only affects --fix, and --fix was not passed');

  const contactFlag = values.contact;
  let contact: string | null = null;
  if (contactFlag !== undefined) {
    const trimmed = contactFlag.trim();
    if (!looksLikeEmail(trimmed)) {
      throw new UsageError(
        `--contact expects an email address, but got "${contactFlag}"`,
        'It is sent in the User-Agent header so ecosyste.ms can reach you; that is what buys you their polite pool.',
      );
    }
    contact = trimmed;
  } else {
    const fromEnv = (process.env['DEAD_DEPS_CONTACT'] ?? '').trim();
    if (fromEnv !== '') {
      // An unusable env var should not stop a scan that never needed it.
      if (looksLikeEmail(fromEnv)) contact = fromEnv;
      else notes.push(`ignoring DEAD_DEPS_CONTACT: "${fromEnv}" is not an email address`);
    }
  }

  const target = resolve(positionals[0] ?? '.');

  const options: ScanOptions = {
    all: values.all === true,
    limit: values.limit === undefined ? DEFAULT_SCAN_OPTIONS.limit : wholeNumber(values.limit, '--limit', 1, 10_000),
    minState: values['min-state'] === undefined ? DEFAULT_SCAN_OPTIONS.minState : parseMinState(values['min-state']),
    noCache: values['no-cache'] === true,
    cacheTtlHours:
      values['cache-ttl'] === undefined
        ? DEFAULT_SCAN_OPTIONS.cacheTtlHours
        : decimalNumber(values['cache-ttl'], '--cache-ttl', 0, 8_760),
    contact,
    concurrency:
      values.concurrency === undefined
        ? DEFAULT_SCAN_OPTIONS.concurrency
        : wholeNumber(values.concurrency, '--concurrency', 1, 64),
    quiet,
  };

  return {
    target,
    options,
    json,
    history: values.history === true,
    fix,
    dryRun,
    force,
    color: json ? false : wantsColor(process.stdout, noColorFlag),
    errColor: wantsColor(process.stderr, noColorFlag),
    help: values.help === true,
    version: values.version === true,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

interface Row {
  flags: string;
  text: string;
}

const SCOPE_ROWS: Row[] = [
  { flags: '--all', text: `include transitive dependencies (default: direct only)` },
  { flags: '--limit <n>', text: `maximum findings to show (default: ${DEFAULT_SCAN_OPTIONS.limit})` },
  {
    flags: '--min-state <state>',
    text: `minimum severity to report (default: ${DEFAULT_SCAN_OPTIONS.minState}); one of ${STATES.join(', ')}`,
  },
];

const OUTPUT_ROWS: Row[] = [
  { flags: '--json', text: 'machine-readable report on stdout; never coloured' },
  {
    flags: '--history',
    text: `show which way each finding has been moving, read from the local snapshot archive (${tidyPath(HISTORY_DIR)}). A package needs at least ${MIN_SAMPLES_FOR_TRAJECTORY} samples before a direction means anything, and history cannot be backfilled — only accumulated.`,
  },
  { flags: '--quiet, -q', text: 'suppress progress on stderr; the report still prints' },
  { flags: '--no-color', text: 'disable ANSI colour even on a terminal' },
  { flags: '--version, -v', text: 'print the version and exit' },
  { flags: '--help, -h', text: 'print this help and exit' },
];

const FIX_ROWS: Row[] = [
  {
    flags: '--fix',
    text: 'rewrite the safe mechanical renames: a curated succession that is a rename or reimplementation, to a package, drop-in, at high confidence. Nothing else is touched, and a package mentioned anywhere the codemod cannot rewrite is refused whole. Edits package.json and the imports that name it; never a lockfile. Only the findings shown are considered, so raise --limit to cover more.',
  },
  { flags: '--dry-run', text: 'with --fix: print the plan and write nothing' },
  {
    flags: '--force',
    text: 'with --fix: rewrite files even when git reports uncommitted changes to them. Without it, --fix refuses, because a codemod you cannot diff or revert is a trap.',
  },
];

const NETWORK_ROWS: Row[] = [
  {
    flags: '--contact <email>',
    text: "sent upstream so ecosyste.ms can reach you, which puts your requests in their polite pool (default: $DEAD_DEPS_CONTACT)",
  },
  {
    flags: '--concurrency <n>',
    text: `maximum parallel upstream requests (default: ${DEFAULT_SCAN_OPTIONS.concurrency})`,
  },
  { flags: '--no-cache', text: 'bypass the on-disk cache and re-fetch everything' },
  {
    flags: '--cache-ttl <hours>',
    text: `how long cached responses stay usable (default: ${DEFAULT_SCAN_OPTIONS.cacheTtlHours})`,
  },
];

const EXIT_ROWS: Row[] = [
  { flags: '0', text: 'clean — nothing was flagged' },
  {
    flags: '1',
    text: 'at least one dependency was flagged; gate CI on this. --fix does not change it: the code describes what the scan found, not what was repaired',
  },
  {
    flags: '2',
    text: 'usage error — unknown flag, bad value, unreadable path, or --fix refused because the files it would rewrite have uncommitted changes',
  },
  {
    flags: '3',
    text: 'runtime error — no lockfile found, upstream unreachable, or a --fix that was planned could not be written',
  },
];

const ENV_ROWS: Row[] = [
  { flags: 'DEAD_DEPS_CONTACT', text: 'default for --contact' },
  { flags: 'DEAD_DEPS_HISTORY_DIR', text: 'where --history reads its snapshot archive from' },
  { flags: 'DEAD_DEPS_DEBUG', text: 'print stack traces instead of one-line errors' },
  { flags: 'NO_COLOR', text: 'disable colour (any non-empty value)' },
];

interface Example {
  command: string;
  text: string;
}

const EXAMPLES: Example[] = [
  {
    command: 'dead-deps',
    text: "Scan this project's direct dependencies and show the worst few.",
  },
  {
    command: 'dead-deps --all --min-state unmaintained --limit 20',
    text: 'Sweep the whole tree, transitive dependencies included, and report only the ones that are clearly no longer maintained.',
  },
  {
    command: 'dead-deps ./services/api --json > dead-deps.json',
    text: 'Scan one workspace and keep the machine-readable report; progress still goes to stderr, so the file stays valid JSON.',
  },
  {
    command: 'dead-deps --min-state deprecated --quiet',
    text: 'A CI gate: exits 1 the moment anything deprecated or worse turns up, and prints nothing but the report.',
  },
  {
    command: 'dead-deps --fix --dry-run',
    text: 'Show exactly which files a --fix would rewrite, and the reason every other finding was refused, without touching anything.',
  },
  {
    command: 'dead-deps --history',
    text: 'Add the direction each flagged package has been moving in. No index publishes this; it comes from snapshots taken here, week after week.',
  },
];

function outputWidth(): number {
  const columns = process.stdout.columns;
  if (typeof columns !== 'number' || !Number.isFinite(columns) || columns <= 0) return 80;
  return Math.min(88, Math.max(60, Math.floor(columns) - 1));
}

function renderRows(rows: readonly Row[], gutter: number, width: number, dim: Paint, out: string[]): void {
  const pad = ' '.repeat(2 + gutter + 2);
  for (const row of rows) {
    const lines = wrap(row.text, width - pad.length);
    const head = `  ${row.flags.padEnd(gutter)}  `;
    // A flag wider than the gutter gets its own line rather than shoving the
    // whole column right for everyone else.
    if (row.flags.length > gutter) {
      out.push(`  ${row.flags}`);
      for (const line of lines) out.push(pad + dim(line));
      continue;
    }
    lines.forEach((line, index) => {
      out.push(index === 0 ? head + dim(line) : pad + dim(line));
    });
  }
}

function helpText(color: boolean): string {
  const bold = painter('1', color);
  const dim = painter('2', color);
  const cyan = painter('36', color);
  const width = outputWidth();

  // The three flag groups share one gutter so every description starts in the
  // same column; the narrow reference tables get their own, tighter one.
  const flagGroups: Array<{ title: string; rows: readonly Row[] }> = [
    { title: 'SCOPE', rows: SCOPE_ROWS },
    { title: 'OUTPUT', rows: OUTPUT_ROWS },
    { title: 'FIXING', rows: FIX_ROWS },
    { title: 'NETWORK', rows: NETWORK_ROWS },
  ];
  const flagGutter = Math.min(
    22,
    Math.max(8, ...flagGroups.flatMap((group) => group.rows.map((row) => row.flags.length))),
  );

  const out: string[] = [];
  out.push('');
  out.push(`  ${bold('dead-deps')} ${dim('—')} find abandoned dependencies, and what replaced them`);
  out.push('');
  out.push(`  ${bold('USAGE')}`);
  out.push(`    ${cyan('dead-deps')} [path] [options]`);
  out.push('');
  for (const line of wrap(
    'path may be a directory, a lockfile, or a package.json. Defaults to the current directory, where dead-deps picks pnpm-lock.yaml, package-lock.json, npm-shrinkwrap.json or yarn.lock, in that order, and falls back to package.json.',
    width - 4,
  )) {
    out.push(`    ${dim(line)}`);
  }

  for (const group of flagGroups) {
    out.push('');
    out.push(`  ${bold(group.title)}`);
    renderRows(group.rows, flagGutter, width, dim, out);
  }

  for (const group of [
    { title: 'EXIT CODES', rows: EXIT_ROWS },
    { title: 'ENVIRONMENT', rows: ENV_ROWS },
  ]) {
    const gutter = Math.max(...group.rows.map((row) => row.flags.length));
    out.push('');
    out.push(`  ${bold(group.title)}`);
    renderRows(group.rows, gutter, width, dim, out);
  }

  out.push('');
  out.push(`  ${bold('EXAMPLES')}`);
  for (const example of EXAMPLES) {
    out.push('');
    out.push(`  ${cyan(example.command)}`);
    for (const line of wrap(example.text, width - 6)) out.push(`      ${dim(line)}`);
  }
  out.push('');
  return out.join('\n');
}

function usageSynopsis(): string {
  return (
    'usage: dead-deps [path] [--all] [--limit <n>] [--min-state <state>] [--json] ' +
    '[--history] [--fix [--dry-run]]'
  );
}

// ---------------------------------------------------------------------------
// --history
// ---------------------------------------------------------------------------

/** Same fold the archive uses: npm treats `Base64` and `base64` as one package. */
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * A trajectory per finding, from the local archive.
 *
 * One read of the archive for the whole report rather than one per finding:
 * `readSnapshotsFor` re-reads every week file each time it is called, and a
 * report of twenty findings does not need twenty passes over the same year.
 * Reading never throws — a missing archive is simply an empty one.
 */
async function collectTrajectories(result: ScanResult): Promise<Trajectory[]> {
  const rows = await readAllSnapshots();
  if (rows.length === 0) return [];

  const byName = new Map<string, HealthSnapshot[]>();
  for (const row of rows) {
    const key = nameKey(row.name);
    const bucket = byName.get(key);
    if (bucket === undefined) byName.set(key, [row]);
    else bucket.push(row);
  }

  const out: Trajectory[] = [];
  for (const finding of result.findings) {
    const bucket = byName.get(nameKey(finding.dependency.name));
    if (bucket === undefined) continue;
    const trajectory = computeTrajectory(bucket);
    if (trajectory !== null) out.push(trajectory);
  }
  return out;
}

function trendPaint(direction: TrendDirection, color: boolean): Paint {
  switch (direction) {
    case 'collapsing':
      return painter('31', color);
    case 'declining':
      return painter('33', color);
    case 'improving':
      return painter('32', color);
    default:
      return painter('2', color);
  }
}

/**
 * The history block, appended under the report.
 *
 * Only trajectories with enough samples are shown. A package sampled once has
 * no direction, and printing "no trend yet" for every finding would bury the
 * one line that does say something. When nothing qualifies the block explains
 * why in a sentence rather than printing an empty heading.
 */
function renderHistory(trajectories: readonly Trajectory[], color: boolean): string {
  const bold = painter('1', color);
  const dim = painter('2', color);
  const width = outputWidth();

  const out: string[] = [`  ${bold('HISTORY')}`];
  const shown = trajectories.filter((item) => item.samples >= MIN_SAMPLES_FOR_TRAJECTORY);

  if (shown.length === 0) {
    const sampled = trajectories.length;
    const detail =
      sampled === 0
        ? `Nothing in this report has been sampled yet. The archive lives in ${tidyPath(HISTORY_DIR)}.`
        : `${sampled} of these packages ${sampled === 1 ? 'has' : 'have'} been sampled once, and a direction needs ${MIN_SAMPLES_FOR_TRAJECTORY}.`;
    for (const line of wrap(detail, width - 4)) out.push(`    ${dim(line)}`);
    for (const line of wrap(
      'History cannot be backfilled, only accumulated: every index publishes a package\'s current state and nothing else. Sample again next week and this block starts answering "is it getting worse?".',
      width - 4,
    )) {
      out.push(`    ${dim(line)}`);
    }
    out.push('');
    return out.join('\n');
  }

  for (const trajectory of shown) {
    out.push(`    ${trendPaint(trajectory.direction, color)(summarise(trajectory))}`);
  }

  const quiet = trajectories.length - shown.length;
  if (quiet > 0) {
    out.push(
      `    ${dim(`${quiet} further flagged ${quiet === 1 ? 'package has' : 'packages have'} too few samples to compare.`)}`,
    );
  }
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// --fix
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

/** Either git's stdout, or why we did not get any. */
type GitResult = string | { reason: string; spawnFailed: boolean };

async function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const raw = (error as { stderr?: unknown }).stderr;
    const stderr = typeof raw === 'string' ? raw.trim() : '';
    return {
      reason: stderr === '' ? errorMessage(error) : (stderr.split('\n')[0] ?? stderr),
      // A string `code` (ENOENT, EACCES) means git never ran; a numeric one
      // means git ran and disagreed with us, which is a different situation.
      spawnFailed: typeof (error as { code?: unknown }).code === 'string',
    };
  }
}

/** How a file differs from what is committed, in one word for a human. */
function describeStatus(code: string): string {
  if (code.startsWith('?')) return 'untracked';
  if (code.startsWith('!')) return 'ignored';
  const staged = code[0] !== ' ' && code[0] !== '?';
  const unstaged = code[1] !== ' ' && code[1] !== '?';
  if (staged && unstaged) return 'staged, with further unstaged changes';
  return staged ? 'staged but not committed' : 'modified';
}

/**
 * Entries out of `git status --porcelain -z`, keyed by absolute path.
 *
 * `-z` because a path with a space, a quote or a newline in it is legal and
 * the non-`-z` format escapes those into something that no longer matches the
 * file on disk. Rename and copy entries carry their source path in the next
 * NUL-separated field, which is consumed rather than read as a status line.
 */
function porcelainEntries(output: string, toplevel: string): Map<string, string> {
  const records = output.split('\0');
  const entries = new Map<string, string>();

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4) continue;
    const path = record.slice(3);
    if (path !== '') entries.set(resolve(toplevel, path), describeStatus(record.slice(0, 2)));
    if (record[0] === 'R' || record[0] === 'C') index += 1;
  }
  return entries;
}

/** One file the plan would rewrite, and why it is not safe to rewrite yet. */
interface DirtyFile {
  file: string;
  /** `untracked`, `modified`, … — what git says about it. */
  state: string;
}

interface TreeState {
  /** Files the plan would rewrite that are not committed as they stand. */
  dirty: DirtyFile[];
  /** Set when we could not establish the above. Treated exactly like dirty. */
  unknown: string | null;
}

const CLEAN_TREE: TreeState = { dirty: [], unknown: null };

/**
 * Which of `files` git would report as changed.
 *
 * The rule this implements: a codemod the user cannot diff or revert is a
 * trap. So anything that is not committed as it stands blocks the fix —
 * modified, staged, and untracked alike, since `git checkout` cannot bring
 * back a file git never knew about.
 *
 * Not being in a repository at all is *not* a refusal. Plenty of real projects
 * are not versioned, and refusing there would make `--fix` useless for them
 * while protecting nobody. But a repository we cannot question — git missing,
 * ownership disputed, `status` failing — is a refusal, because "we could not
 * check" and "there is nothing to lose" are not the same answer.
 */
async function guardWorkingTree(root: string, files: readonly string[]): Promise<TreeState> {
  if (files.length === 0) return CLEAN_TREE;

  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (typeof top !== 'string') {
    if (top.spawnFailed) {
      return existsSync(join(root, '.git'))
        ? { dirty: [], unknown: `this looks like a git repository, but git could not be run (${top.reason})` }
        : CLEAN_TREE;
    }
    if (/not a git repository/i.test(top.reason)) return CLEAN_TREE;
    return { dirty: [], unknown: `git could not describe this directory (${top.reason})` };
  }

  const toplevel = top.trim();
  if (toplevel === '') return CLEAN_TREE;

  const status = await git(toplevel, ['status', '--porcelain', '-z', '--', ...files]);
  if (typeof status !== 'string') {
    return { dirty: [], unknown: `git status failed (${status.reason})` };
  }

  const changed = porcelainEntries(status, toplevel);
  const dirty: DirtyFile[] = [];
  for (const file of files) {
    const state = changed.get(file);
    if (state !== undefined) dirty.push({ file, state });
  }
  return { dirty, unknown: null };
}

interface FixOutcome {
  /**
   * `nothing` is a success: the scan found no finding this codemod is allowed
   * to touch, which is the common case and not a failure of anything.
   */
  status: 'applied' | 'planned' | 'nothing' | 'refused' | 'failed';
  plan: FixPlan | null;
  written: string[];
  tree: TreeState;
  /** Why the fix did not happen. Printed to stderr, and sets the exit code. */
  problem: string | null;
  hint: string | null;
}

function uniqueFiles(edits: readonly FixEdit[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const edit of edits) {
    if (seen.has(edit.file)) continue;
    seen.add(edit.file);
    out.push(edit.file);
  }
  return out;
}

function describeDirty(tree: TreeState, root: string): string {
  if (tree.unknown !== null) return tree.unknown;
  const count = tree.dirty.length;
  const names = tree.dirty
    .map((entry) => `${relativeTo(root, entry.file)} is ${entry.state}`)
    .join(', ');
  return `${count} of the files it would rewrite ${count === 1 ? 'is' : 'are'} not committed as ${count === 1 ? 'it stands' : 'they stand'} — ${names}`;
}

/**
 * Plan the fix, decide whether it is allowed to happen, and — unless this is a
 * dry run — write it.
 *
 * Never throws. A refusal or a failed write is an outcome the caller reports
 * alongside the scan, because losing the report to an exception would punish
 * the user twice for asking to be helped.
 */
async function runFix(cli: Invocation, result: ScanResult, root: string): Promise<FixOutcome> {
  const base: FixOutcome = {
    status: 'nothing',
    plan: null,
    written: [],
    tree: CLEAN_TREE,
    problem: null,
    hint: null,
  };

  let plan: FixPlan;
  try {
    plan = await planFixes(result, root);
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      problem: `--fix could not read ${tidyPath(root)} (${errorMessage(error)}); nothing was written`,
      hint: 'Point the scan at the project directory that holds the package.json you want rewritten.',
    };
  }

  if (plan.edits.length === 0) return { ...base, status: 'nothing', plan };

  const files = uniqueFiles(plan.edits);
  const tree = cli.force ? CLEAN_TREE : await guardWorkingTree(root, files);
  const blocked = tree.dirty.length > 0 || tree.unknown !== null;

  if (blocked && !cli.dryRun) {
    return {
      ...base,
      status: 'refused',
      plan,
      tree,
      problem: `refusing to --fix: ${describeDirty(tree, root)}`,
      hint:
        'Commit or stash them first, so the rename lands in a diff you can read and revert. ' +
        'Re-run with --dry-run to see the plan, or --force to write anyway.',
    };
  }

  if (cli.dryRun) return { ...base, status: 'planned', plan, tree };

  let written: string[];
  try {
    written = await applyFixes(plan);
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      plan,
      tree,
      problem: `--fix failed: ${errorMessage(error)}`,
      hint: 'Re-run the scan; the plan is rebuilt from whatever the files hold now.',
    };
  }

  return { ...base, status: 'applied', plan, written, tree };
}

/**
 * What changed, file by file, and what did not.
 *
 * Every edit is named individually rather than counted. A codemod that reports
 * "3 files updated" leaves the user opening files to find out which — and the
 * whole argument for letting a tool edit your source is that it tells you
 * precisely what it did.
 */
function renderFix(outcome: FixOutcome, cli: Invocation, root: string): string {
  const color = cli.color;
  const bold = painter('1', color);
  const dim = painter('2', color);
  const green = painter('32', color);
  const yellow = painter('33', color);
  const arrow = process.env['TERM'] === 'dumb' ? '->' : '→';
  const width = outputWidth();

  const plan = outcome.plan;
  const edits = plan?.edits ?? [];
  const dry = outcome.status === 'planned';
  const out: string[] = [`  ${bold(dry ? 'FIX (dry run)' : 'FIX')}`];

  if (edits.length === 0) {
    for (const line of wrap(
      'Nothing here can be renamed mechanically. A fix is only attempted for a curated succession that is a rename or reimplementation, to a package, drop-in, at high confidence — everything else needs a human.',
      width - 4,
    )) {
      out.push(`    ${dim(line)}`);
    }
  } else {
    const files = uniqueFiles(edits);
    const headline = dry
      ? `would rewrite ${files.length} ${files.length === 1 ? 'file' : 'files'}; nothing was written`
      : `rewrote ${outcome.written.length} ${outcome.written.length === 1 ? 'file' : 'files'}`;
    out.push(`    ${dry ? dim(headline) : green(headline)}`);

    for (const file of files) {
      out.push(`    ${bold(relativeTo(root, file))}`);
      for (const edit of edits) {
        if (edit.file !== file) continue;
        const where = edit.kind === 'manifest' ? 'dependency key' : 'import';
        out.push(`      ${edit.from} ${arrow} ${edit.to}  ${dim(`(${where})`)}`);
      }
    }
  }

  if (plan !== null && plan.skipped.length > 0) {
    out.push('');
    out.push(`    ${bold('Left alone')}`);
    for (const item of plan.skipped) {
      const lines = wrap(`${item.name} — ${item.reason}`, width - 8);
      lines.forEach((line, index) => out.push(`      ${dim(index === 0 ? line : `  ${line}`)}`));
    }
  }

  // The tree was dirty but this is a dry run, so it was a warning rather than
  // a refusal. Say now what the real run would do.
  if (dry && (outcome.tree.dirty.length > 0 || outcome.tree.unknown !== null)) {
    out.push('');
    for (const line of wrap(
      `Without --force this plan would be refused: ${describeDirty(outcome.tree, root)}.`,
      width - 4,
    )) {
      out.push(`    ${yellow(line)}`);
    }
  }

  if (edits.length > 0) {
    out.push('');
    for (const line of wrap(REINSTALL_NOTICE, width - 4)) out.push(`    ${yellow(line)}`);
  }

  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// JSON extras
// ---------------------------------------------------------------------------

function jsonTrajectories(trajectories: readonly Trajectory[]): Array<Record<string, unknown>> {
  return trajectories.map((item) => ({
    name: item.name,
    from: item.from,
    to: item.to,
    samples: item.samples,
    direction: item.direction,
    /** False when the archive is too young for the direction to mean anything. */
    comparable: item.samples >= MIN_SAMPLES_FOR_TRAJECTORY,
    scoreDelta: item.scoreDelta,
    dependentFlight: item.dependentFlight,
    responsivenessDelta: item.responsivenessDelta,
    notes: [...item.notes],
    summary: summarise(item),
  }));
}

/** The plan without `before`/`after`: whole files do not belong in a report. */
function jsonFix(outcome: FixOutcome): Record<string, unknown> {
  return {
    status: outcome.status,
    edits: (outcome.plan?.edits ?? []).map((edit) => ({
      file: edit.file,
      from: edit.from,
      to: edit.to,
      kind: edit.kind,
    })),
    skipped: (outcome.plan?.skipped ?? []).map((item) => ({ name: item.name, reason: item.reason })),
    written: [...outcome.written],
    uncommitted: outcome.tree.dirty.map((entry) => ({ file: entry.file, state: entry.state })),
    unverified: outcome.tree.unknown,
    problem: outcome.problem,
    reinstall: outcome.written.length > 0 ? REINSTALL_NOTICE : null,
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function assertReadableTarget(target: string): Promise<void> {
  try {
    await stat(target);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new UsageError(
        `no such file or directory: ${tidyPath(target)}`,
        'Pass a directory, a lockfile, or a package.json — or nothing at all to scan the current directory.',
      );
    }
    throw error;
  }
}

function preamble(cli: Invocation): string {
  const dim = painter('2', cli.errColor);
  const scope = cli.options.all ? 'all dependencies' : 'direct dependencies';
  const parts = [`scanning ${tidyPath(cli.target)}`, scope, `reporting ${cli.options.minState} and worse`];
  if (cli.options.noCache) parts.push('cache bypassed');
  return `${dim(`dead-deps: ${parts.join(' · ')}`)}\n`;
}

async function run(argv: string[]): Promise<ExitCode> {
  const cli = parseCli(argv);

  if (cli.help) {
    await write(process.stdout, `${helpText(cli.color)}\n`);
    return EXIT.OK;
  }
  if (cli.version) {
    await write(process.stdout, `${VERSION}\n`);
    return EXIT.OK;
  }

  if (!cli.options.quiet) {
    const yellow = painter('33', cli.errColor);
    for (const note of cli.notes) await write(process.stderr, `${yellow(`dead-deps: ${note}`)}\n`);
  }

  await assertReadableTarget(cli.target);

  if (!cli.options.quiet) await write(process.stderr, preamble(cli));

  const result = await scan(cli.target, cli.options);

  // The project root for a fix is the directory the lockfile was found in, not
  // the path the user typed: `dead-deps ./services/api/package-lock.json`
  // rewrites `./services/api/package.json`.
  const root = dirname(result.lockfile.path);

  const trajectories = cli.history ? await collectTrajectories(result) : null;
  // Everything is decided before a byte reaches stdout, so a refused or failed
  // fix still prints the report it belongs to instead of replacing it.
  const fix = cli.fix ? await runFix(cli, result, root) : null;

  if (cli.json) {
    const payload = JSON.parse(renderJson(result)) as Record<string, unknown>;
    if (trajectories !== null) payload['trajectories'] = jsonTrajectories(trajectories);
    if (fix !== null) payload['fix'] = jsonFix(fix);
    await write(process.stdout, `${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const sections = [renderTerminal(result, { color: cli.color })];
    if (trajectories !== null) sections.push(renderHistory(trajectories, cli.color));
    // A refusal or a write failure is reported on stderr instead: a "FIX"
    // block for a fix that did not happen reads as though it did.
    if (fix !== null && fix.status !== 'failed' && fix.status !== 'refused') {
      sections.push(renderFix(fix, cli, root));
    }
    await write(process.stdout, `${sections.join('\n')}\n`);
  }

  if (fix !== null && fix.problem !== null) {
    await writeProblem(fix.problem, fix.hint, cli.errColor);
    return fix.status === 'refused' ? EXIT.USAGE_ERROR : EXIT.RUNTIME_ERROR;
  }

  return result.findings.length > 0 ? EXIT.FINDINGS : EXIT.OK;
}

/** One sentence on stderr, wrapped, with an optional dim hint underneath. */
async function writeProblem(message: string, hint: string | null, color: boolean): Promise<void> {
  const red = painter('31', color);
  const dim = painter('2', color);
  const width = outputWidth();

  const lines: string[] = [];
  wrap(`dead-deps: ${message}`, width).forEach((line, index) => {
    lines.push(index === 0 ? line.replace('dead-deps:', red('dead-deps:')) : `  ${line}`);
  });
  if (hint !== null) {
    for (const line of wrap(hint, width - 2)) lines.push(`  ${dim(line)}`);
  }
  await write(process.stderr, `${lines.join('\n')}\n`);
}

async function reportFailure(error: unknown, target: string): Promise<ExitCode> {
  const failure = classify(error, target);
  const color = wantsColor(process.stderr, false);
  const dim = painter('2', color);

  await writeProblem(failure.message, failure.hint, color);

  const trailer: string[] = [];
  if (failure.code === EXIT.USAGE_ERROR) trailer.push(`  ${dim(usageSynopsis())}`);
  if (envSet('DEAD_DEPS_DEBUG') && error instanceof Error && typeof error.stack === 'string') {
    trailer.push('', error.stack);
  } else if (failure.unexplained === true) {
    trailer.push(`  ${dim('Set DEAD_DEPS_DEBUG=1 for the full stack trace.')}`);
  }
  if (trailer.length > 0) await write(process.stderr, `${trailer.join('\n')}\n`);

  return failure.code;
}

// A closed pipe (`dead-deps | head`) is a normal way to stop reading, not a
// crash; anything else on these streams is a real runtime failure.
function guardStream(stream: NodeJS.WriteStream): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(EXIT.OK);
    process.exitCode = EXIT.RUNTIME_ERROR;
  });
}

guardStream(process.stdout);
guardStream(process.stderr);

const argv = process.argv.slice(2);
// `--target` is resolved inside parseCli, so failures before that report against
// the raw first positional; good enough for the one message that can use it.
const rawTarget = resolve(argv.find((arg) => !arg.startsWith('-')) ?? '.');

let exitCode: ExitCode;
try {
  exitCode = await run(argv);
} catch (error) {
  exitCode = await reportFailure(error, rawTarget);
}

process.exitCode = exitCode;
// Keep-alive sockets from the upstream fetches can hold the loop open for
// several seconds after the report is written; the output has already been
// flushed by `write`, so leaving now costs nothing.
process.exit(exitCode);
