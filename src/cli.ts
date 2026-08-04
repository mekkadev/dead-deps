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
 */

import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { renderJson } from './report/json.js';
import { renderTerminal } from './report/terminal.js';
import { scan } from './scan.js';
import { DEFAULT_SCAN_OPTIONS, EXIT, STATE_SEVERITY } from './types.js';
import type { MaintenanceState, ScanOptions } from './types.js';

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
  { flags: '--quiet, -q', text: 'suppress progress on stderr; the report still prints' },
  { flags: '--no-color', text: 'disable ANSI colour even on a terminal' },
  { flags: '--version, -v', text: 'print the version and exit' },
  { flags: '--help, -h', text: 'print this help and exit' },
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
  { flags: '1', text: 'at least one dependency was flagged; gate CI on this' },
  { flags: '2', text: 'usage error — unknown flag, bad value, or unreadable path' },
  { flags: '3', text: 'runtime error — no lockfile found, upstream unreachable' },
];

const ENV_ROWS: Row[] = [
  { flags: 'DEAD_DEPS_CONTACT', text: 'default for --contact' },
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
];

function helpWidth(): number {
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
  const width = helpWidth();

  // The three flag groups share one gutter so every description starts in the
  // same column; the narrow reference tables get their own, tighter one.
  const flagGroups: Array<{ title: string; rows: readonly Row[] }> = [
    { title: 'SCOPE', rows: SCOPE_ROWS },
    { title: 'OUTPUT', rows: OUTPUT_ROWS },
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
  return 'usage: dead-deps [path] [--all] [--limit <n>] [--min-state <state>] [--json]';
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
  const report = cli.json ? renderJson(result) : renderTerminal(result, { color: cli.color });
  await write(process.stdout, `${report}\n`);

  return result.findings.length > 0 ? EXIT.FINDINGS : EXIT.OK;
}

async function reportFailure(error: unknown, target: string): Promise<ExitCode> {
  const failure = classify(error, target);
  const color = wantsColor(process.stderr, false);
  const red = painter('31', color);
  const dim = painter('2', color);

  const width = helpWidth();
  const lines: string[] = [];
  wrap(`dead-deps: ${failure.message}`, width).forEach((line, index) => {
    lines.push(index === 0 ? line.replace('dead-deps:', red('dead-deps:')) : `  ${line}`);
  });
  if (failure.hint !== null) {
    for (const line of wrap(failure.hint, width - 2)) lines.push(`  ${dim(line)}`);
  }
  if (failure.code === EXIT.USAGE_ERROR) lines.push(`  ${dim(usageSynopsis())}`);

  if (envSet('DEAD_DEPS_DEBUG') && error instanceof Error && typeof error.stack === 'string') {
    lines.push('', error.stack);
  } else if (failure.unexplained === true) {
    lines.push(`  ${dim('Set DEAD_DEPS_DEBUG=1 for the full stack trace.')}`);
  }

  await write(process.stderr, `${lines.join('\n')}\n`);
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
