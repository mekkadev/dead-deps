/**
 * Just enough semver to answer one question: does an advisory still apply to
 * the newest published version of a package?
 *
 * This is deliberately not a general semver implementation. Advisory ranges as
 * published by GitHub and mirrored by ecosyste.ms use a small, regular grammar
 * — comma-separated comparators such as `< 2.0.0` or `>= 1.0.0, < 1.4.2` — and
 * supporting exactly that keeps the project dependency-free. Anything we cannot
 * parse returns `null` for "unknown", and callers must treat unknown as
 * "assume it still applies" rather than silently dropping the advisory.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers, empty for a release version. */
  prerelease: string[];
}

const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(input: string): ParsedVersion | null {
  const match = VERSION_RE.exec(input.trim());
  if (match === null) return null;
  const prerelease = match[4] === undefined ? [] : match[4].split('.');
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? 0 : Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    prerelease,
  };
}

/** Standard semver precedence: -1, 0 or 1. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;

  // A version with a prerelease tag has lower precedence than one without.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return Number(left) < Number(right) ? -1 : 1;
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

const COMPARATOR_RE = /^(<=|>=|<|>|=)?\s*(.+)$/;

/**
 * Tests a version against one advisory range.
 *
 * Returns `null` when the range uses syntax we do not understand, so the caller
 * can fall back to the conservative assumption rather than treating an
 * unparsed range as "not affected".
 */
export function versionSatisfiesRange(version: string, range: string): boolean | null {
  const target = parseVersion(version);
  if (target === null) return null;

  const clauses = range
    .split(',')
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
  if (clauses.length === 0) return null;

  for (const clause of clauses) {
    const match = COMPARATOR_RE.exec(clause);
    if (match === null) return null;
    const operator = match[1] ?? '=';
    const bound = parseVersion(match[2] ?? '');
    if (bound === null) return null;

    const cmp = compareVersions(target, bound);
    const ok =
      operator === '<'
        ? cmp < 0
        : operator === '<='
          ? cmp <= 0
          : operator === '>'
            ? cmp > 0
            : operator === '>='
              ? cmp >= 0
              : cmp === 0;
    if (!ok) return false;
  }
  return true;
}

/**
 * Whether `version` is still exposed to an advisory.
 *
 * Prefers the explicit vulnerable range; falls back to comparing against the
 * first patched version. Returns `null` when neither can be evaluated — an
 * advisory whose applicability is unknown must keep counting, because silently
 * discarding it would understate the risk.
 */
export function advisoryAffectsVersion(
  version: string | null,
  vulnerableRange: string | null,
  firstPatchedVersion: string | null,
): boolean | null {
  if (version === null) return null;

  if (vulnerableRange !== null) {
    const inRange = versionSatisfiesRange(version, vulnerableRange);
    if (inRange !== null) return inRange;
  }

  if (firstPatchedVersion !== null) {
    const target = parseVersion(version);
    const patched = parseVersion(firstPatchedVersion);
    if (target !== null && patched !== null) return compareVersions(target, patched) < 0;
  }

  return null;
}
