# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.1.0] — 2026-08-04

First release.

### Added

- **CLI.** `npx dead-deps` scans a project and reports unmaintained direct
  dependencies with clickable evidence and, where one is known, the successor.
  Zero configuration, no account, no API key. Flags for scope (`--all`,
  `--limit`, `--min-state`), output (`--json`, `--quiet`, `--no-color`) and
  network behaviour (`--contact`, `--concurrency`, `--no-cache`,
  `--cache-ttl`). Exit codes are a stable contract so CI can gate on findings.
- **Lockfile support** for every npm dialect in the wild: `package-lock.json`
  v1, v2 and v3, `npm-shrinkwrap.json`, `pnpm-lock.yaml` v5, v6 and v9,
  `yarn.lock` classic and Berry, and a bare `package.json` fallback. Direct
  dependencies are resolved against the sibling manifest; a malformed entry
  becomes a warning rather than taking the whole file down.
- **Verdict engine** producing a maintenance state with cited evidence rather
  than a boolean. Release silence is measured against each package's own
  historical cadence, not a fixed threshold, and a `stable-complete` guard
  keeps finished-but-quiet packages such as `ms`, `inherits` and `once` out of
  the report.
- **Succession dataset**: 81 hand-verified rows in `data/successors.yaml`
  mapping dead packages to what replaced them, with 178 primary-source evidence
  links. Renames, self-declared successors, platform absorption, replacements,
  forks and reimplementations are modelled as distinct succession types, and
  `toKind` distinguishes a successor package from a platform feature that
  removes the dependency entirely.
- **Calibration harness** (`npm run calibrate`) scoring the detector against 54
  hand-labelled packages, reporting the false-positive rate on finished
  packages separately from overall accuracy, plus a confusion matrix, per-label
  precision and recall, and every disagreement with the evidence behind it.
  Initial run: 0% false positives on finished packages, 0% false alarms on any
  healthy package, 83.3% strict accuracy and 4.2% missed.
- **MCP server** (`dead-deps-mcp`) exposing `scan_lockfile`, `check_package`
  and `find_successor` over stdio. `find_successor` declines to guess when no
  curated record exists, which is the point of it — a hallucinated package name
  is how slopsquatting attacks land.
- **Library API**: `scan`, `assess`, `gatherSignals`, `loadSuccessors` and the
  report renderers are all exported, with full TypeScript types.
- **Static site** generated from the dataset — one page per succession, plus a
  methodology page whose calibration figures are read from the harness output
  rather than written by hand.
- **163 tests**, none of which touch the network, and CI across Node 20 and 22.

### Notes

- Requires Node.js 20.10 or newer. Two runtime dependencies: `yaml` and
  `@modelcontextprotocol/sdk`.
- npm only. Other ecosystems are deliberately out of scope for now.

[Unreleased]: https://github.com/mekkadev/dead-deps/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mekkadev/dead-deps/releases/tag/v0.1.0
