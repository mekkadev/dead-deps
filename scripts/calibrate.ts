/**
 * Calibration harness.
 *
 * Runs the real detector — real HTTP, real `gatherSignals`, real `assess` —
 * over the hand-labelled corpus in `data/calibration.yaml` and scores its
 * verdicts against the ground-truth labels.
 *
 * The numbers this prints are published in the README and on the site's
 * methodology page, so the harness is written to make flattering itself hard:
 *
 *   - Strict accuracy (exact state match) is always reported, and always
 *     first. Lenient accuracy exists too, but it is labelled as lenient and
 *     the exact set of state pairs it forgives is printed alongside it.
 *   - The headline metric is the false-positive rate over the
 *     `stable-complete` bucket, not overall accuracy. Overall accuracy can be
 *     bought by flagging everything old; the false-positive rate cannot.
 *   - Every disagreement is listed individually with the evidence that drove
 *     it, so a reader can check the failures rather than trusting a ratio.
 *   - A partial run (`--limit`) is marked `partial` everywhere and writes to a
 *     separate file, so a smoke test can never overwrite a published number.
 *
 * Usage:
 *   node --import tsx scripts/calibrate.ts [--json] [--limit <n>] [--no-cache]
 *                                          [--cache-ttl <hours>] [--contact <email>]
 *                                          [--out <path>] [--max-fp-rate <percent>]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { assess } from '../src/detect/score.js';
import { gatherSignals, HttpClient } from '../src/sources/index.js';
import { DEFAULT_SCAN_OPTIONS, EXIT, STATE_SEVERITY } from '../src/types.js';
import type { Assessment, Evidence, MaintenanceState } from '../src/types.js';

// ---------------------------------------------------------------------------
// Paths and constants
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CORPUS_PATH = join(ROOT, 'data', 'calibration.yaml');
const RESULTS_PATH = join(ROOT, 'docs', 'calibration-results.json');
const PARTIAL_RESULTS_PATH = join(ROOT, 'docs', 'calibration-results.partial.json');

const CONCURRENCY = 6;
const DEFAULT_CACHE_TTL_HOURS = 24;

const ALL_STATES: readonly MaintenanceState[] = [
  'active',
  'stable-complete',
  'unknown',
  'low-activity',
  'unmaintained',
  'deprecated',
  'abandoned',
  'hijack-risk',
];

const ABBREV: Record<MaintenanceState, string> = {
  active: 'act',
  'stable-complete': 'stable',
  unknown: 'unkn',
  'low-activity': 'low',
  unmaintained: 'unmain',
  deprecated: 'deprec',
  abandoned: 'aband',
  'hijack-risk': 'hijack',
};

/**
 * The bucket whose false-positive rate decides whether the tool is worth
 * installing: finished packages that are quiet because they are done.
 */
const HEADLINE_BUCKET: MaintenanceState = 'stable-complete';

/** States a user is never meant to see a finding for. */
const NEVER_FLAG: readonly MaintenanceState[] = ['active', 'stable-complete'];

/**
 * A finding is "reported" when its state clears the tool's own default
 * `minState`, so the false-positive rate measures what users actually see
 * rather than an internal label.
 */
const FLAG_MIN_SEVERITY = STATE_SEVERITY[DEFAULT_SCAN_OPTIONS.minState];

/**
 * Near misses: state pairs where the tool got the word wrong but the advice
 * right. The test is "would the user do anything different?" — not "are these
 * adjacent in the enum".
 *
 * Deliberately excluded, because they are real errors:
 *   low-activity vs anything  — "watch it" and "migrate off it" are different
 *                               instructions, and low-activity vs stable-complete
 *                               is precisely the false positive being measured.
 *   unmaintained vs deprecated — claiming a registry deprecation notice that
 *                               does not exist is a false statement of fact.
 *   unknown vs anything       — an honest abstention is still a miss.
 */
const NEAR_MISS_PAIRS: ReadonlyArray<readonly [MaintenanceState, MaintenanceState]> = [
  // Both mean "no finding"; the user does nothing either way.
  ['active', 'stable-complete'],
  // Both mean "this is dead, plan a migration".
  ['unmaintained', 'abandoned'],
  ['unmaintained', 'hijack-risk'],
  // Both mean "formally retired, migrate".
  ['deprecated', 'abandoned'],
  ['deprecated', 'hijack-risk'],
  ['abandoned', 'hijack-risk'],
];

const NEAR_MISS_KEYS = new Set(
  NEAR_MISS_PAIRS.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]),
);

function isFlagged(state: MaintenanceState): boolean {
  return STATE_SEVERITY[state] >= FLAG_MIN_SEVERITY;
}

function isNearMiss(expected: MaintenanceState, predicted: MaintenanceState): boolean {
  return expected !== predicted && NEAR_MISS_KEYS.has(`${expected}|${predicted}`);
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

interface CorpusEvidence {
  label: string;
  url: string;
}

interface CorpusRow {
  name: string;
  label: MaintenanceState;
  rationale: string;
  evidence: CorpusEvidence[];
}

function isState(value: unknown): value is MaintenanceState {
  return typeof value === 'string' && (ALL_STATES as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseCorpus(text: string): { rows: CorpusRow[]; problems: string[] } {
  const problems: string[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(text) as unknown;
  } catch (error) {
    return { rows: [], problems: [`YAML is not parseable: ${describeError(error)}`] };
  }

  if (!Array.isArray(doc)) {
    return { rows: [], problems: ['Expected the document to be a list of rows.'] };
  }

  const rows: CorpusRow[] = [];
  const seen = new Set<string>();

  doc.forEach((entry, index) => {
    const where = `row ${index + 1}`;
    const record = asRecord(entry);
    if (record === null) {
      problems.push(`${where}: not a mapping.`);
      return;
    }

    const name = record['name'];
    if (typeof name !== 'string' || name.trim() === '') {
      problems.push(`${where}: "name" is missing or not a non-empty string.`);
      return;
    }
    if (seen.has(name)) {
      problems.push(`${where}: "${name}" appears more than once.`);
      return;
    }
    seen.add(name);

    const label = record['label'];
    if (!isState(label)) {
      problems.push(
        `${where} (${name}): "label" is ${JSON.stringify(label)}, which is not a MaintenanceState.`,
      );
      return;
    }

    const rationale = record['rationale'];
    if (typeof rationale !== 'string' || rationale.trim() === '') {
      problems.push(`${where} (${name}): "rationale" is missing. Every label must justify itself.`);
      return;
    }

    const rawEvidence = record['evidence'];
    const evidence: CorpusEvidence[] = [];
    if (Array.isArray(rawEvidence)) {
      for (const item of rawEvidence) {
        const entryRecord = asRecord(item);
        const entryLabel = entryRecord?.['label'];
        const entryUrl = entryRecord?.['url'];
        if (typeof entryLabel === 'string' && typeof entryUrl === 'string') {
          evidence.push({ label: entryLabel, url: entryUrl });
        }
      }
    }
    if (evidence.length === 0) {
      problems.push(
        `${where} (${name}): no usable "evidence" entries. A label nobody can check is not ground truth.`,
      );
      return;
    }

    rows.push({ name: name.trim(), label, rationale: rationale.trim(), evidence });
  });

  return { rows, problems };
}

/**
 * Picks `limit` rows round-robin across labels rather than taking the first
 * `limit`, so a quick partial run touches every bucket instead of only the
 * `active` block the file happens to start with.
 */
function stratifiedSample(rows: readonly CorpusRow[], limit: number): CorpusRow[] {
  if (limit >= rows.length) return [...rows];

  const buckets = new Map<MaintenanceState, CorpusRow[]>();
  for (const row of rows) {
    const bucket = buckets.get(row.label);
    if (bucket === undefined) buckets.set(row.label, [row]);
    else bucket.push(row);
  }

  const order = new Set(rows.map((row) => row.label));
  const picked: CorpusRow[] = [];
  let progressed = true;
  while (picked.length < limit && progressed) {
    progressed = false;
    for (const label of order) {
      if (picked.length >= limit) break;
      const bucket = buckets.get(label);
      const next = bucket?.shift();
      if (next !== undefined) {
        picked.push(next);
        progressed = true;
      }
    }
  }

  // Restore corpus order so output is comparable between runs.
  const chosen = new Set(picked.map((row) => row.name));
  return rows.filter((row) => chosen.has(row.name));
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

interface EvidenceLine {
  kind: string;
  label: string;
  weight: number;
  url: string | null;
}

interface Outcome {
  name: string;
  expected: MaintenanceState;
  predicted: MaintenanceState;
  exact: boolean;
  nearMiss: boolean;
  /** True when the tool would have shown this package to the user. */
  flagged: boolean;
  score: number;
  confidence: Assessment['confidence'];
  stale: boolean;
  sourceErrors: string[];
  topEvidence: EvidenceLine[];
  rationale: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? (error.message || error.name) : String(error);
}

/** `assess` already sorts evidence to lead with whatever argues for the verdict. */
function topEvidence(evidence: readonly Evidence[], count: number): EvidenceLine[] {
  const weighted = evidence.filter((item) => item.weight !== 0);
  const source = weighted.length > 0 ? weighted : evidence;
  return source.slice(0, count).map((item) => ({
    kind: item.kind,
    label: item.label,
    weight: item.weight,
    url: item.url ?? null,
  }));
}

async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item, index);
    }
  });

  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

interface LabelMetrics {
  label: MaintenanceState;
  support: number;
  predicted: number;
  truePositives: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

interface BucketRate {
  bucket: string;
  support: number;
  hits: number;
  rate: number | null;
  packages: string[];
}

interface Metrics {
  total: number;
  exact: number;
  nearMiss: number;
  lenient: number;
  strictAccuracy: number | null;
  lenientAccuracy: number | null;
  confusion: Map<MaintenanceState, Map<MaintenanceState, number>>;
  rowStates: MaintenanceState[];
  colStates: MaintenanceState[];
  perLabel: LabelMetrics[];
  headline: BucketRate;
  falseAlarms: BucketRate;
  missedDead: BucketRate;
  staleRows: number;
  rowsWithSourceErrors: number;
}

function rate(hits: number, support: number): number | null {
  return support === 0 ? null : hits / support;
}

function computeMetrics(outcomes: readonly Outcome[]): Metrics {
  const total = outcomes.length;
  const exact = outcomes.filter((o) => o.exact).length;
  const nearMiss = outcomes.filter((o) => o.nearMiss).length;

  const confusion = new Map<MaintenanceState, Map<MaintenanceState, number>>();
  for (const outcome of outcomes) {
    let row = confusion.get(outcome.expected);
    if (row === undefined) {
      row = new Map<MaintenanceState, number>();
      confusion.set(outcome.expected, row);
    }
    row.set(outcome.predicted, (row.get(outcome.predicted) ?? 0) + 1);
  }

  const expectedStates = new Set(outcomes.map((o) => o.expected));
  const predictedStates = new Set(outcomes.map((o) => o.predicted));
  const rowStates = ALL_STATES.filter((state) => expectedStates.has(state));
  const colStates = ALL_STATES.filter(
    (state) => predictedStates.has(state) || expectedStates.has(state),
  );

  const perLabel: LabelMetrics[] = ALL_STATES.filter(
    (state) => expectedStates.has(state) || predictedStates.has(state),
  ).map((label) => {
    const support = outcomes.filter((o) => o.expected === label).length;
    const predicted = outcomes.filter((o) => o.predicted === label).length;
    const truePositives = outcomes.filter(
      (o) => o.expected === label && o.predicted === label,
    ).length;
    const precision = rate(truePositives, predicted);
    const recall = rate(truePositives, support);
    const f1 =
      precision === null || recall === null || precision + recall === 0
        ? null
        : (2 * precision * recall) / (precision + recall);
    return { label, support, predicted, truePositives, precision, recall, f1 };
  });

  const headlineRows = outcomes.filter((o) => o.expected === HEADLINE_BUCKET);
  const headlineHits = headlineRows.filter((o) => o.flagged);
  const headline: BucketRate = {
    bucket: `${HEADLINE_BUCKET} packages reported as a finding`,
    support: headlineRows.length,
    hits: headlineHits.length,
    rate: rate(headlineHits.length, headlineRows.length),
    packages: headlineHits.map((o) => `${o.name} (predicted ${o.predicted})`),
  };

  const neverFlagRows = outcomes.filter((o) => NEVER_FLAG.includes(o.expected));
  const neverFlagHits = neverFlagRows.filter((o) => o.flagged);
  const falseAlarms: BucketRate = {
    bucket: `healthy packages (${NEVER_FLAG.join(' + ')}) reported as a finding`,
    support: neverFlagRows.length,
    hits: neverFlagHits.length,
    rate: rate(neverFlagHits.length, neverFlagRows.length),
    packages: neverFlagHits.map((o) => `${o.name} (expected ${o.expected}, predicted ${o.predicted})`),
  };

  const shouldFlagRows = outcomes.filter((o) => isFlagged(o.expected));
  const missedRows = shouldFlagRows.filter((o) => !o.flagged);
  const missedDead: BucketRate = {
    bucket: 'packages that should have been reported but were not',
    support: shouldFlagRows.length,
    hits: missedRows.length,
    rate: rate(missedRows.length, shouldFlagRows.length),
    packages: missedRows.map((o) => `${o.name} (expected ${o.expected}, predicted ${o.predicted})`),
  };

  return {
    total,
    exact,
    nearMiss,
    lenient: exact + nearMiss,
    strictAccuracy: rate(exact, total),
    lenientAccuracy: rate(exact + nearMiss, total),
    confusion,
    rowStates,
    colStates,
    perLabel,
    headline,
    falseAlarms,
    missedDead,
    staleRows: outcomes.filter((o) => o.stale).length,
    rowsWithSourceErrors: outcomes.filter((o) => o.sourceErrors.length > 0).length,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pct(value: number | null, digits = 1): string {
  return value === null ? '—' : `${(value * 100).toFixed(digits)}%`;
}

function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

function renderConfusion(metrics: Metrics): string {
  const corner = 'expected \\ predicted';
  const labelWidth = Math.max(corner.length, ...metrics.rowStates.map((s) => s.length));
  const widths = metrics.colStates.map((state) =>
    Math.max(ABBREV[state].length, String(metrics.total).length),
  );
  const totalWidth = Math.max(3, String(metrics.total).length);

  const line = (cells: string[]): string => `${cells[0] ?? ''} | ${cells.slice(1).join(' | ')}`;

  const header = line([
    padRight(corner, labelWidth),
    ...metrics.colStates.map((state, i) => padLeft(ABBREV[state], widths[i] ?? 3)),
    padLeft('n', totalWidth),
  ]);
  const rule = line([
    '-'.repeat(labelWidth),
    ...metrics.colStates.map((_, i) => '-'.repeat(widths[i] ?? 3)),
    '-'.repeat(totalWidth),
  ]);

  const body = metrics.rowStates.map((expected) => {
    const row = metrics.confusion.get(expected);
    let rowTotal = 0;
    const cells = metrics.colStates.map((predicted, i) => {
      const value = row?.get(predicted) ?? 0;
      rowTotal += value;
      return padLeft(value === 0 ? '.' : String(value), widths[i] ?? 3);
    });
    return line([padRight(expected, labelWidth), ...cells, padLeft(String(rowTotal), totalWidth)]);
  });

  const columnTotals = metrics.colStates.map((predicted, i) => {
    let sum = 0;
    for (const row of metrics.confusion.values()) sum += row.get(predicted) ?? 0;
    return padLeft(String(sum), widths[i] ?? 3);
  });
  const footer = line([
    padRight('predicted total', labelWidth),
    ...columnTotals,
    padLeft(String(metrics.total), totalWidth),
  ]);

  const legend = metrics.colStates.map((state) => `${ABBREV[state]} = ${state}`).join(', ');

  return [
    header,
    rule,
    ...body,
    rule,
    footer,
    '',
    `Rows are the hand-labelled truth, columns are what the detector said.`,
    `A perfect detector fills only the diagonal. "." is zero.`,
    `Legend: ${legend}.`,
  ].join('\n');
}

interface RunContext {
  generatedAt: string;
  durationMs: number;
  corpusRows: number;
  evaluated: number;
  partial: boolean;
  cacheEnabled: boolean;
  cacheTtlHours: number;
  contactSupplied: boolean;
  http: { cacheHits: number; requests: number; errors: number };
  resultsPath: string;
}

function renderMarkdown(metrics: Metrics, outcomes: readonly Outcome[], ctx: RunContext): string {
  const out: string[] = [];
  const headline = metrics.headline;

  out.push('# dead-deps calibration');
  out.push('');
  out.push(
    `Run ${ctx.generatedAt} against \`data/calibration.yaml\` — ` +
      `${ctx.evaluated} of ${ctx.corpusRows} labelled packages, ` +
      `${(ctx.durationMs / 1000).toFixed(1)}s, ` +
      `${ctx.http.requests} upstream requests / ${ctx.http.cacheHits} cache hits / ${ctx.http.errors} errors.`,
  );
  out.push('');

  if (ctx.partial) {
    out.push(
      '> **Partial run.** `--limit` was used, so this is a stratified sample of the corpus, ' +
        'not the published result. Do not quote these numbers.',
    );
    out.push('');
  }

  // -- Headline -------------------------------------------------------------
  out.push('## Headline: how often it cries wolf');
  out.push('');
  out.push(
    `**${headline.hits} of ${headline.support} finished-but-quiet packages were flagged — ` +
      `a false-positive rate of ${pct(headline.rate)}.**`,
  );
  out.push('');
  out.push(
    'The `stable-complete` bucket is packages like `once`, `wrappy` and `inherits`: tiny, ancient, ' +
      'downloaded hundreds of millions of times a week, and silent because there is nothing left to ' +
      'add. On last-release date alone they are indistinguishable from dead ones. Telling somebody to ' +
      'migrate off `inherits` is not a finding, it is the tool becoming the problem — so this rate, ' +
      'not overall accuracy, is the number that decides whether the tool is worth running. Overall ' +
      'accuracy can be bought by flagging everything old; this cannot.',
  );
  out.push('');
  out.push(
    `"Flagged" means the predicted state reached the tool's own default reporting threshold ` +
      `(\`minState: ${DEFAULT_SCAN_OPTIONS.minState}\`), i.e. the user would actually have seen it.`,
  );
  if (headline.packages.length > 0) {
    out.push('');
    out.push('False positives in this run:');
    out.push('');
    for (const entry of headline.packages) out.push(`- \`${entry}\``);
  }
  out.push('');

  // -- Summary table --------------------------------------------------------
  out.push('## Summary');
  out.push('');
  out.push('| Metric | Value | Basis |');
  out.push('| --- | --- | --- |');
  out.push(
    `| **False positives on finished packages** | **${pct(headline.rate)}** | ${headline.hits} / ${headline.support} \`stable-complete\` |`,
  );
  out.push(
    `| False alarms on anything healthy | ${pct(metrics.falseAlarms.rate)} | ${metrics.falseAlarms.hits} / ${metrics.falseAlarms.support} \`active\` + \`stable-complete\` |`,
  );
  out.push(
    `| Missed dead packages | ${pct(metrics.missedDead.rate)} | ${metrics.missedDead.hits} / ${metrics.missedDead.support} rows labelled at or above \`${DEFAULT_SCAN_OPTIONS.minState}\` |`,
  );
  out.push(
    `| Strict accuracy (exact state) | ${pct(metrics.strictAccuracy)} | ${metrics.exact} / ${metrics.total} |`,
  );
  out.push(
    `| Lenient accuracy (near misses forgiven) | ${pct(metrics.lenientAccuracy)} | ${metrics.lenient} / ${metrics.total} |`,
  );
  out.push(`| Near misses | ${metrics.nearMiss} | counted as wrong under strict |`);
  out.push('');
  out.push(
    'Strict accuracy is the honest headline of the two. Lenient accuracy forgives exactly the ' +
      'following state pairs, and nothing else — pairs where the tool got the word wrong but the ' +
      'advice right:',
  );
  out.push('');
  for (const [a, b] of NEAR_MISS_PAIRS) out.push(`- \`${a}\` ↔ \`${b}\``);
  out.push('');
  out.push(
    'Not forgiven, because the user would act differently: `low-activity` against anything ' +
      '(“watch it” is not “replace it”, and `low-activity` over a `stable-complete` package is the ' +
      'false positive being measured), `unmaintained` against `deprecated` (asserting a registry ' +
      'notice that does not exist is a false statement of fact), and `unknown` against anything ' +
      '(an honest abstention is still a miss).',
  );
  out.push('');

  // -- Confusion matrix -----------------------------------------------------
  out.push('## Confusion matrix');
  out.push('');
  out.push('```');
  out.push(renderConfusion(metrics));
  out.push('```');
  out.push('');

  // -- Per-label metrics ----------------------------------------------------
  out.push('## Per-label precision and recall');
  out.push('');
  out.push('| Label | Support | Predicted | Correct | Precision | Recall | F1 |');
  out.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of metrics.perLabel) {
    out.push(
      `| \`${row.label}\` | ${row.support} | ${row.predicted} | ${row.truePositives} | ` +
        `${pct(row.precision)} | ${pct(row.recall)} | ${row.f1 === null ? '—' : row.f1.toFixed(2)} |`,
    );
  }
  out.push('');
  out.push(
    'Strict, one-versus-rest, no near-miss credit. Precision is “when it said this, how often was ' +
      'it right”; recall is “of the packages that really were this, how many did it catch”. A label ' +
      'with zero support has no recall and a label never predicted has no precision; both print `—`. ' +
      'Labels the corpus does not contain still appear when the detector predicted them, because a ' +
      'state invented out of nowhere is a result too.',
  );
  out.push('');

  // -- Disagreements --------------------------------------------------------
  const disagreements = outcomes.filter((o) => !o.exact);
  out.push(`## Disagreements (${disagreements.length})`);
  out.push('');
  if (disagreements.length === 0) {
    out.push('None. Every package in the corpus was assigned its ground-truth state exactly.');
    out.push('');
  } else {
    out.push(
      'Every row the detector got wrong, with the evidence that drove its verdict, so failures are ' +
        'diagnosable rather than merely counted.',
    );
    out.push('');
    for (const outcome of disagreements) {
      const kind = outcome.nearMiss ? 'near miss' : 'miss';
      const alarm = outcome.flagged ? 'flagged' : 'not flagged';
      out.push(
        `### \`${outcome.name}\` — expected \`${outcome.expected}\`, predicted ` +
          `\`${outcome.predicted}\` (${kind})`,
      );
      out.push('');
      out.push(
        `score ${outcome.score}/100 · confidence ${outcome.confidence} · ${alarm}` +
          `${outcome.stale ? ' · upstream data is stale' : ''}`,
      );
      out.push('');
      out.push(`Ground truth: ${outcome.rationale}`);
      out.push('');
      out.push('Evidence that drove the prediction:');
      out.push('');
      for (const item of outcome.topEvidence) {
        const weight = item.weight > 0 ? `+${item.weight}` : String(item.weight);
        const link = item.url === null ? '' : ` <${item.url}>`;
        out.push(`- \`${item.kind}\` (${weight}) ${item.label}${link}`);
      }
      if (outcome.sourceErrors.length > 0) {
        out.push('');
        out.push('Sources that did not answer:');
        out.push('');
        for (const error of outcome.sourceErrors) out.push(`- ${error}`);
      }
      out.push('');
    }
  }

  // -- Data quality ---------------------------------------------------------
  out.push('## Data quality caveats for this run');
  out.push('');
  out.push(
    `- ${metrics.staleRows} of ${metrics.total} packages were judged partly on upstream data the ` +
      'freshness check considers stale.',
  );
  out.push(
    `- ${metrics.rowsWithSourceErrors} of ${metrics.total} packages had at least one source fail or ` +
      'return nothing.',
  );
  out.push(
    `- ${ctx.cacheEnabled ? `The on-disk cache was enabled with a ${ctx.cacheTtlHours}h TTL, so some responses may be up to that old.` : 'The on-disk cache was disabled; every response was fetched fresh.'}`,
  );
  out.push(
    `- Corpus size is ${ctx.corpusRows} packages. That is small enough that one row moves any ` +
      'percentage here by roughly two points. See `docs/CALIBRATION.md` for the rest of the limits.',
  );
  out.push('');
  out.push(`Machine-readable results: \`${ctx.resultsPath}\`.`);

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

function confusionToObject(
  metrics: Metrics,
): Record<string, Record<string, number>> {
  const object: Record<string, Record<string, number>> = {};
  for (const expected of metrics.rowStates) {
    const row = metrics.confusion.get(expected);
    const cells: Record<string, number> = {};
    for (const predicted of metrics.colStates) cells[predicted] = row?.get(predicted) ?? 0;
    object[expected] = cells;
  }
  return object;
}

function buildJson(
  metrics: Metrics,
  outcomes: readonly Outcome[],
  ctx: RunContext,
): unknown {
  return {
    schemaVersion: 1,
    generatedAt: ctx.generatedAt,
    partial: ctx.partial,
    corpus: {
      path: relative(ROOT, CORPUS_PATH),
      rows: ctx.corpusRows,
      evaluated: ctx.evaluated,
    },
    run: {
      durationMs: ctx.durationMs,
      concurrency: CONCURRENCY,
      cacheEnabled: ctx.cacheEnabled,
      cacheTtlHours: ctx.cacheTtlHours,
      contactSupplied: ctx.contactSupplied,
      http: ctx.http,
    },
    definitions: {
      flagThreshold: DEFAULT_SCAN_OPTIONS.minState,
      flaggedStates: ALL_STATES.filter(isFlagged),
      headlineBucket: HEADLINE_BUCKET,
      neverFlagStates: NEVER_FLAG,
      nearMissPairs: NEAR_MISS_PAIRS.map(([a, b]) => [a, b]),
    },
    accuracy: {
      strict: { correct: metrics.exact, total: metrics.total, rate: metrics.strictAccuracy },
      nearMiss: { count: metrics.nearMiss, rate: rate(metrics.nearMiss, metrics.total) },
      lenient: { correct: metrics.lenient, total: metrics.total, rate: metrics.lenientAccuracy },
    },
    headlineFalsePositiveRate: metrics.headline,
    falseAlarms: metrics.falseAlarms,
    missedDead: metrics.missedDead,
    confusion: confusionToObject(metrics),
    perLabel: metrics.perLabel,
    dataQuality: {
      staleRows: metrics.staleRows,
      rowsWithSourceErrors: metrics.rowsWithSourceErrors,
    },
    disagreements: outcomes
      .filter((o) => !o.exact)
      .map((o) => ({
        name: o.name,
        expected: o.expected,
        predicted: o.predicted,
        nearMiss: o.nearMiss,
        flagged: o.flagged,
        score: o.score,
        confidence: o.confidence,
        topEvidence: o.topEvidence,
      })),
    results: outcomes,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Options {
  json: boolean;
  limit: number | null;
  noCache: boolean;
  cacheTtlHours: number;
  contact: string | null;
  out: string | null;
  maxFpRate: number | null;
}

const USAGE = `dead-deps calibration harness

  node --import tsx scripts/calibrate.ts [options]

  --json                 Emit the machine-readable report on stdout instead of markdown.
  --limit <n>            Score a stratified sample of n packages (quick partial run).
  --no-cache             Bypass the on-disk HTTP cache and refetch everything.
  --cache-ttl <hours>    Cache time-to-live. Default ${DEFAULT_CACHE_TTL_HOURS}.
  --contact <email>      Contact address sent upstream. Defaults to $DEAD_DEPS_CONTACT.
  --out <path>           Where to write the JSON results.
  --max-fp-rate <pct>    Exit non-zero if the stable-complete false-positive rate exceeds this.
  -h, --help             Show this message.
`;

function parseNumber(raw: string | undefined, flag: string): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value)) {
    throw new Error(`${flag} needs a number, got ${raw === undefined ? 'nothing' : `"${raw}"`}.`);
  }
  return value;
}

function parseArgs(argv: readonly string[]): Options | 'help' {
  const options: Options = {
    json: false,
    limit: null,
    noCache: false,
    cacheTtlHours: DEFAULT_CACHE_TTL_HOURS,
    contact: process.env['DEAD_DEPS_CONTACT']?.trim() || null,
    out: null,
    maxFpRate: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        return 'help';
      case '--json':
        options.json = true;
        break;
      case '--no-cache':
        options.noCache = true;
        break;
      case '--limit': {
        i += 1;
        const value = Math.floor(parseNumber(argv[i], '--limit'));
        if (value < 1) throw new Error('--limit must be at least 1.');
        options.limit = value;
        break;
      }
      case '--cache-ttl': {
        i += 1;
        const value = parseNumber(argv[i], '--cache-ttl');
        if (value < 0) throw new Error('--cache-ttl must not be negative.');
        options.cacheTtlHours = value;
        break;
      }
      case '--contact': {
        i += 1;
        const value = argv[i];
        if (value === undefined) throw new Error('--contact needs an address.');
        options.contact = value;
        break;
      }
      case '--out': {
        i += 1;
        const value = argv[i];
        if (value === undefined) throw new Error('--out needs a path.');
        options.out = resolve(process.cwd(), value);
        break;
      }
      case '--max-fp-rate': {
        i += 1;
        const value = parseNumber(argv[i], '--max-fp-rate');
        if (value < 0 || value > 100) throw new Error('--max-fp-rate must be a percentage 0..100.');
        options.maxFpRate = value / 100;
        break;
      }
      default:
        throw new Error(`Unknown argument "${arg ?? ''}".`);
    }
  }

  return options;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function readCorpusFile(): Promise<string | null> {
  try {
    return await readFile(CORPUS_PATH, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function main(): Promise<number> {
  let options: Options | 'help';
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n\n${USAGE}`);
    return EXIT.USAGE_ERROR;
  }
  if (options === 'help') {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }

  const text = await readCorpusFile();
  if (text === null) {
    process.stderr.write(
      `No calibration corpus at ${relative(ROOT, CORPUS_PATH)}.\n` +
        'The harness needs a hand-labelled ground-truth file before it can measure anything;\n' +
        'see docs/CALIBRATION.md for the row format. Nothing to do.\n',
    );
    return EXIT.OK;
  }

  const { rows, problems } = parseCorpus(text);
  if (problems.length > 0) {
    process.stderr.write(
      `The calibration corpus is malformed, so its numbers cannot be trusted:\n${problems
        .map((problem) => `  - ${problem}`)
        .join('\n')}\n`,
    );
    return EXIT.USAGE_ERROR;
  }
  if (rows.length === 0) {
    process.stderr.write('The calibration corpus is empty. Nothing to measure.\n');
    return EXIT.OK;
  }

  const selected = options.limit === null ? rows : stratifiedSample(rows, options.limit);
  const partial = selected.length < rows.length;

  const http = new HttpClient({
    contact: options.contact,
    cacheTtlHours: options.cacheTtlHours,
    noCache: options.noCache,
    concurrency: CONCURRENCY,
  });

  process.stderr.write(
    `Scoring ${selected.length} package${selected.length === 1 ? '' : 's'} ` +
      `(concurrency ${CONCURRENCY}, cache ${options.noCache ? 'off' : `on, ${options.cacheTtlHours}h`}` +
      `${options.contact === null ? ', no contact address' : ''})\n`,
  );

  const startedAt = Date.now();
  let done = 0;

  const outcomes = await mapPool(selected, CONCURRENCY, async (row): Promise<Outcome> => {
    const signals = await gatherSignals(http, row.name);
    const assessment = assess(signals);
    const predicted = assessment.state;
    const exact = predicted === row.label;

    done += 1;
    process.stderr.write(
      `  [${String(done).padStart(String(selected.length).length)}/${selected.length}] ` +
        `${padRight(row.name, 24)} ${padRight(predicted, 16)} ` +
        `${exact ? 'ok' : `MISS (expected ${row.label})`}\n`,
    );

    return {
      name: row.name,
      expected: row.label,
      predicted,
      exact,
      nearMiss: isNearMiss(row.label, predicted),
      flagged: isFlagged(predicted),
      score: assessment.score,
      confidence: assessment.confidence,
      stale: signals.freshness.stale,
      sourceErrors: signals.errors,
      topEvidence: topEvidence(assessment.evidence, 3),
      rationale: row.rationale,
    };
  });

  const durationMs = Date.now() - startedAt;
  const metrics = computeMetrics(outcomes);

  const resultsPath =
    options.out ?? (partial ? PARTIAL_RESULTS_PATH : RESULTS_PATH);

  const ctx: RunContext = {
    generatedAt: new Date().toISOString(),
    durationMs,
    corpusRows: rows.length,
    evaluated: selected.length,
    partial,
    cacheEnabled: !options.noCache,
    cacheTtlHours: options.cacheTtlHours,
    contactSupplied: options.contact !== null,
    http: { ...http.stats },
    resultsPath: relative(ROOT, resultsPath) || resultsPath,
  };

  const payload = buildJson(metrics, outcomes, ctx);
  await mkdir(dirname(resultsPath), { recursive: true });
  await writeFile(resultsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stderr.write(`\nWrote ${ctx.resultsPath}\n\n`);

  process.stdout.write(
    options.json
      ? `${JSON.stringify(payload, null, 2)}\n`
      : `${renderMarkdown(metrics, outcomes, ctx)}\n`,
  );

  if (options.maxFpRate !== null) {
    const observed = metrics.headline.rate ?? 0;
    if (observed > options.maxFpRate) {
      process.stderr.write(
        `False-positive rate on ${HEADLINE_BUCKET} is ${pct(observed)}, ` +
          `above the ${pct(options.maxFpRate)} ceiling.\n`,
      );
      return EXIT.FINDINGS;
    }
  }

  return EXIT.OK;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`Calibration failed: ${describeError(error)}\n`);
    process.exitCode = EXIT.RUNTIME_ERROR;
  },
);
