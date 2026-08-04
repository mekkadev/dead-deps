#!/usr/bin/env node
/**
 * dead-deps — MCP server (stdio).
 *
 * Three tools, one job: make a model's claim about a package traceable to
 * something a human can open in a browser. Every response carries evidence
 * URLs, and `find_successor` refuses to name a package it cannot source.
 *
 * ## Usage with Claude Code / Cursor
 *
 * Claude Code, one-liner:
 *
 *     claude mcp add dead-deps -- npx -y -p dead-deps dead-deps-mcp
 *
 * Or, by hand — Claude Code `.mcp.json` (project) / `~/.claude.json` (user),
 * and Cursor `~/.cursor/mcp.json` or `.cursor/mcp.json`, share this shape:
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "dead-deps": {
 *       "command": "npx",
 *       "args": ["-y", "-p", "dead-deps", "dead-deps-mcp"],
 *       "env": {
 *         "DEAD_DEPS_CONTACT": "you@example.com"
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * `-p dead-deps` is required: the binary is `dead-deps-mcp` but the package it
 * lives in is `dead-deps`. With a global install (`npm i -g dead-deps`) the
 * command is simply `"command": "dead-deps-mcp", "args": []`.
 *
 * `DEAD_DEPS_CONTACT` is optional. It is sent as a `User-Agent` contact to
 * ecosyste.ms, which puts requests in their polite pool. Nothing else is
 * transmitted, and the server writes only to a local HTTP cache.
 *
 * ## Implementation note
 *
 * This uses the SDK's low-level `Server` plus hand-written JSON Schema rather
 * than `McpServer.registerTool`. `registerTool` accepts Zod schemas only, and
 * `zod` reaches this project as a transitive peer of the SDK, not a declared
 * dependency — importing it would break for anyone installing `dead-deps`
 * under pnpm's strict layout. See the note in the returned summary.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import { assess } from './detect/score.js';
import { renderJson } from './report/json.js';
import { scan } from './scan.js';
import { HttpClient, gatherSignals } from './sources/index.js';
import { DEFAULT_DATASET_PATH, loadSuccessors, lookupSuccessor } from './successors/index.js';
import { DEFAULT_SCAN_OPTIONS, STATE_SEVERITY } from './types.js';
import type {
  Assessment,
  Evidence,
  Finding,
  MaintenanceState,
  ScanResult,
  SuccessorDataset,
  SuccessorRecord,
} from './types.js';

const SERVER_NAME = 'dead-deps';

/** Findings returned by `scan_lockfile` when the caller does not say. */
const DEFAULT_FINDING_LIMIT = 25;
const MAX_FINDING_LIMIT = 200;

/** Evidence lines shown in the text block. The JSON always carries all of them. */
const TEXT_EVIDENCE_LIMIT = 4;

/** npm's name grammar, minus the lowercase rule: legacy names like `JSONStream` exist. */
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

/**
 * What each verdict means, in one line. A model reading `low-activity` should
 * not tell the user to migrate, and `stable-complete` is a compliment.
 */
const STATE_MEANING: Record<MaintenanceState, string> = {
  active: 'Maintained and releasing. No action.',
  'stable-complete':
    'Quiet because it is finished, not because it was abandoned: small scope, no open rot, still working. Do not migrate off it on age alone.',
  unknown: 'Not enough data to judge. Treat the absence of a verdict as absence of information.',
  'low-activity': 'Slowing down. Worth watching, not worth an emergency migration.',
  unmaintained: 'No meaningful maintenance for a long time, but nothing formally declared.',
  deprecated: 'The registry or the maintainers have formally marked it deprecated.',
  abandoned: 'Maintenance has stopped and the evidence says it is not coming back.',
  'hijack-risk':
    'Abandoned AND attractive to an attacker (still widely depended on, few or no active maintainers). Prioritise this one.',
};

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * stdout belongs to the JSON-RPC transport. Every byte of diagnostics goes to
 * stderr; a stray `console.log` anywhere in this process corrupts the session.
 */
function diagnostic(message: string): void {
  process.stderr.write(`${SERVER_NAME}-mcp: ${message}\n`);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message === '' ? error.name : error.message;
  return String(error);
}

/** Read the shipped version so `initialize` does not advertise a stale literal. */
function resolveVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // `src/mcp.ts` and `dist/mcp.js` both sit one level below the package root.
  for (const candidate of [join(here, '..', 'package.json'), join(here, '..', '..', 'package.json')]) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null) {
        const version = (parsed as { version?: unknown }).version;
        const name = (parsed as { name?: unknown }).name;
        if (name === SERVER_NAME && typeof version === 'string') return version;
      }
    } catch {
      // Next candidate; a missing version is not worth failing startup over.
    }
  }
  return '0.0.0';
}

// ---------------------------------------------------------------------------
// Argument handling
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function invalid(message: string): McpError {
  return new McpError(ErrorCode.InvalidParams, message);
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalid(`"${key}" must be a string, got ${typeof value}.`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw invalid(`"${key}" must be a boolean, got ${typeof value}.`);
  return value;
}

function optionalInteger(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(`"${key}" must be a finite number.`);
  }
  const rounded = Math.floor(value);
  if (rounded < min || rounded > max) {
    throw invalid(`"${key}" must be between ${min} and ${max}, got ${value}.`);
  }
  return rounded;
}

/**
 * Package names arrive from a model, so they are untrusted input that will be
 * interpolated into upstream URLs. Reject anything that is not a legal npm
 * name rather than letting it become a strange request.
 */
function requirePackageName(args: Record<string, unknown>): string {
  const raw = args['name'];
  if (typeof raw !== 'string') throw invalid('"name" is required and must be a string.');
  const name = raw.trim();
  if (name === '') throw invalid('"name" must not be empty.');
  if (name.length > 214) throw invalid('"name" is longer than npm allows (214 characters).');
  if (!PACKAGE_NAME_PATTERN.test(name)) {
    throw invalid(
      `"${name}" is not a valid npm package name. Pass a bare name such as "request" or ` +
        '"@babel/core" — not a version range, URL, or file path.',
    );
  }
  return name;
}

// ---------------------------------------------------------------------------
// Shared upstream client
// ---------------------------------------------------------------------------

let sharedHttp: HttpClient | null = null;

/**
 * One client for the process lifetime, so repeated `check_package` calls share
 * the disk cache and the concurrency gate instead of racing each other.
 */
function http(): HttpClient {
  if (sharedHttp !== null) return sharedHttp;
  const contact = (process.env['DEAD_DEPS_CONTACT'] ?? '').trim();
  sharedHttp = new HttpClient({
    contact: contact === '' ? null : contact,
    cacheTtlHours: DEFAULT_SCAN_OPTIONS.cacheTtlHours,
    noCache: false,
    concurrency: DEFAULT_SCAN_OPTIONS.concurrency,
  });
  return sharedHttp;
}

let sharedDataset: Promise<SuccessorDataset> | null = null;

function dataset(): Promise<SuccessorDataset> {
  sharedDataset ??= loadSuccessors();
  return sharedDataset;
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

function jsonEvidence(evidence: readonly Evidence[]): Array<Record<string, unknown>> {
  return evidence.map((item) => ({
    kind: item.kind,
    label: item.label,
    url: item.url ?? null,
    observedAt: item.observedAt ?? null,
    weight: item.weight,
  }));
}

function jsonSuccessor(record: SuccessorRecord): Record<string, unknown> {
  return {
    from: record.from,
    to: record.to,
    // `to` is only an installable package name when toKind is 'package'; for
    // 'platform' it is a language/runtime feature and the right advice is to
    // delete the dependency, not to install anything.
    toKind: record.toKind,
    type: record.type,
    confidence: record.confidence,
    since: record.since,
    dropIn: record.dropIn,
    alternatives: [...record.alternatives],
    notes: record.notes,
    migration: record.migration,
    evidence: record.evidence.map((item) => ({ label: item.label, url: item.url })),
  };
}

/** Strongest arguments first; ties keep dataset order. */
function rankedEvidence(evidence: readonly Evidence[]): Evidence[] {
  return [...evidence].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
}

function evidenceLines(assessment: Assessment, indent: string): string[] {
  const ranked = rankedEvidence(assessment.evidence);
  if (ranked.length === 0) return [`${indent}- No evidence was gathered; treat the verdict as unsupported.`];

  const lines = ranked
    .slice(0, TEXT_EVIDENCE_LIMIT)
    .map((item) => `${indent}- ${item.label}${item.url === undefined ? '' : ` — ${item.url}`}`);
  const hidden = ranked.length - lines.length;
  if (hidden > 0) {
    lines.push(`${indent}- (${hidden} further evidence ${hidden === 1 ? 'item' : 'items'} in the JSON payload)`);
  }
  return lines;
}

function successorLines(record: SuccessorRecord | null, indent: string): string[] {
  if (record === null) return [`${indent}Successor: none curated. Do not invent one — call find_successor for the full statement.`];

  if (record.to === null || record.toKind === 'none') {
    return [
      `${indent}Successor: none exists. The curated dataset says this package has no credible replacement.`,
      `${indent}  ${record.notes}`,
    ];
  }

  const what =
    record.toKind === 'platform'
      ? `${record.to} — a platform feature, not a package: remove the dependency rather than replacing it`
      : record.to;
  const lines = [
    `${indent}Successor: ${what} (${record.type}, ${record.confidence} confidence, ` +
      `${record.dropIn ? 'drop-in' : 'not drop-in'})`,
  ];
  if (record.migration !== null) lines.push(`${indent}  Migration: ${record.migration}`);
  if (record.alternatives.length > 0) lines.push(`${indent}  Alternatives: ${record.alternatives.join(', ')}`);
  for (const item of record.evidence) lines.push(`${indent}  Source: ${item.label} — ${item.url}`);
  return lines;
}

function findingHeadline(index: number, finding: Finding): string {
  const { dependency, assessment } = finding;
  const version = dependency.version === null ? '' : `@${dependency.version}`;
  const placement = `${dependency.scope}${dependency.direct ? '' : ', transitive'}`;
  return (
    `${index}. ${dependency.name}${version} — ${assessment.state} ` +
    `(score ${assessment.score}/100, ${assessment.confidence} confidence, ${placement})`
  );
}

function textResult(text: string, structured: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(message: string, structured: Record<string, unknown> = {}): CallToolResult {
  return textResult(message, { error: message, ...structured }, true);
}

// ---------------------------------------------------------------------------
// Tool: scan_lockfile
// ---------------------------------------------------------------------------

function renderScanText(result: ScanResult, target: string): string {
  const lines: string[] = [];
  const flagged = result.findings.length;

  lines.push(`Scanned ${result.lockfile.path} (${result.lockfile.format}), resolved from ${target}.`);
  lines.push(
    `Examined ${result.examined} ${result.examined === 1 ? 'package' : 'packages'}; ` +
      `${flagged} reported, ${result.skipped} lockfile ${result.skipped === 1 ? 'entry' : 'entries'} not examined. ` +
      `Took ${(result.durationMs / 1000).toFixed(1)}s.`,
  );

  if (flagged === 0) {
    lines.push('');
    lines.push(
      'Nothing met the reporting threshold: every dependency examined is either actively maintained ' +
        'or quietly finished. "Quietly finished" is a pass, not a warning.',
    );
  } else {
    lines.push('');
    lines.push('Findings, worst first. Every line below is sourced; open the URLs to verify.');
    result.findings.forEach((finding, index) => {
      lines.push('');
      lines.push(findingHeadline(index + 1, finding));
      lines.push(`   ${STATE_MEANING[finding.assessment.state]}`);
      lines.push(...evidenceLines(finding.assessment, '   '));
      lines.push(...successorLines(finding.successor, '   '));
    });
  }

  const warnings = [...result.lockfile.warnings, ...result.warnings];
  if (warnings.length > 0) {
    lines.push('');
    lines.push('Caveats — what this scan could not establish:');
    for (const warning of warnings) lines.push(`- ${warning}`);
  }

  return lines.join('\n');
}

async function runScanLockfile(args: Record<string, unknown>): Promise<CallToolResult> {
  const path = optionalString(args, 'path');
  const all = optionalBoolean(args, 'all') ?? false;
  const limit = optionalInteger(args, 'limit', 1, MAX_FINDING_LIMIT) ?? DEFAULT_FINDING_LIMIT;
  const target = path === undefined ? process.cwd() : resolve(path);
  const contact = (process.env['DEAD_DEPS_CONTACT'] ?? '').trim();

  let result: ScanResult;
  try {
    result = await scan(target, {
      all,
      limit,
      quiet: true, // Progress writes to stderr; silence it anyway, nothing reads it.
      contact: contact === '' ? null : contact,
    });
  } catch (error) {
    return errorResult(
      `No scan was performed: ${describeError(error)}\n\n` +
        'Nothing about these dependencies has been established. Do not characterise the ' +
        'project\'s dependency health from this failure — fix the path and scan again.',
      { target, scanned: false },
    );
  }

  // renderJson is the same contract the CLI's --json emits, so the MCP payload
  // and the CLI payload can never drift apart.
  const structured = JSON.parse(renderJson(result)) as Record<string, unknown>;
  structured['target'] = target;
  return textResult(renderScanText(result, target), structured);
}

// ---------------------------------------------------------------------------
// Tool: check_package
// ---------------------------------------------------------------------------

function renderPackageText(assessment: Assessment, record: SuccessorRecord | null): string {
  const { signals } = assessment;
  const lines: string[] = [];

  lines.push(
    `${assessment.name} — ${assessment.state} (score ${assessment.score}/100, ` +
      `${assessment.confidence} confidence)`,
  );
  lines.push(STATE_MEANING[assessment.state]);
  lines.push('');

  const facts: string[] = [];
  if (signals.latestVersion !== null) facts.push(`latest ${signals.latestVersion}`);
  if (signals.latestReleaseAt !== null) facts.push(`released ${signals.latestReleaseAt.slice(0, 10)}`);
  if (signals.versionsCount !== null) facts.push(`${signals.versionsCount} versions`);
  if (signals.downloadsLastMonth !== null) {
    facts.push(`${signals.downloadsLastMonth.toLocaleString('en-US')} downloads/month`);
  }
  if (signals.dependentPackagesCount !== null) facts.push(`${signals.dependentPackagesCount} dependent packages`);
  if (signals.repoArchived === true) facts.push('repository archived');
  if (facts.length > 0) lines.push(`Facts: ${facts.join(', ')}.`);
  if (signals.repositoryUrl !== null) lines.push(`Repository: ${signals.repositoryUrl}`);
  lines.push(`Registry: https://www.npmjs.com/package/${encodeURIComponent(assessment.name)}`);

  if (signals.deprecationMessage !== null) {
    lines.push(`Deprecation notice: ${signals.deprecationMessage}`);
  }
  if (signals.openAdvisories.length > 0) {
    lines.push('Open advisories:');
    for (const advisory of signals.openAdvisories) {
      lines.push(`- ${advisory.id}${advisory.severity === null ? '' : ` (${advisory.severity})`}: ${advisory.title} — ${advisory.url}`);
    }
  }

  lines.push('');
  lines.push('Evidence:');
  lines.push(...evidenceLines(assessment, ''));

  lines.push('');
  lines.push(...successorLines(record, ''));

  if (signals.freshness.stale) {
    lines.push('');
    lines.push(
      'Upstream data behind this verdict is stale; the package may have moved since it was indexed. ' +
        'Say so if you repeat the verdict.',
    );
  }
  if (signals.errors.length > 0) {
    lines.push('');
    lines.push('What could not be established:');
    for (const problem of signals.errors) lines.push(`- ${problem}`);
  }

  return lines.join('\n');
}

async function runCheckPackage(args: Record<string, unknown>): Promise<CallToolResult> {
  const name = requirePackageName(args);

  let assessment: Assessment;
  try {
    // gatherSignals never throws; assess() on empty signals still yields `unknown`.
    assessment = assess(await gatherSignals(http(), name));
  } catch (error) {
    return errorResult(
      `Could not assess "${name}": ${describeError(error)}. No verdict was produced — say that ` +
        'rather than guessing at the package\'s health.',
      { name, assessed: false },
    );
  }

  let record: SuccessorRecord | null = null;
  let datasetError: string | null = null;
  try {
    record = lookupSuccessor(await dataset(), name);
  } catch (error) {
    datasetError = describeError(error);
  }

  const structured: Record<string, unknown> = {
    name: assessment.name,
    state: assessment.state,
    stateMeaning: STATE_MEANING[assessment.state],
    severity: STATE_SEVERITY[assessment.state],
    score: assessment.score,
    confidence: assessment.confidence,
    stale: assessment.signals.freshness.stale,
    evidence: jsonEvidence(assessment.evidence),
    // Raw upstream facts, unjudged, exactly as the scorer saw them.
    signals: assessment.signals,
    successor: record === null ? null : jsonSuccessor(record),
    links: {
      npm: `https://www.npmjs.com/package/${encodeURIComponent(assessment.name)}`,
      repository: assessment.signals.repositoryUrl,
    },
    dataErrors: [...assessment.signals.errors, ...(datasetError === null ? [] : [`Succession dataset: ${datasetError}`])],
  };

  return textResult(renderPackageText(assessment, record), structured);
}

// ---------------------------------------------------------------------------
// Tool: find_successor
// ---------------------------------------------------------------------------

/**
 * Packages the requested name is *already* the answer for. Not a guess: these
 * are curated rows that name it as a successor or alternative, and they are
 * worth surfacing because "no record for X" often means X is the destination,
 * not a dead end.
 */
function listedAsSuccessorFor(ds: SuccessorDataset, name: string): string[] {
  const needle = name.toLowerCase();
  const out: string[] = [];
  for (const record of ds.records) {
    const isPrimary = record.to !== null && record.to.toLowerCase() === needle;
    const isAlternative = record.alternatives.some((item) => item.toLowerCase() === needle);
    if (isPrimary || isAlternative) out.push(record.from);
  }
  return out.sort();
}

function renderFoundText(record: SuccessorRecord, requested: string): string {
  const lines: string[] = [];
  const alias = record.from.toLowerCase() === requested.toLowerCase() ? '' : ` (matched curated row "${record.from}")`;

  if (record.to === null || record.toKind === 'none') {
    lines.push(`${requested}${alias}: curated record exists, and it says there is NO successor.`);
    lines.push('');
    lines.push(record.notes);
  } else {
    lines.push(
      `${requested}${alias} → ${record.to} — ${record.type}, ${record.confidence} confidence, ` +
        `${record.dropIn ? 'drop-in replacement' : 'NOT a drop-in replacement'}.`,
    );
    if (record.toKind === 'platform') {
      lines.push(
        `${record.to} is a PLATFORM FEATURE, not an npm package. Do not try to install it: the ` +
          'correct migration is to delete the dependency and use what the language or runtime already provides.',
      );
    }
    if (record.since !== null) lines.push(`${record.from} stopped being maintained around ${record.since}.`);
    lines.push('');
    lines.push(record.notes);
    if (record.migration !== null) {
      lines.push('');
      lines.push(`Migration: ${record.migration}`);
    }
    if (record.alternatives.length > 0) {
      lines.push('');
      lines.push(`Other credible options: ${record.alternatives.join(', ')}.`);
    }
  }

  lines.push('');
  lines.push('Sources (human-verified, one per line):');
  for (const item of record.evidence) lines.push(`- ${item.label} — ${item.url}`);
  return lines.join('\n');
}

function renderNotFoundText(name: string, ds: SuccessorDataset, alsoFor: string[]): string {
  const lines: string[] = [];
  lines.push(
    `No curated succession record for "${name}". dead-deps has ${ds.records.length} ` +
      `hand-verified ${ds.records.length === 1 ? 'row' : 'rows'} and this package is not one of them.`,
  );
  lines.push('');
  lines.push('What this does and does not mean:');
  lines.push('- It does NOT mean the package is unmaintained. Most packages are fine and have no row here.');
  lines.push('- It does NOT mean a successor exists but is missing from the dataset.');
  lines.push('- It means dead-deps has no sourced replacement to give you, so it is giving you none.');
  lines.push('');
  lines.push(
    'Do not fill this gap from memory. A recommended package name that turns out not to exist is the ' +
      'opening move of a slopsquatting attack: attackers watch for names models invent and publish them. ' +
      'Tell the user no verified successor is on record.',
  );

  if (alsoFor.length > 0) {
    lines.push('');
    lines.push(
      `Note: "${name}" is itself the curated successor or alternative for ${alsoFor.join(', ')} — ` +
        'so it is a destination in this dataset, not a dead end.',
    );
  }

  lines.push('');
  lines.push(
    `Next steps: call check_package("${name}") for a sourced maintenance verdict, or check the package's ` +
      'own README and repository for a maintainer statement.',
  );
  return lines.join('\n');
}

async function runFindSuccessor(args: Record<string, unknown>): Promise<CallToolResult> {
  const name = requirePackageName(args);

  let ds: SuccessorDataset;
  try {
    ds = await dataset();
  } catch (error) {
    // A dataset we could not read is not a dataset that said "no successor".
    sharedDataset = null;
    return errorResult(
      `The curated succession dataset could not be loaded (${describeError(error)}), so no lookup ` +
        `happened for "${name}". This is not a "no successor" answer — it is no answer at all. ` +
        'Do not substitute your own recollection of a replacement package.',
      { name, found: false, lookupPerformed: false, datasetPath: DEFAULT_DATASET_PATH },
    );
  }

  const record = lookupSuccessor(ds, name);
  if (record === null) {
    const alsoFor = listedAsSuccessorFor(ds, name);
    return textResult(renderNotFoundText(name, ds, alsoFor), {
      name,
      found: false,
      lookupPerformed: true,
      curatedRecordCount: ds.records.length,
      successor: null,
      listedAsSuccessorFor: alsoFor,
      guidance:
        'No curated successor exists for this package. State that plainly. Do not name a replacement ' +
        'package from memory: an invented name is how slopsquatting attacks land.',
    });
  }

  return textResult(renderFoundText(record, name), {
    name,
    found: true,
    lookupPerformed: true,
    curatedRecordCount: ds.records.length,
    successor: jsonSuccessor(record),
  });
}

// ---------------------------------------------------------------------------
// Tool table
// ---------------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

const TOOLS: ReadonlyArray<{ definition: Tool; handler: ToolHandler }> = [
  {
    definition: {
      name: 'scan_lockfile',
      title: 'Scan a lockfile for unmaintained dependencies',
      description:
        'Reads a REAL lockfile from disk (package-lock.json, pnpm-lock.yaml, yarn.lock v1 or Berry, or ' +
        'package.json as a fallback) and returns a verified maintenance verdict for each dependency, ' +
        'worst first. Verdicts come from the npm registry and the ecosyste.ms index — deprecation ' +
        'notices, release cadence, repository archive status, issue and PR responsiveness, maintainer ' +
        'count, open advisories — and every verdict ships with the evidence and URLs behind it. ' +
        'Verdicts are states, not booleans: "stable-complete" means small-and-finished and is a pass, ' +
        'while "hijack-risk" means abandoned AND still widely depended on. ' +
        'USE THIS when the user asks whether their dependencies are maintained, before an upgrade or ' +
        'audit, or whenever you would otherwise guess a package\'s health from its name or your training ' +
        'data. IT DOES NOT KNOW: private or non-npm registries, whether the project actually imports a ' +
        'dependency, or anything that happened after the upstream indexes last synced (the report says ' +
        'when data is stale). Requires filesystem access to the project and network access to ' +
        'registry.npmjs.org and packages.ecosyste.ms; results are cached on disk for 24h.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Project directory or a direct path to a lockfile. Defaults to the server process\'s ' +
              'working directory. Given a directory, the most authoritative lockfile in it is used.',
          },
          all: {
            type: 'boolean',
            description:
              'Include transitive dependencies. Default false, because only direct dependencies are ' +
              'actionable by the user. Set true for a supply-chain audit, and expect it to be slower.',
          },
          limit: {
            type: 'number',
            description:
              `Maximum findings to return, 1-${MAX_FINDING_LIMIT}. Default ${DEFAULT_FINDING_LIMIT}. ` +
              'Findings beyond the limit are counted in the warnings rather than dropped silently.',
          },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          schemaVersion: { type: 'number' },
          scan: { type: 'object', description: 'Counts and timings for the run.' },
          lockfile: { type: 'object', description: 'Path, format, dependency count and parse warnings.' },
          summary: { type: 'object', description: 'Worst state, score, per-state counts, successor coverage.' },
          findings: {
            type: 'array',
            description: 'One entry per flagged package, with full evidence, raw signals and curated successor.',
          },
          warnings: { type: 'array', description: 'What the scan could not establish.' },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    handler: runScanLockfile,
  },
  {
    definition: {
      name: 'check_package',
      title: 'Check one npm package',
      description:
        'Assesses a SINGLE npm package by name and returns its maintenance state, 0-100 abandonment ' +
        'score, confidence, the full evidence list with verifiable URLs, and the curated successor if ' +
        'one is on record. No lockfile needed. ' +
        'USE THIS before recommending, adding or upgrading a dependency, and instead of recalling from ' +
        'training data whether a package is still alive — your recollection has a cutoff and this does ' +
        'not. It also doubles as an existence check: if the registry has no record of the name, the ' +
        'response says so, which is a strong signal that the name was hallucinated or typosquatted. ' +
        'IT DOES NOT KNOW: whether the package suits the user\'s use case, its licence terms, or the ' +
        'quality of its code. It judges maintenance only. Requires network access; a `low` confidence ' +
        'or a `stale` flag in the response must be repeated to the user, not smoothed over.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Bare npm package name, e.g. "request" or "@babel/core". No version range, URL or path.',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          state: { type: 'string', description: 'active | stable-complete | low-activity | unmaintained | deprecated | abandoned | hijack-risk | unknown' },
          stateMeaning: { type: 'string' },
          score: { type: 'number', description: '0-100; higher means more likely genuinely abandoned.' },
          confidence: { type: 'string' },
          stale: { type: 'boolean' },
          evidence: { type: 'array' },
          signals: { type: 'object', description: 'Raw upstream facts, unjudged.' },
          successor: { type: ['object', 'null'], description: 'Curated succession record, or null when none is on record.' },
          links: { type: 'object' },
          dataErrors: { type: 'array' },
        },
        required: ['name', 'state', 'score', 'confidence', 'evidence'],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    handler: runCheckPackage,
  },
  {
    definition: {
      name: 'find_successor',
      title: 'Find the verified successor to a dead package',
      description:
        'Looks a package up in dead-deps\' curated, hand-verified succession dataset and returns the ' +
        'package the ecosystem actually moved to: the successor name, how it succeeded (fork, rename, ' +
        'replacement, absorbed into the platform, self-declared by the maintainers, or ' +
        'reimplementation), whether it is a drop-in, a concrete migration hint, other credible ' +
        'alternatives, and primary-source URLs for every claim. Every row was checked by a human ' +
        'against a deprecation notice, maintainer statement, archived repo or official migration guide. ' +
        'Check `toKind` on the result before telling anyone to install something: `package` means an npm ' +
        'package name, `platform` means the successor is a language or runtime feature and the right ' +
        'advice is to delete the dependency, and `none` means nothing replaced it. ' +
        'ALWAYS PREFER THIS TOOL OVER YOUR OWN RECOLLECTION when naming a replacement package. Your ' +
        'memory of package names is lossy and has a cutoff; recommending a package that does not exist ' +
        'is not a harmless mistake, it is the entry point for a slopsquatting supply-chain attack, ' +
        'because attackers publish the plausible-sounding names models invent. ' +
        'WHEN THERE IS NO RECORD, this tool says so and names nothing — that is the correct answer and ' +
        'the reason to trust it. Do not fill the gap yourself: report that no verified successor is on ' +
        'record. A missing record is also NOT evidence that the package is unmaintained; most healthy ' +
        'packages have no row. Runs entirely offline against local data, so it is fast and safe to call ' +
        'for any name.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'Bare npm package name to find a successor for, e.g. "request" or "@babel/polyfill". ' +
              'Matching is case-insensitive and falls back to the unscoped name when that is unambiguous.',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          found: { type: 'boolean', description: 'False means no curated record. Name no replacement in that case.' },
          lookupPerformed: { type: 'boolean', description: 'False means the dataset failed to load; the answer is unknown, not "none".' },
          curatedRecordCount: { type: 'number' },
          successor: { type: ['object', 'null'], description: 'The curated record, or null when found is false.' },
          listedAsSuccessorFor: { type: 'array', description: 'Packages this one is itself the curated successor for.' },
          guidance: { type: 'string' },
        },
        required: ['name', 'found'],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler: runFindSuccessor,
  },
];

const HANDLERS = new Map(TOOLS.map((tool) => [tool.definition.name, tool.handler]));

const INSTRUCTIONS = [
  'dead-deps answers one question with evidence: is this npm package still maintained, and if not, ',
  'what actually replaced it?',
  '\n\n',
  'Two rules when relaying anything from this server. First, every verdict comes with evidence URLs — ',
  'pass them to the user so the claim is checkable. Second, never name a replacement package that ',
  'find_successor did not name. The dataset is deliberately small and human-verified; when it has no ',
  'record, "no verified successor is on record" is the complete and correct answer. Inventing a ',
  'plausible-sounding package name is how slopsquatting attacks reach a user\'s install.',
].join('');

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function createServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: resolveVersion() },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((tool) => tool.definition),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: rawArgs } = request.params;
    const handler = HANDLERS.get(name);
    if (handler === undefined) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool "${name}".`);
    }

    try {
      return await handler(asRecord(rawArgs));
    } catch (error) {
      // Bad arguments are a protocol error; anything else becomes a tool error
      // so the model sees what went wrong and can say so instead of retrying.
      if (error instanceof McpError) throw error;
      const message = describeError(error);
      diagnostic(`tool ${name} failed: ${message}`);
      return errorResult(`The ${name} tool failed: ${message}. No result was produced.`, { tool: name });
    }
  });

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = (reason: string, code: number): void => {
    if (closing) return;
    closing = true;
    diagnostic(`shutting down (${reason})`);
    void server
      .close()
      .catch((error: unknown) => {
        diagnostic(`error during shutdown: ${describeError(error)}`);
      })
      .finally(() => {
        process.exit(code);
      });
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      shutdown(signal, 0);
    });
  }
  // The client going away closes stdin; that is a normal end of session.
  server.onclose = (): void => {
    shutdown('transport closed', 0);
  };
  process.on('uncaughtException', (error: unknown) => {
    diagnostic(`uncaught exception: ${describeError(error)}`);
    shutdown('uncaught exception', 1);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    diagnostic(`unhandled rejection: ${describeError(reason)}`);
  });

  await server.connect(transport);
  diagnostic(`ready on stdio — tools: ${TOOLS.map((tool) => tool.definition.name).join(', ')}`);
}

main().catch((error: unknown) => {
  diagnostic(`fatal: ${describeError(error)}`);
  process.exit(1);
});
