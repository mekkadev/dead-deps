/**
 * Publishes the curated succession dataset as a machine-readable API.
 *
 * The point of this file is to make dead-deps an *upstream*. Renovate, Socket,
 * Dependabot dashboards, internal platform tooling — none of them need to build
 * their own "what replaced this package" list, and none of them will adopt one
 * they have to scrape out of HTML. So the same rows that render the website are
 * emitted as three static files under `api/`:
 *
 *   api/successors.json      pretty, for humans and diffs
 *   api/successors.min.json  identical payload, no whitespace, for machines
 *   api/index.json           manifest: what these files are, the schema, the
 *                            licence, the row count and the URLs
 *
 * Two shape rules make the output safe to poll and safe to diff:
 *
 *   1. Records are sorted by `from`, always, with a codepoint tiebreak so the
 *      order does not drift with the locale of whoever ran the build.
 *   2. No record carries a timestamp. The only clock in the payload is the
 *      top-level `generatedAt`, and even that is taken from the dataset file's
 *      mtime rather than the build clock — so rebuilding unchanged data
 *      produces byte-identical files, and a consumer that stores `sha256` can
 *      tell "nothing changed" from "not fetched yet".
 *
 * `npm run site` calls `exportDataset()` directly. The script also runs on its
 * own, against `data/successors.yaml`, for previewing the API without a site
 * build:
 *
 *   node --import tsx scripts/export-dataset.ts [--out <dir>] [--base-url <url>]
 */

import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadSuccessors } from '../src/successors/index.js';
import { EXIT } from '../src/types.js';
import type { SuccessorRecord } from '../src/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Bumped only when a consumer would break: a removed field, a renamed field, a
 * changed meaning. Adding a field is not a break and does not bump this.
 */
export const DATASET_SCHEMA_VERSION = 1;

/** Sub-directory of the site output that holds the API. */
export const API_DIR = 'api';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const DEFAULT_BASE_URL = 'https://mekkadev.github.io/dead-deps/';
const REPO_URL = 'https://github.com/mekkadev/dead-deps';
const SCHEMA_DOC_URL = `${REPO_URL}/blob/main/data/SCHEMA.md`;
const CONTRIBUTE_URL = `${REPO_URL}/blob/main/CONTRIBUTING.md`;
const ISSUES_URL = `${REPO_URL}/issues`;

const DATASET_LICENSE = {
  spdx: 'CC-BY-4.0',
  name: 'Creative Commons Attribution 4.0 International',
  url: 'https://creativecommons.org/licenses/by/4.0/',
} as const;

const CODE_LICENSE = {
  spdx: 'MIT',
  name: 'MIT License',
  url: `${REPO_URL}/blob/main/LICENSE`,
} as const;

/**
 * The one string a consumer has to reproduce to satisfy CC-BY. Spelling it out
 * is cheaper for everybody than making them compose it from three fields.
 */
const ATTRIBUTION = `dead-deps succession dataset (${DEFAULT_BASE_URL}), CC BY 4.0`;

/** Mirrors `slugify` in site/build.ts; see `pageUrl` for why a copy is fine. */
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

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface DatasetExportOptions {
  /** Rows to publish. Order does not matter; they are sorted by `from`. */
  records: readonly SuccessorRecord[];
  /** Site output directory. Files land in `<outDir>/api/`. */
  outDir: string;
  /** Absolute origin + sub-path the site is served from. */
  baseUrl?: string;
  /**
   * Absolute URL of the human-readable page for a record.
   *
   * The site knows its own slugs, including the suffix it appends when two
   * names collide, so it passes them in. Standalone runs fall back to the
   * mirrored `slugify`, which agrees with the site for every non-colliding
   * name — which is all of them, since a collision is a build warning.
   */
  pageUrl?: (record: SuccessorRecord) => string | null;
  /** File whose mtime dates the export. Usually `data/successors.yaml`. */
  sourcePath?: string;
  /** Overrides both `sourcePath` and the clock. ISO 8601. */
  generatedAt?: string;
}

export interface ExportedFile {
  /** Path relative to the site output directory. */
  path: string;
  /** Absolute URL the file will have once published. */
  url: string;
  bytes: number;
  sha256: string;
}

export interface DatasetExport {
  files: ExportedFile[];
  count: number;
  generatedAt: string;
}

/** One published row: the dataset's fields, plus a link to its page. */
interface ApiRecord {
  from: string;
  to: string | null;
  toKind: string;
  type: string;
  confidence: string;
  since: string | null;
  dropIn: boolean;
  alternatives: string[];
  notes: string;
  migration: string | null;
  evidence: { label: string; url: string }[];
  /** Human-readable page for this row. Derived from `from`; never a timestamp. */
  url: string;
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/**
 * Field-by-field documentation, as data rather than prose, so a consumer can
 * render it, validate against it, or generate types from it without parsing
 * English. It restates `data/SCHEMA.md`, which stays the human source of truth.
 */
const RECORD_SCHEMA: Record<string, { type: string; nullable: boolean; values?: string[]; description: string }> = {
  from: {
    type: 'string',
    nullable: false,
    description: 'Exact npm package name that is dead, deprecated or superseded. Unique across the dataset; compare lowercased.',
  },
  to: {
    type: 'string',
    nullable: true,
    description: 'Primary recommended successor. An npm package name, a platform feature, or null when nothing credible succeeded it. Read `toKind` before installing it.',
  },
  toKind: {
    type: 'string',
    nullable: false,
    values: ['package', 'platform', 'bundled', 'none'],
    description: 'What `to` actually is. "package": install it. "platform": the runtime does this now, delete the dependency. "bundled": it ships inside a package you already have. "none": no successor.',
  },
  type: {
    type: 'string',
    nullable: false,
    values: ['fork', 'rename', 'replacement', 'absorbed', 'self-declared', 'reimplementation'],
    description: 'How the successor relates to the original.',
  },
  confidence: {
    type: 'string',
    nullable: false,
    values: ['high', 'medium', 'low'],
    description: 'How settled the succession is. "low" means credible people still disagree; treat `alternatives` as equally valid there.',
  },
  since: {
    type: 'string',
    nullable: true,
    description: 'Approximate month the `from` package stopped being maintained, as YYYY-MM. Null when it cannot be dated.',
  },
  dropIn: {
    type: 'boolean',
    nullable: false,
    description: 'True when the successor is API-compatible enough to swap directly. Always false unless `toKind` is "package".',
  },
  alternatives: {
    type: 'string[]',
    nullable: false,
    description: 'Other credible successors, in no particular order. May be empty.',
  },
  notes: {
    type: 'string',
    nullable: false,
    description: 'Two or three sentences of plain prose explaining the succession. Safe to show a user verbatim.',
  },
  migration: {
    type: 'string',
    nullable: true,
    description: 'One concrete migration hint: an import change, a codemod, a flag. Null when there is no single useful hint.',
  },
  evidence: {
    type: '{ label: string, url: string }[]',
    nullable: false,
    description: 'Human-checkable primary sources. At least one per row: a deprecation notice, a maintainer statement, an archived repository, a migration guide.',
  },
  url: {
    type: 'string',
    nullable: false,
    description: 'Page for this row on the dead-deps site. Added by the export; not part of the YAML source.',
  },
};

function compareByFrom(a: SuccessorRecord, b: SuccessorRecord): number {
  // Locale compare reads correctly for humans; the codepoint tiebreak keeps the
  // order identical on machines whose ICU data disagrees about ties.
  const collated = a.from.localeCompare(b.from, 'en');
  if (collated !== 0) return collated;
  return a.from < b.from ? -1 : a.from > b.from ? 1 : 0;
}

/** Explicit key order: JSON diffs are part of the contract. */
function toApiRecord(record: SuccessorRecord, url: string): ApiRecord {
  return {
    from: record.from,
    to: record.to,
    toKind: record.toKind,
    type: record.type,
    confidence: record.confidence,
    since: record.since,
    dropIn: record.dropIn,
    alternatives: [...record.alternatives],
    notes: record.notes,
    migration: record.migration,
    evidence: record.evidence.map((item) => ({ label: item.label, url: item.url })),
    url,
  };
}

interface DatasetPayload {
  schemaVersion: number;
  generatedAt: string;
  count: number;
  license: string;
  attribution: string;
  documentation: string;
  records: ApiRecord[];
}

function datasetPayload(generatedAt: string, records: ApiRecord[], apiUrl: string): DatasetPayload {
  return {
    schemaVersion: DATASET_SCHEMA_VERSION,
    generatedAt,
    count: records.length,
    license: DATASET_LICENSE.spdx,
    attribution: ATTRIBUTION,
    documentation: `${apiUrl}index.json`,
    records,
  };
}

/**
 * The manifest. Everything a consumer needs to decide whether to use the data,
 * how to fetch it, and what they owe in return — expressed as fields, not
 * paragraphs, because the audience is a program as often as a person.
 */
function manifestPayload(
  generatedAt: string,
  count: number,
  baseUrl: string,
  apiUrl: string,
  files: readonly ExportedFile[],
): Record<string, unknown> {
  const [full, min] = files;
  return {
    name: 'dead-deps-successors',
    title: 'dead-deps succession dataset',
    description:
      'Curated, human-verified map from npm packages that stopped being maintained to whatever actually succeeded them: forks, renames, replacements, and the platform features that absorbed them.',
    schemaVersion: DATASET_SCHEMA_VERSION,
    generatedAt,
    count,
    homepage: baseUrl,
    repository: REPO_URL,
    documentation: SCHEMA_DOC_URL,
    issues: ISSUES_URL,
    contributing: CONTRIBUTE_URL,

    license: {
      dataset: {
        spdx: DATASET_LICENSE.spdx,
        name: DATASET_LICENSE.name,
        url: DATASET_LICENSE.url,
        appliesTo: 'the records in these files and in data/successors.yaml',
        attributionRequired: true,
        attribution: ATTRIBUTION,
      },
      code: {
        spdx: CODE_LICENSE.spdx,
        name: CODE_LICENSE.name,
        url: CODE_LICENSE.url,
        appliesTo: 'the dead-deps source code, not the dataset',
      },
    },

    files: [
      {
        name: 'successors.json',
        url: full?.url ?? `${apiUrl}successors.json`,
        contentType: 'application/json',
        bytes: full?.bytes ?? 0,
        sha256: full?.sha256 ?? '',
        description: 'Every record, indented for reading and diffing.',
      },
      {
        name: 'successors.min.json',
        url: min?.url ?? `${apiUrl}successors.min.json`,
        contentType: 'application/json',
        bytes: min?.bytes ?? 0,
        sha256: min?.sha256 ?? '',
        description: 'The same payload with no whitespace. Prefer this in production.',
      },
      {
        name: 'index.json',
        url: `${apiUrl}index.json`,
        contentType: 'application/json',
        bytes: null,
        sha256: null,
        description: 'This manifest.',
      },
    ],

    usingThisData: {
      summary:
        'Fetch one static JSON file, index it by `from`, and look up each dependency you care about. No key, no quota, no server.',
      recommendedFile: min?.url ?? `${apiUrl}successors.min.json`,
      transport: {
        method: 'GET',
        authentication: 'none',
        rateLimit: 'none; these are static files on GitHub Pages',
        cors: 'allowed — GitHub Pages serves these with access-control-allow-origin: *',
        compression: 'gzip and brotli, negotiated by the CDN',
      },
      lookup: {
        key: 'from',
        caseSensitive: false,
        advice: 'Lowercase both sides before comparing: npm names are case-insensitive in practice, the dataset stores them as published.',
        misses: 'A package absent from the dataset is not a claim that it is healthy — only that no succession has been verified for it.',
      },
      refresh: {
        cadence: 'daily is generous; the dataset changes a few times a month',
        changeDetection: 'compare `generatedAt`, or the `sha256` of the file you hold, against this manifest',
        rebuildTrigger: 'every push that touches data/successors.yaml',
      },
      stability: {
        recordsSortedBy: 'from',
        timestampsInRecords: false,
        rationale: 'Identical data produces byte-identical files, so a checksum is a reliable change signal.',
        compatibility: 'Fields may be added within a schemaVersion. Removing or renaming one bumps schemaVersion.',
        versioning: 'These URLs always serve the current schemaVersion. Pin by vendoring a copy, not by URL.',
      },
      obligations: [
        `Credit: ${ATTRIBUTION}`,
        'Link back to the record page (`url`) or the homepage where you show a recommendation.',
        'Do not present the data as verified by anyone other than dead-deps.',
      ],
      examples: {
        curl: `curl -sSL ${min?.url ?? `${apiUrl}successors.min.json`} | jq '.records[] | select(.from == "request")'`,
        javascript: `const { records } = await fetch(${JSON.stringify(min?.url ?? `${apiUrl}successors.min.json`)}).then((r) => r.json());\nconst byFrom = new Map(records.map((r) => [r.from.toLowerCase(), r]));\nbyFrom.get('request');`,
      },
      alsoAvailable: {
        cli: 'npx dead-deps — scans a lockfile and applies this dataset locally',
        mcp: 'npx dead-deps-mcp — the same lookups as MCP tools',
        source: `${REPO_URL}/blob/main/data/successors.yaml`,
      },
    },

    schema: {
      documentation: SCHEMA_DOC_URL,
      envelope: {
        schemaVersion: 'integer; bumped only on a breaking change',
        generatedAt: 'ISO 8601; the dataset’s last modification, not the build clock',
        count: 'integer; number of entries in `records`',
        license: `SPDX identifier for the records (${DATASET_LICENSE.spdx})`,
        attribution: 'the credit line to reproduce',
        documentation: 'URL of this manifest',
        records: 'array of records, sorted by `from`',
      },
      record: RECORD_SCHEMA,
    },

    inclusionRules: [
      'The `from` package is genuinely unmaintained, deprecated or superseded, and that is publicly documented.',
      'The succession is consensus, not opinion. Where reasonable engineers disagree, confidence is "low" and the candidates are listed under `alternatives`.',
      'At least one evidence link points at a primary source.',
      'Small finished packages that still work are deliberately excluded. Being quiet is not being abandoned.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * When the data was last touched, not when this ran.
 *
 * Using the build clock would rewrite `generatedAt` on every deploy, which
 * turns "did the data change?" into a question nobody downstream can answer
 * cheaply. The dataset's mtime is the honest answer, and on a fresh CI checkout
 * it degrades to the checkout time rather than to nonsense.
 */
async function resolveGeneratedAt(options: DatasetExportOptions): Promise<string> {
  if (options.generatedAt !== undefined && options.generatedAt !== '') return options.generatedAt;
  if (options.sourcePath !== undefined) {
    try {
      const info = await stat(options.sourcePath);
      return new Date(info.mtimeMs).toISOString();
    } catch {
      // Dataset missing or unreadable: the caller is publishing zero records and
      // the timestamp is the least of its problems. Fall through to the clock.
    }
  }
  return new Date().toISOString();
}

async function writeJson(
  outDir: string,
  apiUrl: string,
  name: string,
  contents: string,
): Promise<ExportedFile> {
  const relativePath = `${API_DIR}/${name}`;
  const target = join(outDir, API_DIR, name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
  return {
    path: relativePath,
    url: `${apiUrl}${name}`,
    bytes: Buffer.byteLength(contents, 'utf8'),
    sha256: sha256(contents),
  };
}

/**
 * Write `api/successors.json`, `api/successors.min.json` and `api/index.json`
 * into `outDir`. Returns what was written, so the caller can report it.
 */
export async function exportDataset(options: DatasetExportOptions): Promise<DatasetExport> {
  const baseUrl = withTrailingSlash(options.baseUrl ?? DEFAULT_BASE_URL);
  const apiUrl = `${baseUrl}${API_DIR}/`;
  const generatedAt = await resolveGeneratedAt(options);

  const sorted = [...options.records].sort(compareByFrom);
  const records = sorted.map((record) => {
    const url = options.pageUrl?.(record) ?? `${baseUrl}p/${slugify(record.from)}/`;
    return toApiRecord(record, url);
  });

  const payload = datasetPayload(generatedAt, records, apiUrl);
  const full = await writeJson(options.outDir, apiUrl, 'successors.json', `${JSON.stringify(payload, null, 2)}\n`);
  const min = await writeJson(options.outDir, apiUrl, 'successors.min.json', JSON.stringify(payload));

  const manifest = manifestPayload(generatedAt, records.length, baseUrl, apiUrl, [full, min]);
  const index = await writeJson(options.outDir, apiUrl, 'index.json', `${JSON.stringify(manifest, null, 2)}\n`);

  return { files: [full, min, index], count: records.length, generatedAt };
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

const USAGE = `dead-deps dataset export

  node --import tsx scripts/export-dataset.ts [options]

  --out <dir>         Site output directory. Files land in <dir>/${API_DIR}/.
                      Default $DEAD_DEPS_SITE_OUT or site/dist.
  --base-url <url>    Origin and sub-path the site is served from.
                      Default $DEAD_DEPS_SITE_URL or ${DEFAULT_BASE_URL}
  --dataset <path>    Succession dataset to publish.
                      Default $DEAD_DEPS_DATASET or data/successors.yaml.
  -h, --help          Show this message.

  \`npm run site\` runs this as part of the build; this entry point exists for
  previewing the API on its own.
`;

interface CliOptions {
  out: string;
  baseUrl: string;
  dataset: string;
}

function parseArgs(argv: readonly string[]): CliOptions | 'help' {
  const options: CliOptions = {
    out: process.env['DEAD_DEPS_SITE_OUT'] ?? join(ROOT, 'site', 'dist'),
    baseUrl: process.env['DEAD_DEPS_SITE_URL'] ?? DEFAULT_BASE_URL,
    dataset: process.env['DEAD_DEPS_DATASET'] ?? join(ROOT, 'data', 'successors.yaml'),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      i += 1;
      const value = argv[i];
      if (value === undefined || value === '') throw new Error(`${arg ?? ''} needs a value.`);
      return value;
    };
    switch (arg) {
      case '-h':
      case '--help':
        return 'help';
      case '--out':
        options.out = resolve(next());
        break;
      case '--base-url':
        options.baseUrl = next();
        break;
      case '--dataset':
        options.dataset = resolve(next());
        break;
      default:
        throw new Error(`Unknown argument "${arg ?? ''}".`);
    }
  }

  return options;
}

async function main(): Promise<number> {
  let options: CliOptions | 'help';
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return EXIT.USAGE_ERROR;
  }
  if (options === 'help') {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }

  const dataset = await loadSuccessors(options.dataset);
  const result = await exportDataset({
    records: dataset.records,
    outDir: options.out,
    baseUrl: options.baseUrl,
    sourcePath: options.dataset,
  });

  for (const file of result.files) {
    process.stdout.write(`  ${file.path}  ${file.bytes} bytes  ${file.sha256.slice(0, 12)}\n`);
  }
  process.stdout.write(
    `dead-deps api: ${result.count} records, ${result.files.length} files -> ${join(options.out, API_DIR)}\n`,
  );
  return EXIT.OK;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`dead-deps api: export failed — ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = EXIT.RUNTIME_ERROR;
    },
  );
}
