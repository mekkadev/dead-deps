<div align="center">

# dead-deps

find abandoned npm dependencies, and what replaced them

<img src="https://raw.githubusercontent.com/mekkadev/dead-deps/main/docs/demo.svg" width="880" alt="npx dead-deps on a project: request reported as a hijack risk with three pieces of cited evidence, undici named as its successor, and eight other dependencies deliberately not flagged">

[install](#install) · [use](#use) · [why this is hard](#why-this-is-hard) · [numbers](#numbers) · [mcp](#mcp) · [the dataset](#the-dataset) · [limits](#limits)

</div>

the hard part is not finding quiet packages. it is not calling `ms` dead.

`ms`, `inherits`, `once` and `isarray` have shipped nothing in years because
they are finished — a few dozen lines that do one thing correctly and will
never need another release. a tool that tells you to migrate off `inherits` is
not a tool, it is noise, and it gets uninstalled after one run.

so silence is measured against each package's own release history rather than
against a calendar. a package that always shipped every three years is not
dying. `browserify` shipped roughly daily for years and then stopped for
twenty-two months — short of any fixed threshold, and forty-eight times its own
rhythm.

everything printed carries a url. the deprecation notice, the archived
repository, the release that never came, the issues nobody answered. a claim
without a source behind it is a bug here, not a feature.

## install

```bash
npx dead-deps
```

no install, no config, no account, no api key. node 20.10+, two runtime
dependencies. it reads dependency names out of your lockfile and asks two
public indexes about them — nothing from your project leaves the machine, and
no dependency code is executed.

```bash
npm i -g dead-deps     # or -D in a project
```

## use

```bash
dead-deps                                    # this project, direct deps, worst few
dead-deps --all --min-state unmaintained     # the whole tree, only what is clearly dead
dead-deps ./services/api --json > report.json
dead-deps --min-state deprecated --quiet     # a ci gate
```

it reads `pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json`,
`yarn.lock` (classic and berry) or a bare `package.json`. direct dependencies
only unless you pass `--all`, because a report about a transitive package you
cannot upgrade is noise.

flags worth knowing: `--limit` findings, `--min-state` severity floor,
`--contact` your email so ecosyste.ms can put you in their polite pool,
`--concurrency`, `--no-cache`, `--cache-ttl`, `--json`, `--quiet`, `--no-color`.

exit codes are a contract: `0` clean, `1` something was flagged, `2` usage
error, `3` no lockfile or upstream unreachable. gate ci on `1`.

```yaml
- run: npx dead-deps --min-state deprecated --limit 20
  env:
    DEAD_DEPS_CONTACT: you@example.com
```

## why this is hard

the naive version is twenty lines — read the lockfile, check the last publish
date, complain about anything older than a year — and it is useless. four
things keep this one honest.

**popularity is not health.** `enzyme` has thirty thousand dependent packages
*because* it was popular before it died. counting adoption as a sign of life is
how a six-year-dead package scores as fine. adoption only feeds the
supply-chain read, where large reach is a reason for concern.

**triage is not maintenance.** a repository that closes issues while shipping
nothing is tidying its tracker. those fixes reach nobody who installed the
package, so signs of life fade as silence grows.

**a patched advisory is good news.** an advisory fixed in a later release means
the maintainer showed up. counting it once reported `ms@2.1.3` as a hijack risk
over a redos patched back in 2.0.0.

**stale data is disclosed.** upstream indexes lag, sometimes by a year. when a
verdict rests on old issue data the report says so and lowers its own
confidence.

the verdict is a state, never a boolean: `active`, `stable-complete`,
`low-activity`, `unmaintained`, `deprecated`, `abandoned`, `hijack-risk`, or an
honest `unknown`. `stable-complete` exists so finished packages have somewhere
to go that is not "dead". the full reasoning is on the
[methodology page](https://mekkadev.github.io/dead-deps/methodology/).

## numbers

a precision claim is worth nothing unless it is measured, so the detector is
scored against fifty-four hand-labelled packages. a quarter of the corpus is
finished-but-quiet traps, and it includes the trap inverted — `code-point-at`
and `path-is-absolute` look exactly like `once` but carry real deprecation
notices, so nothing passes by learning that small and old means fine.

<!--CALIBRATION-TABLE-->

| | |
| --- | --- |
| false positives on finished packages | **0.0%** — 0 of 13 |
| false alarms on anything healthy | **0.0%** — 0 of 30 |
| missed dead packages | 4.2% — 1 of 24 |
| strict accuracy | 83.3% — 45 of 54 |

`npm run calibrate` reproduces this against the live indexes and prints the
confusion matrix, per-label precision and recall, and every disagreement with
the evidence that caused it.

two things make those numbers trustworthy. the detector is scored *without* the
succession dataset — curated answers are applied afterwards, so the harness
cannot grade it on answers it was handed. and the one remaining miss stays:
`underscore.string` is indistinguishable from a finished package by metadata,
and no maintainer ever named a successor, so a dataset row would be one
person's opinion dressed as consensus.
[the argument](./docs/CALIBRATION.md) is written down, including the case
against a labelling decision made here.

## mcp

ask a model what replaced an obscure package and it may answer with one that
does not exist. registering that name is a live attack.

```json
{ "mcpServers": { "dead-deps": { "command": "npx", "args": ["-y", "dead-deps-mcp"] } } }
```

three tools: `scan_lockfile`, `check_package`, `find_successor`. the last one
returns "no curated record" rather than guessing, which is the point of it.

## the dataset

[`data/successors.yaml`](./data/successors.yaml) is eighty-one hand-verified
rows with a hundred and seventy-eight primary-source links, every one checked.
a row goes in only when the succession is consensus rather than opinion, and
finished packages are refused outright.

the breakdown refutes the premise this started from — that the job is finding a
maintained fork:

| | |
| --- | ---: |
| rename — `koa-router` → `@koa/router` | 23 |
| self-declared — `moment` → `luxon` | 19 |
| absorbed — `left-pad` → `String.prototype.padStart` | 15 |
| replacement — `request` → `undici` | 15 |
| fork — `faker` → `@faker-js/faker` | **5** |
| reimplementation — `node-sass` → `sass` | 4 |

forks are the rarest outcome. six rows point at a platform feature instead of a
package, because "delete the dependency, javascript does this now" is the
better answer. six more have no credible successor and say so.

every row is a page: [request](https://mekkadev.github.io/dead-deps/p/request/),
[moment](https://mekkadev.github.io/dead-deps/p/moment/),
[enzyme](https://mekkadev.github.io/dead-deps/p/enzyme/), or
[all eighty-one](https://mekkadev.github.io/dead-deps/). missing one? open a
[successor report](https://github.com/mekkadev/dead-deps/issues/new?template=successor-report.md)
— with a primary source, not a blog post.

## limits

- **not a vulnerability scanner.** advisories are read as evidence of neglect,
  not enumerated for triage. use `npm audit` or osv for cves.
- **npm only.** one ecosystem done properly beat four done badly.
- **curated coverage is finite.** eighty-one successions is a start. a dead
  package outside the dataset still gets a verdict, just no successor.
- **upstream indexes lag.** the tool tells you when a verdict rests on old data.
- **it will not decide for you.** a pinned, vendored, working dependency may be
  entirely rational to keep.

## build it yourself

```bash
git clone https://github.com/mekkadev/dead-deps.git
cd dead-deps && npm install
npm test          # 173 tests, none touch the network
npm run calibrate # score the detector against the labelled corpus
npm run site      # generate the static site
```

[architecture](./docs/ARCHITECTURE.md) · [contributing](./CONTRIBUTING.md) ·
[calibration](./docs/CALIBRATION.md) · [changelog](./CHANGELOG.md)

built on [ecosyste.ms](https://ecosyste.ms), andrew nesbitt's open index of
package and repository metadata. it is free and unauthenticated and this would
not be feasible without it — [support it](https://opencollective.com/ecosystems).

mit
