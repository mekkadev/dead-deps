<div align="center">

# dead-deps

**Find abandoned and unmaintained npm dependencies in your lockfile — and the maintained fork or replacement that succeeded them.**

Evidence-backed. Zero config. No account. Works as a CLI, a library, and an MCP server for AI agents.

[![CI](https://github.com/mekkadev/dead-deps/actions/workflows/ci.yml/badge.svg)](https://github.com/mekkadev/dead-deps/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dead-deps.svg?color=cb3837&logo=npm)](https://www.npmjs.com/package/dead-deps)
[![node](https://img.shields.io/node/v/dead-deps.svg?color=5fa04e&logo=node.js&logoColor=white)](https://nodejs.org/)
[![license](https://img.shields.io/npm/l/dead-deps.svg?color=blue)](./LICENSE)
[![false positives](https://img.shields.io/badge/false%20positives-0%25-brightgreen)](#calibration-measured-not-claimed)
[![dataset](https://img.shields.io/badge/succession%20dataset-81%20verified%20rows-8957e5)](./data/successors.yaml)

[**Website**](https://mekkadev.github.io/dead-deps/) · [Methodology](https://mekkadev.github.io/dead-deps/methodology/) · [Dataset](./data/successors.yaml) · [Architecture](./docs/ARCHITECTURE.md) · [Contributing](./CONTRIBUTING.md)

</div>

```console
$ npx dead-deps
```

```
  dead-deps  ·  ~/projects/checkout-api
  ──────────────────────────────────────────────────────────────────────────────
  package-lock.json (npm lockfile v3) · 41 dependencies examined ·
  3 flagged · 2.4s

  HIJACK RISK request 2.88.2                                       score 100/100
    Unattended, still widely installed, and carrying open advisories —
    deprecated on npm, no release in 6.5 years. This is the profile supply-chain
    attackers look for.

    ├─ Deprecated on npm: "request has been deprecated, see
    │  https://github.com/request/request/issues/3142"
    │  ↳ https://www.npmjs.com/package/request
    ├─ No release in 6.5 years — 169x longer than this package has ever gone
    │  quiet before (its own median gap between releases is 8 days).
    │  ↳ https://www.npmjs.com/package/request
    └─ 26 issues opened in the past year, 3 closed (12%), averaging 0.3 comments
       each — people are asking and nobody is answering.
       ↳ https://github.com/request/request

    → undici
      what the ecosystem moved to · needs code changes · dead since 2020-02
      Node 18+ ships a global `fetch()` backed by undici, so most simple call
      sites need no dependency at all; reach for `got` when you want retries,
      hooks and streams in one package.
      alternatives: got · axios · node-fetch · postman-request

    confidence ●●● high


  DEPRECATED tslint 6.1.3 (dev)                                     score 89/100
    The maintainers deprecated this themselves — deprecated on npm, its
    repository is archived. It still installs, but it receives no fixes.

    ├─ Deprecated on npm, and the notice names "eslint" as the replacement:
    │  "TSLint has been deprecated in favor of ESLint."
    │  ↳ https://www.npmjs.com/package/tslint
    ├─ The source repository is archived: it is read-only, so no fix can be
    │  merged there.
    │  ↳ https://github.com/palantir/tslint
    └─ No release in 6.0 years — 157x longer than this package has ever gone
       quiet before (its own median gap between releases is 10 days).
       ↳ https://www.npmjs.com/package/tslint

    → typescript-eslint
      what the ecosystem moved to · needs code changes · dead since 2019-02
      typescript-eslint documents the TSLint story and a rule-by-rule
      comparison; `tslint-to-eslint-config` can convert an existing tslint.json
      into an ESLint config as a starting point.
      alternatives: @typescript-eslint/eslint-plugin · eslint · oxlint

    confidence ●●● high

  ──────────────────────────────────────────────────────────────────────────────
  3 dependencies need attention. Start with request → undici (needs code
  changes). 2 other flagged packages have a curated successor too.
  38 other dependencies were examined and deliberately not flagged — quiet is
  not the same as dead.
```

No install, no config, no account, no API key. It reads your lockfile, asks two public indexes about each direct dependency, and prints only what it can prove.

---

## Contents

- [What it does](#what-it-does)
- [Why this is hard: quiet is not dead](#why-this-is-hard-quiet-is-not-dead)
- [Calibration: measured, not claimed](#calibration-measured-not-claimed)
- [Install](#install)
- [Usage](#usage)
- [Use it in CI](#use-it-in-ci)
- [MCP server for AI agents](#mcp-server-for-ai-agents)
- [Use it as a library](#use-it-as-a-library)
- [The succession dataset](#the-succession-dataset)
- [How it compares](#how-it-compares)
- [FAQ](#faq)
- [What this does not do](#what-this-does-not-do)
- [Contributing](#contributing)
- [Prior art and acknowledgements](#prior-art-and-acknowledgements)

---

## What it does

**Finds unmaintained direct dependencies.** It reads `pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock` (classic and Berry), or a plain `package.json`, and judges the packages you actually chose — not the thousand transitive ones you cannot act on. Pass `--all` when you want the whole tree.

**Explains why, with clickable evidence.** Every verdict is a list of human-checkable facts with URLs: the npm deprecation notice, the archived repository, the release that never came, the issues nobody closed. A claim with no source behind it is a bug, not a feature.

**Points at the successor.** When a package is genuinely dead, the report names what the ecosystem actually moved to — a maintained fork, a rename, a replacement, or the platform feature that absorbed it — from a hand-verified dataset, never from a guess.

---

## Why this is hard: quiet is not dead

Most "abandoned dependency" checkers are a date comparison: no release in N months, therefore dead. That produces a wall of false positives, because **a small finished package looks exactly like a dead one if all you read is the last-release date.**

`ms` has not shipped since 2020. `inherits`, `once`, `wrappy`, `isarray` are older still. They are downloaded billions of times a month and are perfectly fine — there is simply nothing left to add. Telling somebody to migrate off `inherits` is not a finding, it is the tool becoming the problem. A report with forty entries gets closed and never run again.

So dead-deps is tuned for **precision over recall**, and the verdict is a state rather than a boolean:

| State | Meaning |
| --- | --- |
| `active` | Releases, commits or issue responses within the recent window. |
| `stable-complete` | Quiet because it is **finished**. Never reported as a problem. |
| `unknown` | Not enough coverage to judge. Reported as ignorance, not as a verdict. |
| `low-activity` | Slower than its own history predicts, but alive. Worth watching. |
| `unmaintained` | Releases stopped, issues go unanswered, no maintainer visibly active. |
| `deprecated` | The registry or the maintainers say so explicitly. A stated fact, not an inference. |
| `abandoned` | Unmaintained, plus a hard signal: archived or missing repository. |
| `hijack-risk` | Abandoned while still widely depended on, with an unpatched advisory or no one at the wheel. |

A few of the design decisions that fall out of that:

- **Silence is measured against each package's own rhythm**, not a fixed threshold. A package that always shipped once every three years is not accused of dying because it did so again.
- **Advisories only count when the newest release is still exposed to them.** A fixed advisory is evidence the maintainer showed up. (This is not theoretical — an early build flagged `ms@2.1.3` as a hijack risk over a ReDoS that was patched in `2.0.0`.)
- **Popularity is context, not a vital sign.** Download counts do not maintain a package; they only decide how many people are hurt when nobody does.
- **Stale upstream data is disclosed, never hidden.** Public indexes lag by months. A verdict resting on two-year-old issue data says so and drops its confidence.
- **The report states how many dependencies were examined and deliberately *not* flagged.** Showing restraint is what earns trust on the first run.

---

## Calibration: measured, not claimed

A precision claim is worthless unless it is measured, so the detector is scored against [`data/calibration.yaml`](./data/calibration.yaml) — 49 hand-labelled real packages, deliberately adversarial.

Thirteen of them are the finished-but-quiet trap. The corpus also contains **the trap inverted**: `code-point-at` and `path-is-absolute` are tiny, ancient micro-libraries that look exactly like `once`, but carry real deprecation notices and archived repositories. A detector cannot pass by learning "small and old means fine" either.

<!--CALIBRATION-TABLE-->

| Metric | Value | Basis |
| --- | --- | --- |
| **False positives on finished packages** | **0.0%** | 0 / 13 `stable-complete` |
| False alarms on anything healthy | 0.0% | 0 / 25 `active` + `stable-complete` |
| Missed dead packages | 33.3% | 8 / 24 rows at or above `low-activity` |
| Strict accuracy (exact state) | 75.5% | 37 / 49 |
| Lenient accuracy (near misses forgiven) | 79.6% | 37 / 49 |

*Corpus: 49 hand-labelled packages. Generated by `npm run calibrate`; numbers here are never hand-written.*

**The misses are the honest cost of the precision bias, and they are the real number to judge this on.** Five of the eight are the fuzzy `low-activity` boundary — packages like `grunt` and `morgan` that still ship occasionally, where "slow" and "alive" are both defensible readings. Three are genuine: `colors`, `browserify` and `underscore.string` read as healthy through upstream signals alone. Two of those three are caught anyway, because the curated dataset overrides the inference (see below).

The detector is scored **without** the succession dataset, which is applied as a floor later in the pipeline. Grading it on answers it was handed would make the numbers meaningless. Methodology and the full list of limits: [`docs/CALIBRATION.md`](./docs/CALIBRATION.md).

Run it yourself — it performs real lookups and prints a confusion matrix, per-label precision and recall, and every disagreement with the evidence that drove it:

```console
$ npm run calibrate
```

---

## Install

Run it without installing anything:

```console
$ npx dead-deps
```

Or install it:

```console
$ npm install -g dead-deps        # global CLI
$ npm install -D dead-deps        # project dev dependency
```

Requires **Node.js 20.10 or newer**. Two runtime dependencies (`yaml`, `@modelcontextprotocol/sdk`) and nothing else.

---

## Usage

```console
$ dead-deps [path] [options]
```

`path` may be a directory, a lockfile, or a `package.json`. It defaults to the current directory, where dead-deps picks `pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json` or `yarn.lock`, in that order, and falls back to `package.json`.

### Scope

| Flag | Default | Description |
| --- | --- | --- |
| `--all` | off | Include transitive dependencies, not just your direct ones. |
| `--limit <n>` | `5` | Maximum findings to show. |
| `--min-state <state>` | `low-activity` | Minimum severity to report. Any state from the table above. |

### Output

| Flag | Description |
| --- | --- |
| `--json` | Machine-readable report on stdout. Never coloured. |
| `--quiet`, `-q` | Suppress progress on stderr; the report still prints. |
| `--no-color` | Disable ANSI colour even on a terminal. |
| `--version`, `-v` | Print the version and exit. |
| `--help`, `-h` | Print help and exit. |

### Network

| Flag | Default | Description |
| --- | --- | --- |
| `--contact <email>` | `$DEAD_DEPS_CONTACT` | Sent upstream so ecosyste.ms can reach you, which puts your requests in their polite pool. |
| `--concurrency <n>` | `8` | Maximum parallel upstream requests. |
| `--no-cache` | off | Bypass the on-disk cache and re-fetch everything. |
| `--cache-ttl <hours>` | `24` | How long cached responses stay usable. |

### Environment

| Variable | Description |
| --- | --- |
| `DEAD_DEPS_CONTACT` | Default for `--contact`. |
| `DEAD_DEPS_CACHE_DIR` | Override the cache location (default: `$XDG_CACHE_HOME/dead-deps` or `~/.cache/dead-deps`). |
| `DEAD_DEPS_DEBUG` | Print stack traces instead of one-line errors. |
| `NO_COLOR` | Disable colour (any non-empty value). |

### Exit codes

A stable contract — gate CI on these.

| Code | Meaning |
| --- | --- |
| `0` | Clean. Nothing was flagged. |
| `1` | At least one dependency was flagged. |
| `2` | Usage error: unknown flag, bad value, or unreadable path. |
| `3` | Runtime error: no lockfile found, upstream unreachable. |

### Examples

```console
# Scan this project's direct dependencies and show the worst few
$ dead-deps

# Sweep the whole tree and report only what is clearly no longer maintained
$ dead-deps --all --min-state unmaintained --limit 20

# Scan one workspace and keep the machine-readable report
$ dead-deps ./services/api --json > dead-deps.json

# A CI gate: exits 1 the moment anything deprecated or worse turns up
$ dead-deps --min-state deprecated --quiet
```

---

## Use it in CI

```yaml
name: dependency health

on:
  pull_request:
  schedule:
    - cron: '0 6 * * 1' # Mondays — abandonment is a slow-moving problem

jobs:
  dead-deps:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Check for abandoned dependencies
        run: npx dead-deps --min-state deprecated --limit 20
        env:
          DEAD_DEPS_CONTACT: you@example.com
```

The step fails when anything `deprecated` or worse is found. Start with `--min-state deprecated` — it only fires on facts stated by the registry or the maintainers, so it is the setting least likely to argue with you. Tighten to `unmaintained` once the obvious ones are cleared.

---

## MCP server for AI agents

Ask a coding agent "what replaced `request`?" and it will answer from memory — confidently, and sometimes with a package name that does not exist. That failure mode has a name, **slopsquatting**, and attackers register the hallucinated names.

This MCP server exists so an agent can look the answer up instead of recalling it, and get evidence URLs back.

```jsonc
// Claude Code — .mcp.json
{
  "mcpServers": {
    "dead-deps": {
      "command": "npx",
      "args": ["-y", "dead-deps-mcp"]
    }
  }
}
```

```jsonc
// Cursor — .cursor/mcp.json
{
  "mcpServers": {
    "dead-deps": {
      "command": "npx",
      "args": ["-y", "dead-deps-mcp"]
    }
  }
}
```

| Tool | What it does |
| --- | --- |
| `scan_lockfile` | Reads a real lockfile and returns verified maintenance verdicts for its dependencies. |
| `check_package` | Assesses one npm package: state, score, confidence, and evidence with URLs. |
| `find_successor` | Looks up what replaced a package in the curated dataset. |

`find_successor` is the point of it. When there is no curated record it **says so** rather than inventing a plausible package name. The restraint is the feature: an agent that gets "no verified successor on record" writes better code than one that gets a confident hallucination.

---

## Use it as a library

```ts
import { scan, renderJson, assess, gatherSignals, HttpClient } from 'dead-deps';

const result = await scan('./', { all: false, limit: 10, contact: 'you@example.com' });

for (const finding of result.findings) {
  console.log(finding.dependency.name, finding.assessment.state);
  for (const evidence of finding.assessment.evidence) {
    console.log('  ', evidence.label, evidence.url ?? '');
  }
  if (finding.successor) {
    console.log('  →', finding.successor.to, `(${finding.successor.type})`);
  }
}
```

Assess a single package without a lockfile:

```ts
const http = new HttpClient({ contact: 'you@example.com', cacheTtlHours: 24, noCache: false, concurrency: 8 });
const assessment = assess(await gatherSignals(http, 'request'));
```

Every type is exported and documented in [`src/types.ts`](./src/types.ts).

---

## The succession dataset

[`data/successors.yaml`](./data/successors.yaml) maps packages that stopped being maintained to whatever actually succeeded them. **81 rows, 178 primary-source evidence links**, every one hand-checked. Each row is published as its own page — for example [what replaced `request`](https://mekkadev.github.io/dead-deps/p/request/).

The distribution is the interesting part, because it refutes the assumption the project started from — that finding the **maintained fork** is the job:

| Succession type | Rows | Example |
| --- | ---: | --- |
| `rename` | 23 | `koa-router` → `@koa/router` |
| `self-declared` | 19 | `moment` → `luxon` (named by its own maintainers) |
| `absorbed` | 15 | `left-pad` → `String.prototype.padStart` |
| `replacement` | 15 | `request` → `undici` |
| `fork` | 5 | `faker` → `@faker-js/faker` |
| `reimplementation` | 4 | `node-sass` → `sass` |

**Forks are the rarest case.** A tool that only looked for the maintained fork would cover 6% of real successions. Six rows point at a platform feature rather than a package at all, where the correct advice is to delete the dependency entirely.

Rows about small, finished, still-working packages are refused outright. The dataset is a map of successions, not a list of packages someone finds unfashionable. The bar for adding one is in [`data/SCHEMA.md`](./data/SCHEMA.md), and [contributions are very welcome](./CONTRIBUTING.md) — a package you personally know is dead is exactly the knowledge this file needs.

---

## How it compares

| | dead-deps | `npm outdated` | depcheck | Renovate / Dependabot | Snyk / Socket |
| --- | --- | --- | --- | --- | --- |
| Finds **abandoned** packages | ✅ | ❌ (only behind-latest) | ❌ (only unused) | Partly | ✅ |
| Distinguishes **finished** from dead | ✅ | — | — | ❌ | ❌ |
| Names the **successor** | ✅ curated | ❌ | ❌ | ❌ | ❌ |
| Evidence you can click | ✅ | ❌ | ❌ | Partly | Partly |
| Runs with no account | ✅ | ✅ | ✅ | ❌ | ❌ |
| MCP server for agents | ✅ | ❌ | ❌ | ❌ | ❌ |
| Open source | ✅ MIT | ✅ | ✅ | Partly | ❌ |

These are complements, not competitors. Renovate keeps current dependencies current; dead-deps tells you which ones will never have a newer version to move to.

---

## FAQ

**Is `request` still maintained?** No — it was deprecated in February 2020 and has had no release since. The ecosystem moved to `undici`, which now backs Node's global `fetch()`. [Full evidence →](https://mekkadev.github.io/dead-deps/p/request/)

**What replaced `moment`?** Its own maintainers put it in maintenance mode and named `luxon` as the successor; `date-fns` and `dayjs` are the other common choices, and `Intl.DateTimeFormat` may remove the dependency entirely. [Full evidence →](https://mekkadev.github.io/dead-deps/p/moment/)

**Is there a maintained fork of `faker.js`?** Yes — `@faker-js/faker`, created by the community after the original was withdrawn in January 2022. [Full evidence →](https://mekkadev.github.io/dead-deps/p/faker/)

**Why does it not flag `ms` / `inherits` / `once`?** Because they are finished, not abandoned. See [quiet is not dead](#why-this-is-hard-quiet-is-not-dead) — keeping them out of the report is the tool's main design goal, and it is measured.

**Why did it flag something I know is fine?** That is a bug worth reporting, and the [false-positive issue template](https://github.com/mekkadev/dead-deps/issues/new?template=false-positive.md) feeds straight into the calibration corpus. Please file it.

**Does it upload my code?** No. It reads lockfile entries — package names and versions — and queries two public indexes about those names. Nothing else leaves your machine, and dependency code is never executed. See [`SECURITY.md`](./SECURITY.md).

**Does it need an API key?** No. Both upstreams are public and unauthenticated. Setting `--contact` is optional politeness that gets you better rate limits.

**Does it support Python, Go, Rust?** Not yet — npm only, deliberately. Each ecosystem multiplies the metadata work, and one ecosystem done properly beats four done shallowly.

---

## What this does not do

- **It is not a vulnerability scanner.** Advisories are read as evidence of abandonment, not as a CVE report. Use `npm audit`, Snyk or Socket for that.
- **It does not decide for you.** An unmaintained dependency that is pinned, vendored and working may be perfectly rational to keep. The tool reports state; the judgement is yours.
- **Coverage of the dataset is finite.** 81 successions is a start, not the long tail. A package with no curated row still gets a verdict, just no successor.
- **Upstream indexes lag.** Issue and repository data can be months old. When it is, the report says so and lowers its confidence rather than pretending.
- **npm only.** See the FAQ.

---

## Contributing

The most valuable contribution is **a succession row you know to be true** — see [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`data/SCHEMA.md`](./data/SCHEMA.md). Second most valuable is a false-positive report.

```console
$ git clone https://github.com/mekkadev/dead-deps && cd dead-deps
$ npm install
$ npm test          # 163 tests, no network
$ npm run typecheck
$ npm run build
$ npm run site      # build the static site into site/dist
$ npm run calibrate # score the detector against the labelled corpus
```

The codebase is mapped in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

---

## Prior art and acknowledgements

Built on **[ecosyste.ms](https://ecosyste.ms/)** — an open, free, no-key API covering packages, repositories, commits, issues and advisories across ecosystems. This project would be a web scraper without it. It is run by Andrew Nesbitt, who also built Libraries.io, and it deserves your [sponsorship](https://github.com/sponsors/andrew) more than this repo deserves your star.

Also standing on **[the npm registry](https://registry.npmjs.org/)** for authoritative deprecation data, and on the maintainers of the 81 packages in the dataset — most of whom did years of unpaid work and then said so plainly when they stopped. Abandonment is normal. This tool exists to route around it, not to shame anyone for it.

Related tools worth knowing: [`depcheck`](https://github.com/depcheck/depcheck) for unused dependencies, [Renovate](https://github.com/renovatebot/renovate) for keeping current ones current, [OSV](https://osv.dev/) and [deps.dev](https://deps.dev/) for vulnerability and dependency-graph data.

---

## License

[MIT](./LICENSE) © mekkadev
