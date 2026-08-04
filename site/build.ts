/**
 * Static site generator for https://mekkadev.github.io/dead-deps/
 *
 * Turns `data/successors.yaml` into the project's public surface: a landing
 * page with the full index, one page per dataset row, a methodology page,
 * sitemap and robots.txt. No framework, no client-side rendering, no external
 * requests — everything a crawler needs is in the HTML it is served.
 *
 *   npm run site        # -> site/dist/
 *
 * The dataset is hand-edited and may be mid-write when this runs, so loading is
 * deliberately forgiving: bad rows are skipped with a warning and a missing or
 * empty file still produces the landing and methodology pages. Failing the
 * build over a half-saved YAML file would be the wrong trade.
 */

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import type {
  Confidence,
  SuccessionType,
  SuccessorEvidence,
  SuccessorKind,
  SuccessorRecord,
} from '../src/types.js';

import { esc, plain, safeUrl } from './templates/html.js';
import { renderLandingPage } from './templates/landing.js';
import { renderPage, type SiteContext } from './templates/layout.js';
import { renderMethodologyPage } from './templates/methodology.js';
import { renderNotFoundPage } from './templates/not-found.js';
import { renderPackagePage, type RenderedPage } from './templates/package.js';
import type { PageRecord } from './templates/record.js';
import { STYLESHEET } from './templates/style.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DATASET = process.env.DEAD_DEPS_DATASET ?? join(ROOT, 'data', 'successors.yaml');
const OUT_DIR = process.env.DEAD_DEPS_SITE_OUT ?? join(HERE, 'dist');

/** Override for previewing the site under a different origin or sub-path. */
const BASE_URL = withTrailingSlash(process.env.DEAD_DEPS_SITE_URL ?? 'https://mekkadev.github.io/dead-deps/');

const REPO_URL = 'https://github.com/mekkadev/dead-deps';
const NPM_URL = 'https://www.npmjs.com/package/dead-deps';

const SUCCESSION_TYPES = new Set<string>([
  'fork',
  'rename',
  'replacement',
  'absorbed',
  'self-declared',
  'reimplementation',
]);
const CONFIDENCES = new Set<string>(['high', 'medium', 'low']);
const SUCCESSOR_KINDS = new Set<string>(['package', 'platform', 'none']);

/** Looks like an installable npm name, used to derive `toKind` when absent. */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

// ---------------------------------------------------------------------------
// Dataset loading
// ---------------------------------------------------------------------------

interface LoadedDataset {
  records: SuccessorRecord[];
  warnings: string[];
  /** Mtime of the dataset as YYYY-MM-DD, or null when it does not exist. */
  modified: string | null;
}

async function loadDataset(path: string): Promise<LoadedDataset> {
  const warnings: string[] = [];

  let raw: string;
  let modified: string | null = null;
  try {
    raw = await readFile(path, 'utf8');
    const info = await stat(path);
    modified = isoDate(info.mtime);
  } catch (error) {
    const code = (error as { code?: string }).code;
    warnings.push(
      code === 'ENOENT'
        ? `${path} does not exist yet — building the landing and methodology pages only.`
        : `could not read ${path}: ${String(error)}`,
    );
    return { records: [], warnings, modified: null };
  }

  if (raw.trim() === '') {
    warnings.push(`${path} is empty — building the landing and methodology pages only.`);
    return { records: [], warnings, modified };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    warnings.push(`${path} is not valid YAML yet (${errorLine(error)}) — skipping package pages.`);
    return { records: [], warnings, modified };
  }

  if (parsed === null || parsed === undefined) {
    warnings.push(`${path} contains no rows — building the landing and methodology pages only.`);
    return { records: [], warnings, modified };
  }
  if (!Array.isArray(parsed)) {
    warnings.push(`${path} should hold a list of rows — skipping package pages.`);
    return { records: [], warnings, modified };
  }

  const records: SuccessorRecord[] = [];
  const seen = new Set<string>();

  parsed.forEach((row, index) => {
    const record = coerceRecord(row, index, warnings);
    if (record === null) return;
    const key = record.from.toLowerCase();
    if (seen.has(key)) {
      warnings.push(`row ${index + 1}: duplicate \`from\` "${record.from}" — keeping the first.`);
      return;
    }
    seen.add(key);
    records.push(record);
  });

  records.sort((a, b) => a.from.localeCompare(b.from, 'en'));
  return { records, warnings, modified };
}

/**
 * Turn one YAML row into a record, or null if it is too broken to publish.
 * Only `from` is truly required: a page with a missing migration hint is still
 * worth serving, a page with no package name is not.
 */
function coerceRecord(row: unknown, index: number, warnings: string[]): SuccessorRecord | null {
  const where = `row ${index + 1}`;
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    warnings.push(`${where}: not a mapping — skipped.`);
    return null;
  }
  const source = row as Record<string, unknown>;

  const from = typeof source['from'] === 'string' ? source['from'].trim() : '';
  if (from === '') {
    warnings.push(`${where}: missing \`from\` — skipped.`);
    return null;
  }

  const rawTo = source['to'];
  const to = typeof rawTo === 'string' && rawTo.trim() !== '' ? rawTo.trim() : null;

  const rawKind = source['toKind'];
  let toKind: SuccessorKind;
  if (typeof rawKind === 'string' && SUCCESSOR_KINDS.has(rawKind)) {
    toKind = rawKind as SuccessorKind;
  } else {
    toKind = to === null ? 'none' : NPM_NAME.test(to) ? 'package' : 'platform';
    if (rawKind !== undefined && rawKind !== null) {
      warnings.push(`${where} (${from}): unknown \`toKind\` — treated as "${toKind}".`);
    }
  }
  if (to === null && toKind !== 'none') {
    warnings.push(`${where} (${from}): \`to\` is empty but \`toKind\` is "${toKind}" — treated as "none".`);
    toKind = 'none';
  }

  const rawType = source['type'];
  let type: SuccessionType = 'replacement';
  if (typeof rawType === 'string' && SUCCESSION_TYPES.has(rawType)) {
    type = rawType as SuccessionType;
  } else {
    warnings.push(`${where} (${from}): missing or unknown \`type\` — treated as "replacement".`);
  }

  const rawConfidence = source['confidence'];
  let confidence: Confidence = 'medium';
  if (typeof rawConfidence === 'string' && CONFIDENCES.has(rawConfidence)) {
    confidence = rawConfidence as Confidence;
  } else {
    warnings.push(`${where} (${from}): missing or unknown \`confidence\` — treated as "medium".`);
  }

  const rawSince = source['since'];
  const since =
    typeof rawSince === 'string' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(rawSince.trim()) ? rawSince.trim() : null;
  if (rawSince !== undefined && rawSince !== null && since === null) {
    warnings.push(`${where} (${from}): \`since\` is not YYYY-MM — omitted from the page.`);
  }

  const dropIn = source['dropIn'] === true && toKind === 'package';

  const alternatives = Array.isArray(source['alternatives'])
    ? source['alternatives']
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item !== '')
    : [];

  const notes = typeof source['notes'] === 'string' ? source['notes'].trim() : '';
  if (notes === '') warnings.push(`${where} (${from}): no \`notes\` — the page will be thin.`);

  const rawMigration = source['migration'];
  const migration = typeof rawMigration === 'string' && rawMigration.trim() !== '' ? rawMigration.trim() : null;

  const evidence: SuccessorEvidence[] = Array.isArray(source['evidence'])
    ? source['evidence'].flatMap((item): SuccessorEvidence[] => {
        if (typeof item !== 'object' || item === null) return [];
        const entry = item as Record<string, unknown>;
        const label = typeof entry['label'] === 'string' ? entry['label'].trim() : '';
        const url = safeUrl(typeof entry['url'] === 'string' ? entry['url'] : null);
        if (label === '' || url === null) return [];
        return [{ label, url }];
      })
    : [];
  if (evidence.length === 0) warnings.push(`${where} (${from}): no usable evidence links.`);

  return { from, to, toKind, type, confidence, since, dropIn, alternatives, notes, migration, evidence };
}

// ---------------------------------------------------------------------------
// Slugs and relationships
// ---------------------------------------------------------------------------

/** `@angular/http` -> `angular-http`, `popper.js` -> `popper.js`. */
function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug === '' ? 'package' : slug;
}

function buildPages(records: readonly SuccessorRecord[], warnings: string[]): PageRecord[] {
  const used = new Set<string>();
  return records.map((record) => {
    let slug = slugify(record.from);
    if (used.has(slug)) {
      let suffix = 2;
      while (used.has(`${slug}-${suffix}`)) suffix += 1;
      warnings.push(`"${record.from}" collides with an existing slug — published as ${slug}-${suffix}.`);
      slug = `${slug}-${suffix}`;
    }
    used.add(slug);
    return { record, slug, path: `p/${slug}/` };
  });
}

const STOP_TOKENS = new Set(['js', 'node', 'npm', 'the', 'package', 'plugin', 'core', 'lib']);

function tokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/^@/, '')
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 1 && !STOP_TOKENS.has(token)),
  );
}

/**
 * 3–5 genuinely related pages: same successor, shared alternatives, the same
 * kind of succession, or a shared name stem (`request` / `request-promise`).
 * Alphabetical neighbours pad the list out so no page is a dead end.
 */
function relatedPages(page: PageRecord, all: readonly PageRecord[]): PageRecord[] {
  const self = page.record;
  const selfTokens = tokens(self.from);
  const selfAlternatives = new Set(self.alternatives.map((item) => item.toLowerCase()));
  const selfTo = (self.to ?? '').toLowerCase();

  const scored = all
    .filter((other) => other.slug !== page.slug)
    .map((other) => {
      const record = other.record;
      const otherTo = (record.to ?? '').toLowerCase();
      let score = 0;

      if (selfTo !== '' && selfTo === otherTo) score += 5;
      if (selfTo !== '' && record.alternatives.some((item) => item.toLowerCase() === selfTo)) score += 3;
      if (otherTo !== '' && selfAlternatives.has(otherTo)) score += 3;

      const sharedAlternatives = record.alternatives.filter((item) => selfAlternatives.has(item.toLowerCase())).length;
      score += Math.min(sharedAlternatives, 2) * 2;

      let sharedTokens = 0;
      for (const token of tokens(record.from)) if (selfTokens.has(token)) sharedTokens += 1;
      score += Math.min(sharedTokens, 2) * 3;

      if (record.type === self.type) score += 2;
      if (record.toKind === self.toKind) score += 1;
      if (self.since !== null && record.since !== null && self.since.slice(0, 4) === record.since.slice(0, 4)) {
        score += 1;
      }

      return { page: other, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.page.record.from.localeCompare(b.page.record.from, 'en'))
    .slice(0, 5)
    .map((entry) => entry.page);

  if (scored.length >= 3) return scored;

  const index = all.findIndex((other) => other.slug === page.slug);
  const chosen = new Set(scored.map((item) => item.slug));
  for (let distance = 1; distance < all.length && scored.length < 4; distance += 1) {
    for (const candidate of [all[index + distance], all[index - distance]]) {
      if (candidate === undefined || candidate.slug === page.slug || chosen.has(candidate.slug)) continue;
      if (scored.length >= 4) break;
      chosen.add(candidate.slug);
      scored.push(candidate);
    }
  }
  return scored;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

interface WrittenFile {
  /** Path relative to the output directory. */
  path: string;
  bytes: number;
}

async function emit(files: WrittenFile[], relativePath: string, contents: string): Promise<void> {
  const target = join(OUT_DIR, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
  files.push({ path: relativePath, bytes: Buffer.byteLength(contents, 'utf8') });
}

function sitemap(site: SiteContext, paths: readonly string[], lastmod: string): string {
  const entries = paths
    .map((path) => {
      const priority = path === '' ? '1.0' : path === 'methodology/' ? '0.8' : '0.7';
      return `  <url>\n    <loc>${esc(site.baseUrl + path)}</loc>\n    <lastmod>${esc(
        lastmod,
      )}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

function robots(site: SiteContext): string {
  return [
    '# https://www.robotstxt.org/robotstxt.html',
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${site.baseUrl}sitemap.xml`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const started = Date.now();
  const { records, warnings, modified } = await loadDataset(DATASET);

  const pages = buildPages(records, warnings);
  const byName = new Map<string, PageRecord>();
  for (const page of pages) byName.set(page.record.from.toLowerCase(), page);

  const buildDate = isoDate(new Date());
  const site: SiteContext = {
    baseUrl: BASE_URL,
    basePath: new URL(BASE_URL).pathname,
    name: 'dead-deps',
    tagline: 'what happened to your dependencies',
    repoUrl: REPO_URL,
    npmUrl: NPM_URL,
    packageCount: pages.length,
    buildDate,
  };

  const written: WrittenFile[] = [];
  const write = async (relativePath: string, rendered: RenderedPage): Promise<void> => {
    await emit(written, relativePath, renderPage(site, rendered.meta, rendered.body, STYLESHEET));
  };

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  await write('index.html', renderLandingPage(site, pages));
  await write('methodology/index.html', renderMethodologyPage(site, pages));
  await write('404.html', renderNotFoundPage(site));

  for (const page of pages) {
    await write(`${page.path}index.html`, renderPackagePage(site, page, relatedPages(page, pages), byName));
  }

  const urls = ['', 'methodology/', ...pages.map((page) => page.path)];
  await emit(written, 'sitemap.xml', sitemap(site, urls, modified ?? buildDate));
  await emit(written, 'robots.txt', robots(site));
  await emit(written, '.nojekyll', '');

  for (const warning of warnings) process.stderr.write(`  warn  ${warning}\n`);

  const bytes = written.reduce((total, file) => total + file.bytes, 0);
  process.stdout.write(
    `dead-deps site: ${written.length} files, ${pages.length} package pages, ${(bytes / 1024).toFixed(
      0,
    )} kB -> ${OUT_DIR} (${Date.now() - started} ms)\n`,
  );
  if (pages.length === 0) {
    process.stdout.write('  no dataset rows yet; landing and methodology pages were still generated.\n');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function errorLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return plain(message.split('\n')[0] ?? message);
}

main().catch((error: unknown) => {
  process.stderr.write(`dead-deps site: build failed — ${errorLine(error)}\n`);
  if (process.env.DEAD_DEPS_DEBUG && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 1;
});
