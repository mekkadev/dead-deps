# dead-deps

Find abandoned and unmaintained npm dependencies in your lockfile — and the maintained fork or replacement that succeeded them. Evidence-backed CLI + MCP server.

[![CI](https://github.com/mekkadev/dead-deps/actions/workflows/ci.yml/badge.svg)](https://github.com/mekkadev/dead-deps/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dead-deps.svg)](https://www.npmjs.com/package/dead-deps)
[![license: MIT](https://img.shields.io/npm/l/dead-deps.svg)](./LICENSE)
[![node: >=20.10](https://img.shields.io/node/v/dead-deps.svg)](https://nodejs.org/)

```console
$ npx dead-deps
```

```
  dead-deps  ·  /home/you/projects/checkout-api
  ──────────────────────────────────────────────────────────────────────────────
  package-lock.json (npm lockfile v3) · 41 of 604 dependencies examined ·
  3 flagged · 563 skipped · 4.3s

  ABANDONED request 2.88.2                                          score 96/100
    No longer maintained, and nothing further is coming — deprecated on npm, no
    release in 6.5 years.

    ├─ Deprecated on npm: "request has been deprecated, see
    │  https://github.com/request/request/issues/3142"
    │  ↳ https://www.npmjs.com/package/request
    ├─ 18 issues opened in the past year, 1 closed (6%), averaging 0.3 comments
    │  each — people are asking and nobody is answering.
    │  ↳ https://github.com/request/request
    └─ No release in 6.5 years — 113x longer than this package has ever gone
       quiet before (its own median gap between releases is 21 days).
       ↳ https://www.npmjs.com/package/request

    → undici
      what the ecosystem moved to · needs code changes · dead since 2020-02
      Node 18+ ships a global `fetch()` backed by undici, so most simple call
      sites need no dependency at all; reach for `got` when you want retries,
      hooks and streams in one package.
      alternatives: got · axios · node-fetch · postman-request

    confidence ●●● high


  UNMAINTAINED bluebird 3.7.2                                       score 69/100
    Nobody is maintaining this any more — no release in 6.7 years. Bugs you hit
    are yours to work around.

    ├─ 12 issues opened in the past year, 1 closed (8%), averaging 0.4 comments
    │  each — people are asking and nobody is answering.
    │  ↳ https://github.com/petkaantonov/bluebird
    ├─ No release in 6.7 years — 174x longer than this package has ever gone
    │  quiet before (its own median gap between releases is 9 days).
    │  ↳ https://www.npmjs.com/package/bluebird
    └─ No maintainer has commented, closed an issue or merged a pull request in
       the past year.
       ↳ https://github.com/petkaantonov/bluebird

    → Promise (native)
      absorbed into the platform · needs code changes · dead since 2019-11
      Delete the `require('bluebird')` and rely on the global Promise; for the
      concurrency helpers Bluebird provided, `Promise.map` maps onto p-map and
      `Promise.promisify` onto `util.promisify`.
      alternatives: p-limit · p-map · p-retry

    confidence ●●○ medium

  ──────────────────────────────────────────────────────────────────────────────
  3 dependencies need attention. Start with request → undici (needs code
  changes). 1 other flagged package has a curated successor too.
  38 other dependencies were examined and deliberately not flagged — quiet is
  not the same as dead.
```

No install, no config, no account. It reads your lockfile, asks two public indexes about each direct dependency, and prints what it can prove.

## What it does

- **Finds unmaintained direct dependencies.** It reads `pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock` (classic and Berry), or plain `package.json`, and judges the packages you actually chose — not the thousand transitive ones you cannot act on.
- **Explains why, with clickable evidence.** Every verdict is a list of human-checkable facts with URLs: the npm deprecation notice, the archived repository, the release that never came, the issues nobody closed. If a claim has no source behind it, that is a bug, not a feature.
- **Points at the curated successor.** When a package is genuinely dead, the report names what the ecosystem moved to — a maintained fork, a rename, a replacement, or the platform feature that absorbed it — from a hand-verified dataset, never from a guess.

## Why this is hard: quiet is not dead

The obvious way to detect an abandoned npm dependency is to read the date of its last release and call anything old dead. That heuristic looks great on a demo and is worthless in a real project, because the npm dependency graph rests on a layer of tiny packages that were *finished* years ago.

`ms` last shipped in 2020. `inherits` in 2019. `once` in 2016. `wrappy` in 2016. None of them are abandoned. The millisecond format has not changed, `Object.setPrototypeOf` has not changed, and wrapping a function so it runs once is a solved problem. They are downloaded hundreds of millions of times a week and there is nothing left to add. A tool that tells you to migrate off `inherits` has not found a problem — it has become one.

So dead-deps does not answer a boolean. It answers with a **state**:

| State | Meaning |
| --- | --- |
| `active` | Shipping releases and taking commits. |
| `stable-complete` | Finished, not abandoned. Small scope, nothing broken, nobody waiting. **This is a pass.** |
| `low-activity` | Really maintained, just slowly. Worth watching, not worth an emergency migration. |
| `unmaintained` | No meaningful maintenance for years, but nothing formally declared. |
| `deprecated` | Formally retired by the registry or the maintainers. |
| `abandoned` | Maintenance has stopped and the evidence says it is not coming back. |
| `hijack-risk` | Abandoned *and* attractive to an attacker: open advisories, still widely depended on, nobody attending. |
| `unknown` | Not enough public data to judge. Said out loud rather than guessed. |

Reaching `stable-complete` requires clearing a deliberately hard set of vetoes: no deprecation notice, no archived repository, no open advisories, nobody waiting on an unanswered issue, no contributor's pull request left unmerged, real adoption downstream, and a version history showing the API converged years ago. Silence is only ever measured against the package's *own* median release gap, so a library that shipped every three weeks for a decade and then stopped reads very differently from one that has shipped twice, on purpose, since 2016.

The whole thing is tuned for **precision over recall**. Missing one dead dependency costs you one dead dependency. Wrongly flagging `inherits` costs you the tool — you stop believing any of the output and you uninstall it. Given the choice, dead-deps stays quiet.

### Calibration

Claims like the ones above are only worth anything if they are measured, so the detector is scored against [`data/calibration.yaml`](./data/calibration.yaml) — a hand-labelled, deliberately adversarial corpus of real npm packages. Its most important bucket is `stable-complete`: the finished-but-quiet packages that a naive detector flags. The headline metric is the false-positive rate over that bucket, not overall accuracy, because overall accuracy can be bought by flagging everything old and a low false-positive rate cannot.

The corpus also contains the trap inverted — `code-point-at` and `path-is-absolute` are tiny, ancient micro-libraries that look exactly like `once` but carry real deprecation notices and archived repositories — so a detector cannot pass by learning "small and old means fine" either.

<!--CALIBRATION-TABLE-->

| Metric | Value | Basis |
| --- | --- | --- |
| **False positives on finished packages** | **0.0%** | 0 / 13 `stable-complete` |
| False alarms on anything healthy | 0.0% | 0 / 25 `active` + `stable-complete` |
| Missed dead packages | 37.5% | 9 / 24 rows at or above `low-activity` |
| Strict accuracy (exact state) | 71.4% | 35 / 49 |
| Lenient accuracy (near misses forgiven) | 75.5% | 37 / 49 |

_Corpus: 49 hand-labelled packages. Generated by `npm run calibrate` on 2026-08-04._

Run it yourself with `npm run calibrate`. It performs real lookups against the live indexes, prints a full report — headline false-positive rate, strict and lenient accuracy, a confusion matrix, per-label precision and recall, and every single disagreement with the evidence that drove it — and writes `docs/calibration-results.json`. Methodology and known limits live in [`docs/CALIBRATION.md`](./docs/CALIBRATION.md) and on the [methodology page](https://mekkadev.github.io/dead-deps/methodology/).

## Install

Run it without installing anything:

```console
npx dead-deps
```

Or install it globally, which is worth it if you check dependency health often:

```console
npm install -g dead-deps
dead-deps ./services/api
```

Requires **Node.js >= 20.10**. The only runtime dependencies are `yaml` and the MCP SDK.

## Usage

```console
dead-deps [path] [options]
```

`path` may be a directory, a lockfile, or a `package.json`. It defaults to the current directory, where dead-deps picks `pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json` or `yarn.lock`, in that order, and falls back to `package.json`.

**Scope**

| Flag | Default | What it does |
| --- | --- | --- |
| `--all` | off | Include transitive dependencies. Off by default because they are not yours to fix. |
| `--limit <n>` | `5` | Maximum findings to show. 1–10000. Anything withheld is counted in the warnings, never dropped silently. |
| `--min-state <state>` | `low-activity` | Minimum severity to report. One of `active`, `stable-complete`, `unknown`, `low-activity`, `unmaintained`, `deprecated`, `abandoned`, `hijack-risk`. |

**Output**

| Flag | What it does |
| --- | --- |
| `--json` | Machine-readable report on stdout; never coloured. |
| `--quiet`, `-q` | Suppress progress on stderr; the report still prints. |
| `--no-color` | Disable ANSI colour even on a terminal. |
| `--version`, `-v` | Print the version and exit. |
| `--help`, `-h` | Print the full help and exit. |

**Network**

| Flag | Default | What it does |
| --- | --- | --- |
| `--contact <email>` | `$DEAD_DEPS_CONTACT` | Sent upstream so ecosyste.ms can reach you, which puts your requests in their polite pool. |
| `--concurrency <n>` | `8` | Maximum parallel upstream requests. 1–64. |
| `--no-cache` | off | Bypass the on-disk cache and re-fetch everything. |
| `--cache-ttl <hours>` | `24` | How long cached responses stay usable. 0–8760. |

**Environment**

| Variable | What it does |
| --- | --- |
| `DEAD_DEPS_CONTACT` | Default for `--contact`. |
| `DEAD_DEPS_CACHE_DIR` | Where responses are cached. Otherwise `$XDG_CACHE_HOME/dead-deps`, otherwise `~/.cache/dead-deps`. |
| `DEAD_DEPS_DEBUG` | Print stack traces instead of one-line errors. |
| `NO_COLOR` | Disable colour (any non-empty value). |

stdout carries the report and nothing else. Progress, warnings and errors go to stderr, so `dead-deps --json > out.json` is always valid JSON and `dead-deps | less` is always the report.

### As a library

`scan()` is the whole tool in one call, and the pieces underneath it are exported too:

```ts
import { scan, renderJson } from 'dead-deps';

const result = await scan('./', { all: false, minState: 'unmaintained' });
console.log(renderJson(result));
```

`assess()`, `gatherSignals()`, `parseLockfile()`, `loadSuccessors()` and `lookupSuccessor()` are all public, along with every type in `src/types.ts`.

## CI usage

Exit codes are a stable contract:

| Code | Meaning |
| --- | --- |
| `0` | Clean — nothing was flagged. |
| `1` | At least one dependency was flagged. **Gate CI on this.** |
| `2` | Usage error — unknown flag, bad value, or unreadable path. |
| `3` | Runtime error — no lockfile found, upstream unreachable. |

A step that fails the build the moment a deprecated dependency appears:

```yaml
- name: Check for abandoned dependencies
  run: npx --yes dead-deps --min-state deprecated --limit 50 --quiet
  env:
    # Optional. Puts the job in ecosyste.ms' polite pool.
    DEAD_DEPS_CONTACT: dev@example.com
```

One caveat worth knowing before you gate on this: a package whose upstream lookups fail does not fail the scan. It is assessed as `unknown` and the run reports how many sources it could not read, in the warnings on stderr and in the JSON. A totally offline job can therefore still exit `0` — so if a green build must mean "we really checked", read `warnings` from the JSON rather than the exit code alone.

If you would rather report than block, keep the JSON and let the job pass:

```yaml
- name: Dependency health report
  run: npx --yes dead-deps --all --min-state unmaintained --limit 200 --json > dead-deps.json
  continue-on-error: true

- uses: actions/upload-artifact@v4
  with:
    name: dead-deps
    path: dead-deps.json
```

The JSON is versioned (`schemaVersion: 1`) and deterministic apart from its `generatedAt` timestamp: same scan, same bytes. Adding a field is not a breaking change, so ignore keys you do not recognise.

## MCP server

Coding agents are confidently wrong about package names. Ask one what replaced a dead library and it will answer from training data with a cutoff, in a registry where anyone can publish — and a plausible-sounding package name that does not exist is not a harmless mistake. It is the entry point for a **slopsquatting** supply-chain attack, where attackers watch for the names models invent and publish them for real.

The MCP server exists so an agent can look the answer up instead of remembering it. Every response carries evidence URLs, and when there is no curated record the server says so and names nothing — which is the correct answer, and the reason to trust the ones it does give.

| Tool | What it does |
| --- | --- |
| `scan_lockfile` | Reads a real lockfile from disk and returns a sourced maintenance verdict per dependency, worst first. Same JSON contract as `--json`. |
| `check_package` | Assesses one npm package by name: state, 0–100 score, confidence, full evidence, curated successor. Doubles as an existence check, which catches hallucinated and typosquatted names. |
| `find_successor` | Looks a package up in the curated succession dataset. Runs entirely offline against local data. Returns nothing rather than guessing. |

Add it to Claude Code with one command:

```console
claude mcp add dead-deps -- npx -y -p dead-deps dead-deps-mcp
```

Or by hand. Claude Code (`.mcp.json` in a project, `~/.claude.json` for a user) and Cursor (`.cursor/mcp.json` or `~/.cursor/mcp.json`) share the same shape:

```json
{
  "mcpServers": {
    "dead-deps": {
      "command": "npx",
      "args": ["-y", "-p", "dead-deps", "dead-deps-mcp"],
      "env": {
        "DEAD_DEPS_CONTACT": "you@example.com"
      }
    }
  }
}
```

`-p dead-deps` is required: the binary is `dead-deps-mcp` but the package it lives in is `dead-deps`. With a global install (`npm i -g dead-deps`) the command is simply `"command": "dead-deps-mcp", "args": []`.

`DEAD_DEPS_CONTACT` is optional. It is sent as a `User-Agent` contact to ecosyste.ms, which puts requests in their polite pool. Nothing else is transmitted, and the server writes only to a local HTTP cache.

## The dataset

[`data/successors.yaml`](./data/successors.yaml) is a curated map from packages that stopped being maintained to whatever actually succeeded them. Every row is checked by a human against primary sources — a deprecation notice, a maintainer statement, an archived repository, a release note, an official migration guide. Machine-generated guesses do not belong in it, and neither do rows about small finished packages: being quiet is not being abandoned.

The dataset is small on purpose. It is browsable at [mekkadev.github.io/dead-deps](https://mekkadev.github.io/dead-deps/), one page per package, so "what replaced `request`" has an answer you can read and check without installing anything.

A maintained fork is only one of six ways a package gets succeeded, and not the most common:

| `type` | Meaning | Example |
| --- | --- | --- |
| `fork` | The community forked the original and carried it on. | `faker` → `@faker-js/faker` |
| `rename` | Same project, published under a new name or scope. | `istanbul` → `nyc` |
| `replacement` | An unrelated project the ecosystem migrated to. | `request` → `undici` |
| `absorbed` | The capability moved into the platform or stdlib. | `left-pad` → `String.prototype.padStart` |
| `self-declared` | The original maintainers named the successor themselves. | `moment` → `luxon` |
| `reimplementation` | The same idea rebuilt from scratch. | `node-sass` → `sass` |

Roughly a fifth of real successions do not point at a package at all, so every row also carries a `toKind` of `package`, `platform` or `none`. "Delete the dependency, the language does this now" is a better answer than any package name, and forcing `String.prototype.padStart` into a package field would make the tool recommend installing something that does not exist.

**Contributing a row.** Open a [successor report](https://github.com/mekkadev/dead-deps/issues/new?template=successor-report.md) with the primary sources, or send a pull request adding the row yourself. The field-by-field schema is [`data/SCHEMA.md`](./data/SCHEMA.md) and the evidence bar is in [CONTRIBUTING.md](./CONTRIBUTING.md). One rule above all others: at least one evidence URL must be a primary source. Blog posts and Stack Overflow answers are supporting evidence, never the only evidence.

## What this does NOT do

Stating the limits plainly is cheaper than having you discover them.

- **npm only.** No PyPI, no crates.io, no Go modules, no private or self-hosted registries. A package your registry serves but npm has never heard of comes back `unknown`.
- **Direct dependencies by default.** `--all` will sweep the whole tree, but the default is deliberate: a verdict on a transitive package you cannot upgrade is noise, not information.
- **It does not know whether you actually import anything.** It reads the lockfile, not your source. A dependency you stopped using two years ago still gets judged.
- **Curated coverage is finite.** The succession dataset covers the packages that were worth verifying by hand. No record for a package means no verified successor is known — it does *not* mean the package is fine, and it does not mean one exists that we forgot. Most healthy packages have no row at all.
- **Upstream indexes lag.** Verdicts rest on the npm registry and ecosyste.ms; repository and issue data can be months behind reality. When it is, the report lowers its confidence and says the data may be stale rather than presenting it as current.
- **It is not a vulnerability scanner.** Open advisories are one input among many, and only ever in service of the maintenance question. Keep running `npm audit`, Dependabot, or whatever you already trust for CVEs — dead-deps answers "is anyone still home", not "is this exploitable".
- **It judges maintenance, nothing else.** Not code quality, not licences, not whether the package suits your use case.

## Links

- **Site and package index** — <https://mekkadev.github.io/dead-deps/>
- **Methodology** — <https://mekkadev.github.io/dead-deps/methodology/>
- **Calibration** — [`docs/CALIBRATION.md`](./docs/CALIBRATION.md)
- **Dataset schema** — [`data/SCHEMA.md`](./data/SCHEMA.md)
- **Contributing** — [CONTRIBUTING.md](./CONTRIBUTING.md)

## Prior art and acknowledgements

dead-deps is built on [**ecosyste.ms**](https://ecosyste.ms/), Andrew Nesbitt's open dataset and API for open-source package ecosystems. The release history, repository metadata, issue and pull-request responsiveness, maintainer activity, dependent counts and advisories behind every verdict here come from their public indexes, offered freely and without an API key. If you find this tool useful, [support them](https://opencollective.com/ecosystems) — this project would be a pile of scraping code without their work. The [npm registry](https://registry.npmjs.org/) supplies deprecation notices and release timestamps.

Thanks also to the maintainers of every package named in the dataset. Abandoning a project is normal, usually unpaid, and no criticism is intended by a row here. "No longer maintained" is a fact about a package, not a judgement of a person.

## License

[MIT](./LICENSE)
