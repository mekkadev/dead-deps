/**
 * The two reporters.
 *
 * `renderJson` is a published contract: CI jobs and the MCP server parse it, so
 * it has to be stable byte-for-byte apart from `generatedAt`, and it must carry
 * its schema version. `renderTerminal` has one hard promise — `{ color: false }`
 * emits not a single escape byte — and one restraint promise: a finding shows a
 * few lines of evidence, not all of it.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { renderJson } from '../src/report/json.js';
import { renderTerminal } from '../src/report/terminal.js';
import { STATE_SEVERITY } from '../src/types.js';
import type { Evidence, Finding, MaintenanceState } from '../src/types.js';
import {
  ANSI_PATTERN,
  ESC,
  assessment,
  dependency,
  evidence,
  finding,
  lockfile,
  scanResult,
  signals,
  successor,
} from './helpers.js';

/** Eight distinct, incriminating evidence lines. The report may show three. */
const MANY_EVIDENCE: Evidence[] = Array.from({ length: 8 }, (_, index) =>
  evidence({
    kind: 'release-cadence',
    label: `EVIDENCE-${index} is a fact a human could go and check.`,
    weight: 20 - index,
    url: `https://example.com/evidence/${index}`,
  }),
);

function abandoned(name: string, score = 90): Finding {
  const dep = dependency({ name, version: '1.0.0' });
  return finding({
    dependency: dep,
    assessment: assessment({
      name,
      state: 'abandoned',
      score,
      evidence: MANY_EVIDENCE,
      signals: signals({
        name,
        repositoryUrl: `https://github.com/example/${name}`,
        repoArchived: true,
        latestReleaseAt: '2019-01-01T00:00:00.000Z',
      }),
    }),
    successor: successor({ from: name, to: `${name}-ng` }),
  });
}

function lowActivity(name: string): Finding {
  const dep = dependency({ name, version: '2.3.4', direct: false, scope: 'dev' });
  return finding({
    dependency: dep,
    assessment: assessment({
      name,
      state: 'low-activity',
      score: 30,
      confidence: 'low',
      evidence: [evidence({ label: 'Only one thing is known about this package.', weight: 4 })],
      signals: signals({ name, errors: ['ecosyste.ms lookup failed'], freshness: { stale: true } }),
    }),
  });
}

const RESULT = scanResult({
  lockfile: lockfile({
    dependencies: [dependency({ name: 'alpha' }), dependency({ name: 'beta' })],
    warnings: ['lockfile warning one'],
  }),
  findings: [lowActivity('quiet-thing'), abandoned('dead-thing')],
  examined: 12,
  skipped: 3,
  warnings: ['scan warning one'],
});

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

describe('renderJson', () => {
  function parse(text: string): Record<string, unknown> {
    const value: unknown = JSON.parse(text);
    assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
    return value as Record<string, unknown>;
  }

  test('is valid, pretty-printed JSON carrying its schema version', () => {
    const text = renderJson(RESULT);
    const doc = parse(text);

    assert.equal(doc['schemaVersion'], 1);
    assert.equal(doc['tool'], 'dead-deps');
    assert.match(text, /\n  "schemaVersion"/, 'expected two-space indentation');
    assert.equal(text.endsWith('\n'), false, 'the caller adds the trailing newline');
  });

  test('is stable across renders apart from generatedAt', () => {
    const first = parse(renderJson(RESULT));
    const second = parse(renderJson(RESULT));

    assert.equal(typeof first['generatedAt'], 'string');
    delete first['generatedAt'];
    delete second['generatedAt'];
    assert.deepEqual(first, second);
  });

  test('does not depend on colour, TERM or terminal width', () => {
    const before = renderJson(RESULT);
    const previous = process.env['TERM'];
    process.env['TERM'] = 'dumb';
    try {
      const doc = parse(before);
      const other = parse(renderJson(RESULT));
      delete doc['generatedAt'];
      delete other['generatedAt'];
      assert.deepEqual(doc, other);
    } finally {
      if (previous === undefined) delete process.env['TERM'];
      else process.env['TERM'] = previous;
    }
  });

  test('findings are ordered worst first and keep their full evidence', () => {
    const doc = parse(renderJson(RESULT));
    const findings = doc['findings'] as Array<Record<string, unknown>>;

    assert.deepEqual(
      findings.map((f) => f['name']),
      ['dead-thing', 'quiet-thing'],
    );
    assert.equal(findings[0]?.['state'], 'abandoned');
    assert.equal(findings[0]?.['severity'], STATE_SEVERITY['abandoned' as MaintenanceState]);

    // The terminal report truncates. This one must not.
    const items = findings[0]?.['evidence'] as unknown[];
    assert.equal(items.length, MANY_EVIDENCE.length);
  });

  test('scan, lockfile and summary blocks describe the run', () => {
    const doc = parse(renderJson(RESULT));
    const scan = doc['scan'] as Record<string, unknown>;
    const lock = doc['lockfile'] as Record<string, unknown>;
    const summary = doc['summary'] as Record<string, unknown>;

    assert.equal(scan['startedAt'], '2026-08-04T00:00:00.000Z');
    assert.equal(scan['completedAt'], '2026-08-04T00:00:01.234Z');
    assert.equal(scan['examined'], 12);
    assert.equal(scan['skipped'], 3);
    assert.equal(scan['flagged'], 2);
    assert.equal(scan['notFlagged'], 10);

    assert.equal(lock['format'], 'npm-v3');
    assert.equal(lock['dependencyCount'], 2);
    assert.deepEqual(lock['warnings'], ['lockfile warning one']);

    assert.equal(summary['worstState'], 'abandoned');
    assert.equal(summary['highestScore'], 90);
    assert.equal(summary['withSuccessor'], 1);
    assert.equal(summary['dropInAvailable'], 1);
    assert.equal(summary['lowConfidence'], 1);
    assert.equal(summary['stale'], 1);

    // Every state is present so a consumer can index the histogram blind.
    const byState = summary['byState'] as Record<string, number>;
    for (const state of Object.keys(STATE_SEVERITY)) {
      assert.equal(typeof byState[state], 'number', `byState is missing "${state}"`);
    }
    assert.equal(byState['abandoned'], 1);
    assert.equal(byState['low-activity'], 1);
  });

  test('timestamps are ISO-8601 UTC or null, never anything else', () => {
    const odd = scanResult({
      findings: [
        finding({
          dependency: dependency({ name: 'odd' }),
          assessment: assessment({
            name: 'odd',
            evidence: [evidence({ observedAt: 'the day before yesterday' })],
            signals: signals({
              name: 'odd',
              latestReleaseAt: 'Tue, 01 Feb 2022 10:00:00 GMT',
              repoPushedAt: 'nonsense',
            }),
          }),
        }),
      ],
    });

    const doc = parse(renderJson(odd));
    const first = (doc['findings'] as Array<Record<string, unknown>>)[0];
    const sig = first?.['signals'] as Record<string, unknown>;

    assert.equal(sig['latestReleaseAt'], '2022-02-01T10:00:00.000Z');
    assert.equal(sig['repoPushedAt'], null);
    assert.equal(
      ((first?.['evidence'] as Array<Record<string, unknown>>)[0] ?? {})['observedAt'],
      null,
    );
  });

  test('an empty scan still renders a usable document', () => {
    const doc = parse(renderJson(scanResult({ findings: [], examined: 0 })));
    assert.deepEqual(doc['findings'], []);
    assert.equal((doc['summary'] as Record<string, unknown>)['worstState'], null);
    assert.equal((doc['summary'] as Record<string, unknown>)['worstSeverity'], 0);
  });

  test('a finding with no curated successor emits null, not a stub', () => {
    const doc = parse(renderJson(RESULT));
    const findings = doc['findings'] as Array<Record<string, unknown>>;
    assert.equal(findings[1]?.['successor'], null);

    const record = findings[0]?.['successor'] as Record<string, unknown>;
    assert.equal(record['to'], 'dead-thing-ng');
    assert.equal(record['dropIn'], true);
  });
});

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

describe('renderTerminal', () => {
  let previousTerm: string | undefined;

  before(() => {
    previousTerm = process.env['TERM'];
    // Pin the glyph set so these assertions do not depend on the CI terminal.
    process.env['TERM'] = 'xterm-256color';
  });

  after(() => {
    if (previousTerm === undefined) delete process.env['TERM'];
    else process.env['TERM'] = previousTerm;
  });

  test('{ color: false } emits no escape sequences at all', () => {
    const text = renderTerminal(RESULT, { color: false });

    assert.doesNotMatch(text, ANSI_PATTERN);
    assert.equal(text.includes(ESC), false, 'a bare escape byte leaked into the plain output');
  });

  test('{ color: true } does emit them, so the plain check means something', () => {
    const text = renderTerminal(RESULT, { color: true });
    assert.match(text, ANSI_PATTERN);
  });

  test('a plain render is otherwise the same report as a coloured one', () => {
    const plain = renderTerminal(RESULT, { color: false });
    const stripped = renderTerminal(RESULT, { color: true }).replace(
      new RegExp(`${ESC}\\[[0-9;]*m`, 'g'),
      '',
    );
    assert.equal(stripped.includes('dead-thing'), plain.includes('dead-thing'));
    assert.equal(stripped.includes('ABANDONED'), plain.includes('ABANDONED'));
  });

  test('evidence is truncated to the display limit', () => {
    const text = renderTerminal(
      scanResult({ findings: [abandoned('dead-thing')], examined: 5 }),
      { color: false },
    );

    const shown = MANY_EVIDENCE.filter((item) => text.includes(item.label.split(' ')[0] ?? ''));
    assert.equal(shown.length, 3, `expected 3 evidence lines, saw ${shown.length}`);
    assert.ok(text.includes('EVIDENCE-0'));
    assert.equal(text.includes('EVIDENCE-3'), false, 'the fourth line should have been dropped');
  });

  test('evidence URLs are never wrapped', () => {
    const url = 'https://example.com/evidence/0';
    const text = renderTerminal(
      scanResult({ findings: [abandoned('dead-thing')], examined: 5 }),
      { color: false },
    );
    assert.ok(
      text.split('\n').some((line) => line.includes(url)),
      'a split URL stops being clickable',
    );
  });

  test('warnings are truncated, and the remainder is counted', () => {
    const text = renderTerminal(
      scanResult({
        findings: [abandoned('dead-thing')],
        examined: 5,
        warnings: ['w-one', 'w-two', 'w-three', 'w-four', 'w-five'],
      }),
      { color: false },
    );

    assert.ok(text.includes('w-one') && text.includes('w-three'));
    assert.equal(text.includes('w-four'), false);
    assert.match(text, /and 2 more warnings/);
  });

  test('findings are ordered worst first', () => {
    const text = renderTerminal(RESULT, { color: false });
    assert.ok(
      text.indexOf('dead-thing') < text.indexOf('quiet-thing'),
      'the worst finding has to come first',
    );
  });

  test('a clean scan says so instead of printing an empty list', () => {
    const text = renderTerminal(scanResult({ findings: [], examined: 24 }), { color: false });

    assert.match(text, /Nothing here looks abandoned/);
    assert.match(text, /24 dependencies/);
    assert.doesNotMatch(text, ANSI_PATTERN);
  });

  test('the successor and its migration hint are shown', () => {
    const text = renderTerminal(
      scanResult({ findings: [abandoned('dead-thing')], examined: 5 }),
      { color: false },
    );

    assert.match(text, /dead-thing-ng/);
    assert.match(text, /drop-in swap/);
    assert.match(text, /Change the import/);
    assert.match(text, /alternatives: other-example/);
  });

  test('a successor that is a platform feature is not offered as a swap', () => {
    const platform = finding({
      dependency: dependency({ name: 'left-pad' }),
      assessment: assessment({ name: 'left-pad', state: 'deprecated', score: 75 }),
      successor: successor({
        from: 'left-pad',
        to: 'String.prototype.padStart',
        toKind: 'platform',
        type: 'absorbed',
        dropIn: false,
        alternatives: [],
        migration: 'Delete the dependency and call padStart directly.',
      }),
    });

    const text = renderTerminal(scanResult({ findings: [platform], examined: 5 }), {
      color: false,
    });
    assert.match(text, /String\.prototype\.padStart/);
    assert.equal(text.includes('drop-in swap'), false);
  });

  test('a finding with no successor still tells the reader what to do', () => {
    const text = renderTerminal(
      scanResult({ findings: [lowActivity('quiet-thing')], examined: 5 }),
      { color: false },
    );
    assert.match(text, /No curated successor/);
  });

  test('the transitive/dev scope of a finding is visible', () => {
    const text = renderTerminal(
      scanResult({ findings: [lowActivity('quiet-thing')], examined: 5 }),
      { color: false },
    );
    assert.match(text, /\(transitive dev\)/);
  });

  test('low confidence explains itself', () => {
    const text = renderTerminal(
      scanResult({ findings: [lowActivity('quiet-thing')], examined: 5 }),
      { color: false },
    );
    assert.match(text, /confidence/);
    assert.match(text, /stale|could not be read/);
  });

  test('TERM=dumb falls back to ASCII, still with no escapes', () => {
    const previous = process.env['TERM'];
    process.env['TERM'] = 'dumb';
    try {
      const text = renderTerminal(RESULT, { color: false });
      assert.doesNotMatch(text, ANSI_PATTERN);
      // The scorer writes typographic punctuation; ASCII mode has to clean up
      // prose it did not author.
      for (const char of ['—', '…', '→', '●', '│']) {
        assert.equal(text.includes(char), false, `"${char}" survived into ASCII output`);
      }
    } finally {
      if (previous === undefined) delete process.env['TERM'];
      else process.env['TERM'] = previous;
    }
  });
});
