<div align="center">

# dead-deps

**Find abandoned and unmaintained npm dependencies in your lockfile — and the maintained fork or replacement that succeeded them.**

Evidence-backed. Zero config. No account. Works as a CLI, a CI gate, a library, and an MCP server for AI agents.

[![CI](https://github.com/mekkadev/dead-deps/actions/workflows/ci.yml/badge.svg)](https://github.com/mekkadev/dead-deps/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dead-deps.svg)](https://www.npmjs.com/package/dead-deps)
[![license: MIT](https://img.shields.io/npm/l/dead-deps.svg)](./LICENSE)
[![node: >=20.10](https://img.shields.io/node/v/dead-deps.svg)](https://nodejs.org/)
[![false positives: 0%](https://img.shields.io/badge/false%20positives-0%25-brightgreen)](#calibration-measured-not-claimed)

[**Website**](https://mekkadev.github.io/dead-deps/) · [**Methodology**](https://mekkadev.github.io/dead-deps/methodology/) · [**The dataset**](./data/successors.yaml) · [**Architecture**](./docs/ARCHITECTURE.md)

</div>

---

```console
$ npx dead-deps
```

```
  dead-deps  ·  ~/projects/checkout-api
  ──────────────────────────────────────────────────────────────────────────────
  package-lock.json (npm lockfile v3) · 15 dependencies examined ·
  3 flagged · 1.1s

  HIJACK RISK request ^2.88.2                                      score 100/100
    Unattended, still widely installed, and carrying open advisories —
    deprecated on npm, no release in 6.5 years. This is the profile supply-chain
    attackers look for.

    ├─ Deprecated on npm: "request has been deprecated, see
    │  https://github.com/request/request/issues/3142"
    │  ↳ https://www.npmjs.com/package/request
    ├─ 26 issues opened in the past year, 3 closed (12%), averaging 0.3 comments
    │  each — people are asking and nobody is answering.
    │  ↳ https://github.com/request/request
    └─ Open moderate advisory GHSA-p8p7-x288-28g6: Server-Side Request Forgery
       in Request — published 3.4 years ago with no release since.
       ↳ https://github.com/advisories/GHSA-p8p7-x288-28g6

    → undici
      what the ecosystem moved to · needs code changes · dead since 2020-02
      Node 18+ ships a global `fetch()` backed by undici, so most simple call
      sites need no dependency at all; reach for `got` when you want retries,
      hooks and streams in one package.
      alternatives: got · axios · node-fetch · postman-request

    confidence ●●● high


  DEPRECATED tslint ^6.1.3 (dev)                                    score 89/100
    The maintainers deprecated this themselves — deprecated on npm, its
    repository is archived. It still installs, but it receives no fixes.

    ├─ Deprecated on npm, and the notice names "eslint" as the replacement:
    │  "TSLint has been deprecated in favor of ESLint. Please see
    │  https://github.com/palantir/tslint/issues/4534 for more information."
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
  12 other dependencies were examined and deliberately not flagged — quiet is
  not the same as dead.
```

That is real output, not a mockup. It reads your lockfile, asks two public indexes about each direct dependency, and prints only what it can prove.

## Table of contents

- [What it does](#what-it-does)
- [Why detecting abandoned packages is harder than it looks](#why-detecting-abandoned-packages-is-harder-than-it-looks)
- [Calibration: measured, not claimed](#calibration-measured-not-claimed)
- [Install](#install)
- [Usage](#usage)
- [CI usage](#ci-usage)
- [MCP server: stop your agent inventing package names](#mcp-server-stop-your-agent-inventing-package-names)
- [Library API](#library-api)
- [The succession dataset](#the-succession-dataset)
- [How a verdict is reached](#how-a-verdict-is-reached)
- [What dead-deps does not do](#what-dead-deps-does-not-do)
- [FAQ](#faq)
- [How it compares](#how-it-compares)
- [Contributing](#contributing)
- [Prior art and thanks](#prior-art-and-thanks)

## What it does

**1. Finds unmaintained direct dependencies.** Reads `pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock` (classic and Berry) or a plain `package.json`, and judges the packages you actually chose — not the thousand transitive ones you cannot act on. Pass `--all` when you want the whole tree.

**2. Explains why, with clickable evidence.** Every verdict is a list of human-checkable facts, each with a URL: the npm deprecation notice, the archived repository, the release that never came, the issues nobody answered. A claim without a source behind it is a bug in this tool, not a feature.

**3. Names the successor.** When a package is genuinely dead, the report says what the ecosystem moved to — a maintained fork, a rename, a straight replacement, or the platform feature that absorbed it — from a hand-verified dataset, never from a guess.

## Why detecting abandoned packages is harder than it looks

The naive version of this tool is twenty lines: read the lockfile, check the last publish date, complain about anything older than a year. It is also useless, because it flags this:

```
ms          no release in 5.7 years    ← perfectly fine
inherits    no release in 8.1 years    ← perfectly fine
once        no release in 7.4 years    ← perfectly fine
isarray     no release in 9.2 years    ← perfectly fine
```

Those packages are **finished**, not abandoned. They do one small thing, they do it correctly, and there is nothing left to ship. A tool that tells you to migrate off `inherits` has stopped being a tool and started being the problem — and users uninstall it after one run.

So `dead-deps` is tuned for **precision over recall**, and the design follows from that:

- **Silence is measured against each package's own history**, never a fixed threshold. Two years of quiet means nothing for a package that always shipped every three years, and means a great deal for one that shipped weekly.
- **The verdict is a state, not a boolean.** `stable-complete` exists specifically so that finished packages have somewhere to go that is not "dead".
- **Popularity is never evidence of health.** `enzyme` has ~30,000 dependent packages *because* it was popular before it died. Counting adoption as a sign of life is how a six-year-dead package scores as healthy — so adoption feeds only the supply-chain risk assessment, where large reach is a reason for concern.
- **Triage without releases is not maintenance.** A repository that closes issues but has shipped nothing in years is tidying its tracker; those fixes are not reaching anyone who installed the package.
- **Already-patched advisories do not count.** An advisory fixed in a later release is evidence the maintainer *showed up*. Counting it once flagged `ms@2.1.3` as a hijack risk over a ReDoS patched back in 2.0.0.
- **Stale data is disclosed, not hidden.** Upstream indexes lag. When a verdict rests on year-old issue data, the report says so and drops its own confidence.

## Calibration: measured, not claimed

A precision claim is worthless unless it is measured, so the detector is scored against [`data/calibration.yaml`](./data/calibration.yaml) — a hand-labelled, deliberately adversarial corpus of real npm packages.

Its most important bucket is `stable-complete`: the finished-but-quiet packages a naive detector flags. The corpus also contains the **trap inverted** — `code-point-at` and `path-is-absolute` are tiny, ancient micro-libraries that look exactly like `once`, but carry real deprecation notices and archived repositories. A detector cannot pass by learning "small and old means fine" either.

<!--CALIBRATION-TABLE-->

| Metric | Value | Basis |
| --- | --- | --- |
| **False positives on finished packages** | **0.0%** | 0 / 13 `stable-complete` |
| False alarms on anything healthy | **0.0%** | 0 / 30 `active` + `stable-complete` |
| Missed dead packages | 4.2% | 1 / 24 rows at or above `low-activity` |
| Strict accuracy (exact state) | 83.3% | 45 / 54 |
| Lenient accuracy (near misses forgiven) | 87.0% | 47 / 54 |

_Corpus: 54 hand-labelled packages. Regenerate with `npm run calibrate`._

Two things about these numbers, stated plainly because they are what makes them trustworthy:

- **The detector is scored without the succession dataset.** Curated knowledge is applied later, as a floor in `scan()`, precisely so the harness cannot grade the detector on answers it was handed.
- **The one remaining miss is real, and stays.** `underscore.string` is indistinguishable from a finished package by metadata alone: no deprecation notice, no archived repository, no open issues, thousands of dependents. It could be closed by adding a dataset row — but no maintainer ever named a successor, so such a row would be one person's opinion dressed as consensus, which is precisely what [the inclusion rules](./data/SCHEMA.md) forbid. A miss that is honestly reported is worth more than a dataset you cannot trust.

Run `npm run calibrate` yourself. It performs real lookups, prints the confusion matrix, per-label precision and recall, and every disagreement with the evidence that drove it. Methodology and limits: [`docs/CALIBRATION.md`](./docs/CALIBRATION.md).

## Install

Run it without installing anything:

```console
npx dead-deps
```

Install it globally, or add it to a project:

```console
npm install -g dead-deps      # global CLI
npm install -D dead-deps      # project dev dependency
pnpm add -D dead-deps
yarn add -D dead-deps
```

Requires **Node 20.10 or newer**. Two runtime dependencies, no build step, no API key, no signup.

## Usage

```console
dead-deps [path] [options]
```

`path` may be a directory, a lockfile, or a `package.json`. It defaults to the current directory, where `dead-deps` picks `pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json` or `yarn.lock`, in that order, and falls back to `package.json`.

### Scope

| Flag | Default | What it does |
| --- | --- | --- |
| `--all` | off | Include transitive dependencies. Off by default: you cannot act on them directly. |
| `--limit <n>` | `5` | Maximum findings to show. |
| `--min-state <state>` | `low-activity` | Minimum severity to report. One of `active`, `stable-complete`, `unknown`, `low-activity`, `unmaintained`, `deprecated`, `abandoned`, `hijack-risk`. |

### Output

| Flag | Default | What it does |
| --- | --- | --- |
| `--json` | off | Machine-readable report on stdout. Never coloured. |
| `--quiet`, `-q` | off | Suppress progress on stderr; the report still prints. |
| `--no-color` | auto | Disable ANSI colour even on a terminal. |
| `--version`, `-v` | — | Print the version and exit. |
| `--help`, `-h` | — | Print help and exit. |

### Network

| Flag | Default | What it does |
| --- | --- | --- |
| `--contact <email>` | `$DEAD_DEPS_CONTACT` | Sent upstream so ecosyste.ms can reach you, which puts your requests in their polite pool. |
| `--concurrency <n>` | `8` | Maximum parallel upstream requests. |
| `--no-cache` | off | Bypass the on-disk cache and re-fetch everything. |
| `--cache-ttl <hours>` | `24` | How long cached responses stay usable. |

### Environment

| Variable | Effect |
| --- | --- |
| `DEAD_DEPS_CONTACT` | Default for `--contact`. |
| `DEAD_DEPS_CACHE_DIR` | Override the cache location (default `$XDG_CACHE_HOME/dead-deps` or `~/.cache/dead-deps`). |
| `DEAD_DEPS_DEBUG` | Print stack traces instead of one-line errors. |
| `NO_COLOR` | Disable colour (any non-empty value). |

### Examples

```console
# Scan this project's direct dependencies and show the worst few.
dead-deps

# Sweep the whole tree and report only what is clearly no longer maintained.
dead-deps --all --min-state unmaintained --limit 20

# Scan one workspace and keep the machine-readable report.
dead-deps ./services/api --json > dead-deps.json

# A CI gate: exits 1 the moment anything deprecated or worse turns up.
dead-deps --min-state deprecated --quiet
```

## CI usage

Exit codes are a stable contract:

| Code | Meaning |
| --- | --- |
| `0` | Clean — nothing was flagged. |
| `1` | At least one dependency was flagged. **Gate CI on this.** |
| `2` | Usage error — unknown flag, bad value, unreadable path. |
| `3` | Runtime error — no lockfile found, upstream unreachable. |

```yaml
name: dependency health

on:
  pull_request:
  schedule:
    - cron: '0 6 * * 1' # Mondays — new abandonments appear over time, not on push

jobs:
  dead-deps:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Fail on deprecated or abandoned dependencies
        run: npx dead-deps --min-state deprecated --limit 20
        env:
          DEAD_DEPS_CONTACT: you@example.com
```

Start with `--min-state deprecated` so the gate only fires on facts stated by upstream. Tighten to `unmaintained` once the existing findings are cleared.

## MCP server: stop your agent inventing package names

Ask any LLM "what replaced `request`?" and you will usually get a good answer. Ask it about something obscure and you may get a package that **does not exist** — which is precisely the opening that [slopsquatting](https://en.wikipedia.org/wiki/Typosquatting) attacks are built on: register the hallucinated name, wait for someone to install it.

`dead-deps` ships an MCP server so an agent can look the answer up instead of recalling it. When there is no curated record, it says so rather than guessing. **That restraint is the feature.**

| Tool | What it does |
| --- | --- |
| `scan_lockfile` | Scans a real lockfile and returns verified maintenance verdicts with evidence. |
| `check_package` | Assesses one npm package: state, score, confidence, evidence URLs, curated successor. |
| `find_successor` | Looks up what replaced a package. Returns "no curated record" rather than a guess. |

**Claude Code** — `.mcp.json` in your project, or `~/.claude.json` globally:

```json
{
  "mcpServers": {
    "dead-deps": {
      "command": "npx",
      "args": ["-y", "dead-deps-mcp"],
      "env": { "DEAD_DEPS_CONTACT": "you@example.com" }
    }
  }
}
```

**Cursor** — `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "dead-deps": {
      "command": "npx",
      "args": ["-y", "dead-deps-mcp"]
    }
  }
}
```

## Library API

```ts
import { scan, renderTerminal, renderJson } from 'dead-deps';

const result = await scan('./', { all: false, limit: 10, minState: 'unmaintained' });

for (const finding of result.findings) {
  console.log(finding.dependency.name, finding.assessment.state);
  for (const item of finding.assessment.evidence) console.log('  ', item.label, item.url);
  if (finding.successor) console.log('  →', finding.successor.to, `(${finding.successor.type})`);
}

console.log(renderTerminal(result, { color: false }));
console.log(renderJson(result)); // stable shape, carries schemaVersion
```

`assess`, `gatherSignals`, `loadSuccessors` and `lookupSuccessor` are exported too, along with every type. See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## The succession dataset

[`data/successors.yaml`](./data/successors.yaml) is **81 hand-verified rows**, each carrying primary-source evidence — 178 evidence URLs in total, every one checked. A row is only added when the succession is *consensus*, not opinion, and small finished packages are refused outright. The rules are in [`data/SCHEMA.md`](./data/SCHEMA.md).

The breakdown refutes the assumption this project started from — that finding a **maintained fork** is the job:

| Succession type | Rows | Example |
| --- | ---: | --- |
| `rename` | 23 | `koa-router` → `@koa/router` |
| `self-declared` | 19 | `moment` → `luxon` (named by its own maintainers) |
| `absorbed` | 15 | `left-pad` → `String.prototype.padStart` |
| `replacement` | 15 | `request` → `undici` |
| `fork` | **5** | `faker` → `@faker-js/faker` |
| `reimplementation` | 4 | `node-sass` → `sass` |

Forks are the **rarest** outcome. A tool that only looked for maintained forks would cover 6% of real cases.

Six rows point at a platform feature rather than a package (`toKind: platform`), because "delete the dependency, JavaScript does this now" is both the honest answer and the better one. Six more have no credible successor at all, and say so.

Every row is published as its own page: [`request`](https://mekkadev.github.io/dead-deps/p/request/), [`node-sass`](https://mekkadev.github.io/dead-deps/p/node-sass/), [`moment`](https://mekkadev.github.io/dead-deps/p/moment/), [`enzyme`](https://mekkadev.github.io/dead-deps/p/enzyme/) — or [browse all 81](https://mekkadev.github.io/dead-deps/).

**Found a missing one?** Open a [successor report](https://github.com/mekkadev/dead-deps/issues/new?template=successor-report.md). Rows need a primary source, not a blog post.

## How a verdict is reached

```
target → lockfile → signals → assess() → curated floor → report
```

Signals come from [ecosyste.ms](https://ecosyste.ms) (registry, repository, issue responsiveness, advisories) and the npm registry (deprecation, release timeline). Both are public and need no key.

| State | Meaning |
| --- | --- |
| `active` | Releases, commits or issue responses within the recent window. Nothing to do. |
| `stable-complete` | Quiet but finished. Never reported as a problem. |
| `unknown` | Not enough coverage to judge. Reported as ignorance, not as a verdict. |
| `low-activity` | Slower than its own history predicts, with signs of life. Worth watching. |
| `unmaintained` | Releases have stopped relative to its own baseline; nobody is visibly active. |
| `deprecated` | Upstream says so explicitly. A statement of fact, not an inference. |
| `abandoned` | Unmaintained plus a hard signal: archived or missing repository. |
| `hijack-risk` | Abandoned while still widely depended on, with unpatched advisories. |

Full reasoning, including every threshold: [methodology](https://mekkadev.github.io/dead-deps/methodology/).

## What dead-deps does not do

- **It is not a vulnerability scanner.** Advisories are read as evidence of neglect, not enumerated for triage. Use `npm audit`, OSV or Snyk for CVEs.
- **npm only.** PyPI, crates.io and the rest are not supported. Doing one ecosystem properly beat doing four badly.
- **Direct dependencies by default.** Transitive ones are noise you cannot act on; `--all` if you disagree.
- **Curated coverage is finite.** 81 successions is a strong start, not the whole registry. A dead package outside the dataset still gets a verdict — just no successor.
- **Upstream indexes lag.** Issue data can be a year or more stale. The tool tells you when it is.
- **It will not tell you whether to migrate.** A pinned, vendored, working dependency may be perfectly rational to keep. It reports state; the decision is yours.

## FAQ

**Is `request` still maintained?**
No. It was fully deprecated in February 2020 and has had no release since. Most call sites can use the global `fetch()` built into Node 18+, which is backed by [`undici`](https://mekkadev.github.io/dead-deps/p/request/).

**What replaced `moment.js`?**
Its own maintainers put it in maintenance mode and named [Luxon](https://mekkadev.github.io/dead-deps/p/moment/) as the successor, alongside `date-fns` and `day.js`. If you only format dates, native `Intl.DateTimeFormat` may remove the dependency entirely.

**Is there a maintained fork of `faker.js`?**
Yes — [`@faker-js/faker`](https://mekkadev.github.io/dead-deps/p/faker/), created by the community after the original was sabotaged in January 2022.

**My package was flagged but it is finished, not abandoned. What now?**
That is a bug and the most valuable report you can file. Open a [false positive report](https://github.com/mekkadev/dead-deps/issues/new?template=false-positive.md) — those reports are how the calibration corpus grows.

**Does it send my code anywhere?**
No. It reads dependency *names* from your lockfile and asks two public indexes about them. Nothing from your project is uploaded, and no dependency code is executed. See [`SECURITY.md`](./SECURITY.md).

**Why does it need my email address?**
It does not — it is optional. Supplying `--contact` puts your requests in the ecosyste.ms polite pool, which is faster and is simply good manners toward a free public service.

**Why are direct dependencies the default?**
Because a report about a transitive package you cannot upgrade is noise. Fix your own `package.json` first; `--all` is there when you need the full picture.

## How it compares

| | `dead-deps` | `npm audit` | Dependabot / Renovate | Commercial SCA |
| --- | --- | --- | --- | --- |
| Finds unmaintained packages | ✅ | ❌ | partial | ✅ |
| Names the successor | ✅ curated | ❌ | ❌ | rarely |
| Explains with evidence URLs | ✅ | ❌ | ❌ | varies |
| Tuned against a public corpus | ✅ 0% FP | — | — | undisclosed |
| Distinguishes finished from dead | ✅ | — | ❌ | ❌ |
| MCP server for agents | ✅ | ❌ | ❌ | ❌ |
| Price | free, MIT | free | free | from $10/user/mo |

They are complementary: `npm audit` for CVEs, Renovate for version bumps, `dead-deps` for the question neither answers — *is anyone still home, and where did everyone go?*

## Contributing

Dataset rows, false-positive reports and new lockfile formats are all welcome. Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

```console
git clone https://github.com/mekkadev/dead-deps.git
cd dead-deps && npm install
npm test          # 163 tests, no network
npm run typecheck
npm run calibrate # scores the detector against the labelled corpus
npm run site      # builds the static site into site/dist
```

## Prior art and thanks

Built on [**ecosyste.ms**](https://ecosyste.ms) — Andrew Nesbitt's open index of package, repository and issue metadata, free and unauthenticated. This project would not be feasible without it; if you find `dead-deps` useful, [support ecosyste.ms](https://opencollective.com/ecosystems).

Also standing on [OSV](https://osv.dev), the [npm registry API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md), and the maintainers who take the time to write a proper deprecation notice — they make this job dramatically easier.

## License

[MIT](./LICENSE) © mekkadev
