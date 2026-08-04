/**
 * Renders a terminal session as a self-contained animated SVG.
 *
 * A GIF of a terminal is a few megabytes of blurry pixels that cannot be
 * diffed and goes stale the moment the output changes. This takes the real
 * captured output, colours it by pattern, and emits vector text that stays
 * crisp at any zoom and weighs about as much as this file.
 *
 * The animation degrades honestly: every line's resting state is *visible*,
 * and the keyframes animate it in. If a renderer drops CSS animation — some
 * image proxies do — the reader sees the finished frame rather than a blank
 * box.
 *
 *   node --import tsx scripts/demo-svg.ts < session.txt > docs/demo.svg
 *   node --import tsx scripts/demo-svg.ts --record          (runs a live scan)
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Look
// ---------------------------------------------------------------------------

const CHAR_W = 7.8;
const LINE_H = 19;
const FONT_SIZE = 13;
const PAD_X = 22;
const PAD_Y = 20;
const RADIUS = 10;

const COLOR = {
  bg: '#0d1117',
  border: '#21262d',
  text: '#c9d1d9',
  dim: '#6e7681',
  rule: '#21262d',
  prompt: '#57606a',
  danger: '#f85149',
  warn: '#d29922',
  good: '#3fb950',
  link: '#58a6ff',
  accent: '#a371f7',
} as const;

const COMMAND = 'npx dead-deps';

/** Typing speed and the gap before output starts, in seconds. */
const TYPE_DURATION = 0.9;
const OUTPUT_START = TYPE_DURATION + 0.35;
const LINE_STAGGER = 0.045;
const HOLD = 4.5;

// ---------------------------------------------------------------------------
// Colouring
// ---------------------------------------------------------------------------

interface Span {
  text: string;
  fill: string;
}

const STATE_COLOURS: Array<[RegExp, string]> = [
  [/^\s*HIJACK RISK\b/, COLOR.danger],
  [/^\s*ABANDONED\b/, COLOR.danger],
  [/^\s*DEPRECATED\b/, COLOR.warn],
  [/^\s*UNMAINTAINED\b/, COLOR.warn],
  [/^\s*LOW ACTIVITY\b/, COLOR.dim],
];

/**
 * Splits one line into coloured spans.
 *
 * Pattern-based rather than ANSI-based on purpose: the capture is taken with
 * --no-color so the text stays readable in the repository, and the palette
 * here is chosen for a small embedded image rather than inherited from
 * whatever theme happened to be active when the session was recorded.
 */
function colourise(line: string): Span[] {
  // A heading line: STATE name version ... score n/100
  for (const [pattern, fill] of STATE_COLOURS) {
    const match = pattern.exec(line);
    if (match === null) continue;
    const label = match[0];
    const rest = line.slice(label.length);
    const score = /\s{2,}score \d+\/100\s*$/.exec(rest);
    if (score === null) return [{ text: label, fill }, { text: rest, fill: COLOR.text }];
    return [
      { text: label, fill },
      { text: rest.slice(0, score.index), fill: COLOR.text },
      { text: score[0], fill: COLOR.dim },
    ];
  }

  if (/^\s*[─]+\s*$/.test(line)) return [{ text: line, fill: COLOR.rule }];

  // The successor block is the payoff; give it the one bright accent.
  const successor = /^(\s*)(→ )(\S+)(.*)$/.exec(line);
  if (successor !== null) {
    return [
      { text: successor[1] ?? '', fill: COLOR.text },
      { text: successor[2] ?? '', fill: COLOR.good },
      { text: successor[3] ?? '', fill: COLOR.good },
      { text: successor[4] ?? '', fill: COLOR.dim },
    ];
  }

  // Evidence URLs.
  const link = /^(\s*[│├└]?\s*↳\s*)(\S+)(.*)$/.exec(line);
  if (link !== null) {
    return [
      { text: link[1] ?? '', fill: COLOR.rule },
      { text: link[2] ?? '', fill: COLOR.link },
      { text: link[3] ?? '', fill: COLOR.dim },
    ];
  }

  // Tree glyphs stay quiet so the prose reads first.
  const tree = /^(\s*[├└│][─\s]*)(.*)$/.exec(line);
  if (tree !== null) {
    return [
      { text: tree[1] ?? '', fill: COLOR.rule },
      { text: tree[2] ?? '', fill: COLOR.text },
    ];
  }

  if (/^\s*confidence /.test(line)) return [{ text: line, fill: COLOR.dim }];
  if (/^\s*(alternatives:|data may be stale)/.test(line)) {
    return [{ text: line, fill: COLOR.dim }];
  }
  if (/^\s*dead-deps\s+·/.test(line)) return [{ text: line, fill: COLOR.accent }];
  if (/dependencies (examined|need attention)|flagged|deliberately not flagged/.test(line)) {
    return [{ text: line, fill: COLOR.dim }];
  }

  return [{ text: line, fill: COLOR.text }];
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Preserves runs of spaces, which collapse in SVG text otherwise. */
function spanMarkup(spans: readonly Span[]): string {
  return spans
    .filter((span) => span.text !== '')
    .map((span) => `<tspan fill="${span.fill}" xml:space="preserve">${escapeXml(span.text)}</tspan>`)
    .join('');
}

export function renderDemoSvg(session: string): string {
  const lines = session.replace(/\s+$/, '').split('\n');
  const columns = Math.max(COMMAND.length + 2, ...lines.map((line) => line.length));
  const width = Math.round(columns * CHAR_W + PAD_X * 2);
  const height = Math.round((lines.length + 2) * LINE_H + PAD_Y * 2);
  const total = OUTPUT_START + lines.length * LINE_STAGGER + HOLD;

  const promptY = PAD_Y + LINE_H;
  const commandX = PAD_X + CHAR_W * 2;
  const commandW = COMMAND.length * CHAR_W;

  const body = lines
    .map((line, index) => {
      const y = promptY + LINE_H * (index + 2);
      const delay = (OUTPUT_START + index * LINE_STAGGER).toFixed(3);
      return `<text class="ln" style="animation-delay:${delay}s" x="${PAD_X}" y="${y}">${spanMarkup(colourise(line))}</text>`;
    })
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="dead-deps scanning a project: request is reported as a hijack risk with evidence, and undici is named as its successor">
<title>npx dead-deps</title>
<style>
  .t { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace; font-size: ${FONT_SIZE}px; }
  /* Resting state is the finished frame: if animation is dropped, the
     reader still sees the whole session instead of an empty panel. */
  .ln { opacity: 1; animation: reveal ${total}s steps(1, end) infinite; }
  @keyframes reveal { 0% { opacity: 0 } 100% { opacity: 1 } }
  .cmd-clip rect { animation: type ${total}s linear infinite; }
  @keyframes type {
    0% { width: 0 }
    ${((TYPE_DURATION / total) * 100).toFixed(2)}% { width: ${commandW}px }
    100% { width: ${commandW}px }
  }
  .cursor { animation: blink 1s steps(1, end) infinite; }
  @keyframes blink { 0%, 50% { opacity: 1 } 50.01%, 100% { opacity: 0 } }
  @media (prefers-reduced-motion: reduce) {
    .ln, .cmd-clip rect, .cursor { animation: none }
    .cmd-clip rect { width: ${commandW}px }
  }
</style>
<rect width="${width}" height="${height}" rx="${RADIUS}" fill="${COLOR.bg}"/>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="${RADIUS}" fill="none" stroke="${COLOR.border}"/>
<g class="t">
  <text x="${PAD_X}" y="${promptY}" fill="${COLOR.prompt}">$</text>
  <clipPath id="cmd" class="cmd-clip"><rect x="${commandX}" y="${promptY - FONT_SIZE}" width="${commandW}" height="${LINE_H}"/></clipPath>
  <text x="${commandX}" y="${promptY}" fill="${COLOR.text}" clip-path="url(#cmd)" xml:space="preserve">${escapeXml(COMMAND)}</text>
  <rect class="cursor" x="${(commandX + commandW + 2).toFixed(1)}" y="${promptY - FONT_SIZE + 1}" width="${CHAR_W.toFixed(1)}" height="${FONT_SIZE + 2}" fill="${COLOR.prompt}"/>
${body}
</g>
</svg>
`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main(): void {
  const out = resolve(ROOT, 'docs/demo.svg');
  const fromFile = process.argv[2];
  const session =
    fromFile !== undefined && fromFile !== '--stdin'
      ? readFileSync(resolve(fromFile), 'utf8')
      : readFileSync(0, 'utf8');

  if (session.trim() === '') {
    console.error('demo-svg: no session on stdin. Pipe a captured `dead-deps` run in.');
    process.exit(1);
  }

  mkdirSync(dirname(out), { recursive: true });
  const svg = renderDemoSvg(session);
  writeFileSync(out, svg);
  console.log(`demo-svg: ${out} (${(svg.length / 1024).toFixed(1)} kB)`);
}

if (process.argv[1] !== undefined && import.meta.url.endsWith('demo-svg.ts')) {
  main();
}

export { execFileSync };
