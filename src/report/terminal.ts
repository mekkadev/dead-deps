/**
 * The human-facing report.
 *
 * This is the screen people screenshot, so it is written to be read in three
 * seconds: a badge tells you how bad it is, one sentence tells you why, and a
 * short evidence tree tells you where to go and check. Everything else is dim.
 *
 * Constraints this file honours:
 *
 *   - Zero dependencies. Raw SGR escapes, nothing else.
 *   - `opts.color === false` emits not a single escape byte. The CLI owns the
 *     decision (`NO_COLOR`, `--no-color`, not-a-TTY); this file just obeys.
 *   - `TERM=dumb` swaps the box-drawing set for ASCII *and* transliterates the
 *     prose, including the typographic dashes and quotes baked into evidence
 *     labels by the scorer.
 *   - URLs are never wrapped. A broken URL is not clickable, and clickable
 *     evidence is the whole promise of the tool.
 */

import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';

import { STATE_SEVERITY } from '../types.js';
import type {
  Evidence,
  Finding,
  LockfileFormat,
  MaintenanceState,
  ScanResult,
  SuccessorRecord,
} from '../types.js';

const MS_PER_DAY = 86_400_000;

/** Narrower than this and the tree indents eat the text. */
const MIN_WIDTH = 56;
/** Long measures are hard to scan; prose stops widening past this. */
const MAX_WIDTH = 96;

/** Evidence lines per finding. Two is usually enough; four is a wall. */
const EVIDENCE_LIMIT = 3;

const LEFT = '  ';
const BODY = '    ';

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

type Paint = (text: string) => string;

/**
 * Styles are never nested: `\x1b[0m` resets everything, so a nested reset would
 * silently drop the outer style. Every call wraps a complete, plain substring.
 */
function painter(code: string, color: boolean): Paint {
  if (!color) return (text) => text;
  return (text) => (text === '' ? '' : `\x1b[${code}m${text}\x1b[0m`);
}

interface Palette {
  bold: Paint;
  dim: Paint;
  red: Paint;
  yellow: Paint;
  green: Paint;
  cyan: Paint;
  link: Paint;
  /** Rendered badge plus the number of columns it occupies. */
  badge: (state: MaintenanceState, label: string) => { text: string; width: number };
}

/** Background/foreground pair per state. Ordered like `STATE_SEVERITY`. */
const BADGE_SGR: Record<MaintenanceState, string> = {
  active: '1;30;42',
  'stable-complete': '1;30;46',
  unknown: '1;97;100',
  'low-activity': '1;30;103',
  unmaintained: '1;30;43',
  deprecated: '1;97;45',
  abandoned: '1;97;41',
  'hijack-risk': '1;97;101',
};

function palette(color: boolean): Palette {
  return {
    bold: painter('1', color),
    dim: painter('2', color),
    red: painter('31', color),
    yellow: painter('33', color),
    green: painter('32', color),
    cyan: painter('36', color),
    link: painter('4;36', color),
    // Coloured badges are padded so the background reads as a block; without
    // colour the padding is just a ragged left margin, so it is dropped.
    badge: (state, label) =>
      color
        ? { text: painter(BADGE_SGR[state], true)(` ${label} `), width: label.length + 2 }
        : { text: label, width: label.length },
  };
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

interface Glyphs {
  rule: string;
  /** All branch prefixes are exactly three columns wide. */
  branch: string;
  lastBranch: string;
  pipe: string;
  blank: string;
  link: string;
  arrow: string;
  sep: string;
  filled: string;
  hollow: string;
  tick: string;
}

const UNICODE: Glyphs = {
  rule: '─',
  branch: '├─ ',
  lastBranch: '└─ ',
  pipe: '│  ',
  blank: '   ',
  link: '↳',
  arrow: '→',
  sep: '·',
  filled: '●',
  hollow: '○',
  tick: '✓',
};

const ASCII: Glyphs = {
  rule: '-',
  branch: '+- ',
  lastBranch: '`- ',
  pipe: '|  ',
  blank: '   ',
  link: '>',
  arrow: '->',
  sep: '-',
  filled: '#',
  hollow: '.',
  tick: 'OK',
};

/**
 * Evidence labels are authored with typographic punctuation by the scorer, so
 * ASCII mode has to clean up prose it did not write.
 */
function toAscii(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/—/g, '--')
    .replace(/–/g, '-')
    .replace(/…/g, '...')
    .replace(/→/g, '->')
    .replace(/·/g, '-')
    .replace(/×/g, 'x')
    .replace(/[^\x20-\x7e]/g, '?');
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function wrapText(text: string, width: number): string[] {
  const limit = Math.max(8, width);
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current === '') current = word;
    else if (current.length + 1 + word.length <= limit) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
    while (current.length > limit) {
      lines.push(current.slice(0, limit));
      current = current.slice(limit);
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

/**
 * Wraps a list of short facts, keeping each separator glued to the end of the
 * chunk it follows so a wrapped line never opens with a dangling dot.
 */
function wrapJoin(items: readonly string[], separator: string, width: number): string[] {
  const limit = Math.max(8, width);
  const lines: string[] = [];
  let current = '';

  items.forEach((item, index) => {
    const piece = index === items.length - 1 ? item : `${item} ${separator}`;
    if (current === '') current = piece;
    else if (current.length + 1 + piece.length <= limit) current = `${current} ${piece}`;
    else {
      lines.push(current.trimEnd());
      current = piece;
    }
  });
  if (current !== '') lines.push(current.trimEnd());
  return lines;
}

function tidyPath(path: string): string {
  const home = homedir();
  if (home !== '' && home !== '/' && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown time';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function plural(value: number, one: string, many: string): string {
  return value === 1 ? one : many;
}

function daysSince(timestamp: string | null): number | null {
  if (timestamp === null) return null;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, (Date.now() - parsed) / MS_PER_DAY);
}

function humanDays(days: number): string {
  const whole = Math.round(days);
  if (whole < 45) return `${whole} ${plural(whole, 'day', 'days')}`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} ${plural(months, 'month', 'months')}`;
  return `${(days / 365.25).toFixed(1)} years`;
}

function calendarDay(timestamp: string | null): string | null {
  if (timestamp === null) return null;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function firstSentence(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  const stop = flat.search(/[.!?](\s|$)/);
  const candidate = stop === -1 ? flat : flat.slice(0, stop + 1);
  if (candidate.length <= max) return candidate;
  return `${candidate.slice(0, max - 1).trimEnd()}…`;
}

const FORMAT_LABEL: Record<LockfileFormat, string> = {
  'npm-v1': 'npm lockfile v1',
  'npm-v2': 'npm lockfile v2',
  'npm-v3': 'npm lockfile v3',
  pnpm: 'pnpm lockfile',
  'yarn-v1': 'Yarn classic lockfile',
  'yarn-berry': 'Yarn Berry lockfile',
  'package-json': 'package.json only, no lockfile',
};

const SUCCESSION_LABEL: Record<SuccessorRecord['type'], string> = {
  fork: 'maintained community fork',
  rename: 'same project, renamed',
  replacement: 'what the ecosystem moved to',
  absorbed: 'absorbed into the platform',
  'self-declared': 'named by the original maintainers',
  reimplementation: 'rebuilt from scratch',
};

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/** The two or three hard facts worth naming in a one-line verdict. */
function verdictReasons(finding: Finding): string[] {
  const signals = finding.assessment.signals;
  const reasons: string[] = [];

  if (signals.deprecationMessage !== null || signals.registryStatus?.toLowerCase() === 'deprecated') {
    reasons.push('deprecated on npm');
  }
  const status = signals.registryStatus?.toLowerCase();
  if (status === 'removed' || status === 'unpublished') reasons.push(`${status} from the registry`);
  if (signals.repoArchived === true) reasons.push('its repository is archived');

  const silence = daysSince(signals.latestReleaseAt);
  if (silence !== null && silence >= 365) reasons.push(`no release in ${humanDays(silence)}`);

  if (signals.activeMaintainers.length === 0 && signals.pastYearIssues !== null && signals.pastYearIssues > 0) {
    const closed = signals.pastYearIssuesClosed ?? 0;
    if (closed === 0) reasons.push('nobody closed an issue all year');
  }
  return reasons.slice(0, 2);
}

/** One line of plain English. No jargon, no score, no hedging. */
function verdictLine(finding: Finding): string {
  const reasons = verdictReasons(finding);
  const because = reasons.length === 0 ? '' : ` — ${reasons.join(', ')}`;

  switch (finding.assessment.state) {
    case 'hijack-risk':
      return `Unattended, still widely installed, and carrying open advisories${because}. This is the profile supply-chain attackers look for.`;
    case 'abandoned':
      return `No longer maintained, and nothing further is coming${because}.`;
    case 'deprecated':
      return `The maintainers deprecated this themselves${because}. It still installs, but it receives no fixes.`;
    case 'unmaintained':
      return `Nobody is maintaining this any more${because}. Bugs you hit are yours to work around.`;
    case 'low-activity':
      return `Still alive but barely moving${because}. Expect a long wait on anything you report.`;
    case 'unknown':
      return 'Too little public data to judge this one either way. Worth a manual look before you rely on it.';
    case 'stable-complete':
      return 'Quiet, but finished rather than abandoned. Nothing here needs doing.';
    case 'active':
      return 'Actively maintained. Shown only because you asked for everything.';
  }
}

// ---------------------------------------------------------------------------
// Evidence selection
// ---------------------------------------------------------------------------

/**
 * `assess()` already sorted evidence so the lines arguing for the verdict come
 * first. All this does is refuse to spend the three slots on lines that argue
 * the other way when better ones exist.
 */
function pickEvidence(finding: Finding): Evidence[] {
  const all = finding.assessment.evidence;
  const incriminating = STATE_SEVERITY[finding.assessment.state] >= STATE_SEVERITY['low-activity'];
  const aligned = all.filter((item) => (incriminating ? item.weight > 0 : item.weight < 0));
  const chosen = aligned.length >= 2 ? aligned : all;
  return chosen.slice(0, EVIDENCE_LIMIT);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface Ctx {
  readonly g: Glyphs;
  readonly c: Palette;
  readonly width: number;
  readonly text: (value: string) => string;
}

function scopeNote(finding: Finding): string {
  const dep = finding.dependency;
  const parts: string[] = [];
  if (!dep.direct) parts.push('transitive');
  if (dep.scope !== 'prod') parts.push(dep.scope);
  return parts.length === 0 ? '' : ` (${parts.join(' ')})`;
}

function findingHeader(ctx: Ctx, finding: Finding, out: string[]): void {
  const { c, text } = ctx;
  const state = finding.assessment.state;
  const badge = c.badge(state, text(state.replace(/-/g, ' ').toUpperCase()));
  const name = finding.dependency.name;
  const version = finding.dependency.version ?? 'unpinned';
  const tail = `${version}${scopeNote(finding)}`;
  const right = `score ${finding.assessment.score}/100`;

  const leftWidth = badge.width + 1 + name.length + 1 + tail.length;
  const gap = Math.max(2, ctx.width - LEFT.length - leftWidth - right.length);

  out.push(
    LEFT +
      badge.text +
      ' ' +
      c.bold(text(name)) +
      ' ' +
      c.dim(text(tail)) +
      ' '.repeat(gap) +
      c.dim(text(right)),
  );
}

function evidenceTree(ctx: Ctx, items: Evidence[], out: string[]): void {
  const { g, c, text } = ctx;
  const prose = ctx.width - BODY.length - 3;

  items.forEach((item, index) => {
    const last = index === items.length - 1;
    const head = last ? g.lastBranch : g.branch;
    const cont = last ? g.blank : g.pipe;
    const lines = wrapText(text(item.label), prose);

    lines.forEach((line, lineIndex) => {
      out.push(BODY + c.dim(lineIndex === 0 ? head : cont) + line);
    });
    if (item.url !== undefined && item.url !== '') {
      // Never wrapped: a split URL stops being clickable.
      out.push(BODY + c.dim(cont) + c.dim(g.link) + ' ' + c.link(item.url));
    }
  });
}

function successorBlock(ctx: Ctx, record: SuccessorRecord, out: string[]): void {
  const { g, c, text } = ctx;
  const indent = BODY;
  const inner = `${BODY}${' '.repeat(g.arrow.length + 1)}`;
  const prose = ctx.width - inner.length;

  out.push('');

  const facets: string[] = [SUCCESSION_LABEL[record.type]];
  // "needs code changes" says nothing when there is nothing to change to.
  if (record.to !== null) facets.push(record.dropIn ? 'drop-in swap' : 'needs code changes');
  if (record.since !== null) facets.push(`dead since ${record.since}`);
  if (record.confidence !== 'high') facets.push(`${record.confidence}-confidence call`);
  const facetText = text(facets.join(` ${g.sep} `));
  const paintFacets = record.to !== null && record.dropIn ? c.green : c.dim;

  const head =
    record.to === null
      ? { plain: `${g.arrow} no maintained successor exists`, paint: c.yellow }
      : { plain: `${g.arrow} ${record.to}`, paint: c.green };

  // Keep the successor name and its facets on one line when they fit; the pair
  // is the whole point of the block and splitting it costs a glance.
  if (indent.length + head.plain.length + 2 + facetText.length <= ctx.width) {
    out.push(indent + head.paint(text(head.plain)) + '  ' + paintFacets(facetText));
  } else {
    out.push(indent + head.paint(text(head.plain)));
    for (const line of wrapText(facetText, prose)) out.push(inner + paintFacets(line));
  }

  const hint = record.migration !== null && record.migration.trim() !== ''
    ? record.migration
    : firstSentence(record.notes, 220);
  for (const line of wrapText(text(hint), prose)) out.push(inner + line);

  if (record.alternatives.length > 0) {
    const alts = record.alternatives.join(` ${g.sep} `);
    for (const line of wrapText(text(`alternatives: ${alts}`), prose)) out.push(inner + c.dim(line));
  }
}

function confidenceLine(ctx: Ctx, finding: Finding, out: string[]): void {
  const { g, c, text } = ctx;
  const { confidence, signals } = finding.assessment;
  const dots =
    confidence === 'high'
      ? g.filled.repeat(3)
      : confidence === 'medium'
        ? g.filled.repeat(2) + g.hollow
        : g.filled + g.hollow.repeat(2);

  const marker = `confidence ${dots} ${confidence}`;
  const notes: string[] = [];

  if (confidence === 'low' && signals.freshness.stale) {
    const synced =
      calendarDay(signals.freshness.repoSyncedAt) ??
      calendarDay(signals.freshness.issuesSyncedAt) ??
      calendarDay(signals.freshness.packageSyncedAt);
    notes.push(
      synced === null
        ? 'data may be stale: upstream did not say when it last looked'
        : `data may be stale: upstream last synced this on ${synced}`,
    );
  }
  if (signals.errors.length > 0) {
    notes.push(`${formatCount(signals.errors.length)} ${plural(signals.errors.length, 'source', 'sources')} could not be read`);
  }

  out.push('');
  if (notes.length === 0) {
    out.push(BODY + c.dim(text(marker)));
    return;
  }

  const note = text(notes.join('; '));
  const oneLine = `${text(marker)}${text(` ${g.sep} `)}${note}`;
  if (BODY.length + oneLine.length <= ctx.width) {
    out.push(BODY + c.dim(text(marker)) + c.dim(text(` ${g.sep} `)) + c.yellow(note));
    return;
  }
  out.push(BODY + c.dim(text(marker)));
  for (const line of wrapText(note, ctx.width - BODY.length - 2)) {
    out.push(BODY + '  ' + c.yellow(line));
  }
}

function renderFinding(ctx: Ctx, finding: Finding, out: string[]): void {
  findingHeader(ctx, finding, out);
  for (const line of wrapText(ctx.text(verdictLine(finding)), ctx.width - BODY.length)) {
    out.push(BODY + line);
  }
  out.push('');
  evidenceTree(ctx, pickEvidence(finding), out);
  if (finding.successor !== null) successorBlock(ctx, finding.successor, out);
  confidenceLine(ctx, finding, out);
}

// ---------------------------------------------------------------------------
// Header and footer
// ---------------------------------------------------------------------------

function renderHeader(ctx: Ctx, result: ScanResult, out: string[]): void {
  const { g, c, text } = ctx;
  const lock = result.lockfile;
  const total = lock.dependencies.length;

  const examined =
    total > 0 && result.examined !== total
      ? `${formatCount(result.examined)} of ${formatCount(total)} dependencies examined`
      : `${formatCount(result.examined)} ${plural(result.examined, 'dependency', 'dependencies')} examined`;

  const facts = [`${basename(lock.path)} (${FORMAT_LABEL[lock.format]})`, examined];
  if (result.findings.length > 0) facts.push(`${formatCount(result.findings.length)} flagged`);
  if (result.skipped > 0) facts.push(`${formatCount(result.skipped)} skipped`);
  facts.push(formatElapsed(result.durationMs));

  out.push('');
  out.push(LEFT + c.bold(text('dead-deps')) + c.dim(text(`  ${g.sep}  ${tidyPath(dirname(lock.path))}`)));
  out.push(LEFT + c.dim(g.rule.repeat(Math.max(8, ctx.width - LEFT.length))));
  for (const line of wrapJoin(facts.map(text), text(g.sep), ctx.width - LEFT.length)) {
    out.push(LEFT + c.dim(line));
  }
  out.push('');
}

/** The single line telling the reader what to actually do next. */
function actionLine(ctx: Ctx, result: ScanResult): string {
  const { g, text } = ctx;
  const count = result.findings.length;
  const lead = `${formatCount(count)} ${plural(count, 'dependency needs', 'dependencies need')} attention.`;

  const withSuccessor = result.findings.filter((f) => f.successor?.to != null);
  const dropIn = withSuccessor.filter((f) => f.successor?.dropIn === true);
  const first = dropIn[0] ?? withSuccessor[0];

  if (first === undefined || first.successor?.to == null) {
    const subject = count === 1 ? 'it' : 'any of them';
    return text(`${lead} No curated successor for ${subject} yet, so read the evidence above before you swap anything.`);
  }
  const swap = `${first.dependency.name} ${g.arrow} ${first.successor.to}`;
  const qualifier = first.successor.dropIn ? ' (a drop-in swap)' : ' (needs code changes)';
  const others = withSuccessor.length - 1;
  const rest =
    others > 0
      ? ` ${others} other flagged ${plural(others, 'package has', 'packages have')} a curated successor too.`
      : '';
  return text(`${lead} Start with ${swap}${qualifier}.${rest}`);
}

function renderFooter(ctx: Ctx, result: ScanResult, out: string[]): void {
  const { g, c, text } = ctx;
  const notFlagged = Math.max(0, result.examined - result.findings.length);

  out.push(LEFT + c.dim(g.rule.repeat(Math.max(8, ctx.width - LEFT.length))));
  for (const line of wrapText(actionLine(ctx, result), ctx.width - LEFT.length)) {
    out.push(LEFT + c.bold(line));
  }

  // Restraint, stated out loud. A tool that flags everything is noise; saying
  // how much was examined and left alone is what makes the flags worth reading.
  const restraint =
    notFlagged === 0
      ? 'Every dependency examined is listed above.'
      : `${formatCount(notFlagged)} other ${plural(notFlagged, 'dependency was', 'dependencies were')} examined and deliberately not flagged — quiet is not the same as dead.`;
  for (const line of wrapText(text(restraint), ctx.width - LEFT.length)) {
    out.push(LEFT + c.dim(line));
  }

  renderWarnings(ctx, result, out);
  out.push('');
}

function renderWarnings(ctx: Ctx, result: ScanResult, out: string[]): void {
  const { c, text } = ctx;
  const warnings = [...result.lockfile.warnings, ...result.warnings];
  if (warnings.length === 0) return;

  const shown = warnings.slice(0, 3);
  out.push('');
  for (const warning of shown) {
    const lines = wrapText(text(`! ${warning}`), ctx.width - LEFT.length - 2);
    lines.forEach((line, index) => out.push(LEFT + (index === 0 ? '' : '  ') + c.yellow(line)));
  }
  const hidden = warnings.length - shown.length;
  if (hidden > 0) {
    out.push(LEFT + c.dim(text(`and ${formatCount(hidden)} more ${plural(hidden, 'warning', 'warnings')}`)));
  }
}

function renderClean(ctx: Ctx, result: ScanResult, out: string[]): void {
  const { g, c, text } = ctx;
  const examined = result.examined;
  const tick = text(g.tick);
  const hang = ' '.repeat(tick.length + 2);
  out.push(LEFT + c.green(tick) + '  ' + c.bold(text('Nothing here looks abandoned.')));

  const detail = `All ${formatCount(examined)} ${plural(examined, 'dependency', 'dependencies')} in ${basename(result.lockfile.path)} are either actively maintained or quietly finished.`;
  for (const line of wrapText(text(detail), ctx.width - LEFT.length - hang.length)) {
    out.push(LEFT + hang + c.dim(line));
  }
  renderWarnings(ctx, result, out);
  out.push('');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function terminalWidth(): number {
  const raw = process.stdout?.columns;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 80;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.floor(raw) - 1));
}

function bySeverityThenScore(a: Finding, b: Finding): number {
  const severity = STATE_SEVERITY[b.assessment.state] - STATE_SEVERITY[a.assessment.state];
  if (severity !== 0) return severity;
  if (b.assessment.score !== a.assessment.score) return b.assessment.score - a.assessment.score;
  return a.dependency.name.localeCompare(b.dependency.name);
}

/**
 * Renders the full report as one string, without a trailing newline: the
 * caller is expected to `console.log()` it.
 */
export function renderTerminal(result: ScanResult, opts: { color: boolean }): string {
  const ascii = process.env['TERM'] === 'dumb';
  const ctx: Ctx = {
    g: ascii ? ASCII : UNICODE,
    c: palette(opts.color),
    width: terminalWidth(),
    text: ascii ? toAscii : (value) => value,
  };

  const out: string[] = [];
  renderHeader(ctx, result, out);

  if (result.findings.length === 0) {
    renderClean(ctx, result, out);
    return out.join('\n');
  }

  const findings = [...result.findings].sort(bySeverityThenScore);
  findings.forEach((finding, index) => {
    if (index > 0) out.push('');
    renderFinding(ctx, finding, out);
    out.push('');
  });

  renderFooter(ctx, result, out);
  return out.join('\n');
}
