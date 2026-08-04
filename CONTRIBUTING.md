# Contributing to dead-deps

Two kinds of contribution are welcome, and the first is by far the most valuable:

1. **A succession row** — you know a package died and you know what replaced it, and you can prove both.
2. **Code** — a lockfile format that parses badly, a signal the scorer should read, a report that reads awkwardly.

Everything below assumes Node.js >= 20.10 and a `npm ci`.

---

## Adding a succession row

The dataset is [`data/successors.yaml`](./data/successors.yaml). Its field-by-field schema — every key, every allowed value, and a complete example row — is [`data/SCHEMA.md`](./data/SCHEMA.md). Read that first; this section covers only the judgement calls it cannot.

If you would rather not edit YAML, open a [successor report issue](https://github.com/mekkadev/dead-deps/issues/new?template=successor-report.md) with the evidence URLs and someone will write the row.

### The evidence bar

This is the part that matters. The whole value of the dataset is that a reader can check it, and one unsourced row costs more trust than ten good rows earn.

**At least one `evidence` entry must be a primary source.** A primary source is:

- an npm deprecation notice on the package,
- a statement by a maintainer of the `from` package (issue, README, release note, blog post on the project's own site),
- an archived source repository,
- an official migration guide published by either project.

Blog posts, conference talks, Stack Overflow answers and "everyone knows" are *supporting* evidence. They may appear in the list; they may never be the only thing in it.

**Every URL must resolve today.** Link to the issue, not to a screenshot of it. Prefer a permalink over a moving target.

### The inclusion bar

A row may be added only when all three hold:

1. **The `from` package is genuinely no longer maintained, deprecated, or explicitly superseded — and this is publicly documented.** Your own experience of a slow maintainer is not documentation.
2. **The succession is consensus, not opinion.** If reasonable engineers would name different replacements, either set `confidence: low` and list the candidates under `alternatives`, or leave the row out. Prefer the successor the ecosystem actually moved to over the one that is technically nicest.
3. **It is not a finished package.** Rows about small, complete, still-working packages must *not* be added. `ms`, `inherits`, `once` and `wrappy` are quiet because they are done. Flagging them is the failure mode this whole project is built to avoid — see the calibration corpus's `stable-complete` bucket.

### Getting `toKind` right

`toKind` is what stops the tool telling somebody to `npm install String.prototype.padStart`.

- `package` — `to` is an npm package name you can install.
- `platform` — the capability moved into the language or runtime. `to` holds a human-readable feature name and the correct advice is *delete the dependency*.
- `none` — nothing credible succeeded it. `to` is `null`.

`dropIn` may only be `true` when `toKind` is `package`: there is nothing to swap in otherwise.

### House style for `notes`

`notes` is two or three sentences of plain prose, rendered on the website for humans.

- State facts, not judgements. "No releases since 2019" is a fact. "Neglected" is an insult.
- Never disparage maintainers. Abandonment is normal and usually unpaid; a row here is not a complaint.
- No marketing. The reader wants to know what to do next, not how exciting the successor is.

### Checking your row

The loader validates strictly and names the row, the field and what it expected, so the fastest check is to load it:

```console
npm test                # successors.test.ts parses and validates the real dataset
npm run site            # builds the static site, one page per row
```

A malformed dataset throws rather than skipping the bad row: a typo that silently deleted a recommendation would be worse than a failure.

---

## Code

### Running things

```console
npm ci
npm run typecheck       # tsc --noEmit, strict
npm test                # node --test over test/**/*.test.ts
npm run build           # emit dist/
npm run dev -- ./       # run the CLI from source
npm run site            # build the static site into site/dist/
```

CI runs `typecheck`, `test` and `build` on Node 20 and 22. All three must pass.

### Tests are offline, always

No test in this repository may reach the network. `test/no-network.ts` replaces `globalThis.fetch` with a stub that throws and names the URL, so a suite that tries fails loudly instead of flaking. Build the inputs by hand instead: `test/helpers.ts` exports builders for `signals()`, `assessment()`, `finding()`, `lockfile()`, `scanResult()` and friends, and anything needing an `HttpClient` gets a stub you write in the test.

A verdict that depends on what ecosyste.ms happens to be serving today is not a test.

### Calibration

The detector is scored against the hand-labelled corpus in [`data/calibration.yaml`](./data/calibration.yaml):

```console
npm run calibrate                          # full run, real network
npm run calibrate -- --limit 12            # quick stratified sample
npm run calibrate -- --max-fp-rate 5       # non-zero exit above a ceiling
npm run calibrate -- --contact you@example.com
```

It prints a markdown report — headline false-positive rate on the `stable-complete` bucket, strict and lenient accuracy, a confusion matrix, per-label precision and recall, and every disagreement with the evidence behind it — and writes `docs/calibration-results.json`. A partial run is marked `partial` and writes to a separate file so a smoke test can never overwrite a published number.

**Any change to `src/detect/score.ts` needs a calibration run in the pull request.** Paste the Summary table into the PR body. If the headline false-positive rate went up, say so and explain why the trade was worth it; that number going up is the one regression that matters most.

Changing a label in `data/calibration.yaml` requires changing its `rationale` and `evidence` in the same commit. Labels drift — `low-activity` becomes `unmaintained`, `unmaintained` acquires a deprecation notice — so re-verify against primary sources rather than adjusting the corpus to match the detector. Tuning the yardstick to fit the tool is the one thing that would make all of these numbers meaningless.

### Code layout

```
src/
  cli.ts               The `dead-deps` binary. Argument parsing, help, exit codes,
                       one-sentence error messages. stdout is the report, only.
  mcp.ts               The `dead-deps-mcp` binary. Three MCP tools over stdio.
  index.ts             Public library surface. Everything the CLI and MCP use.
  types.ts             Single source of truth for every shared shape.
  scan.ts              The pipeline: target → lockfile → signals → verdicts → ScanResult.
  detect/score.ts      The verdict engine. Signals in, Evidence and a state out.
  lockfile/            Discovery and parsers: npm, pnpm, yarn v1/Berry, package.json.
  sources/             Upstream I/O: http client, disk cache, ecosyste.ms, npm registry.
  successors/          Loading and validating the curated dataset.
  report/              terminal.ts (human) and json.ts (machine, versioned contract).
data/                  successors.yaml, calibration.yaml, SCHEMA.md.
docs/                  Calibration methodology and generated results.
scripts/calibrate.ts   The calibration harness.
site/                  Static site generator for the package pages.
test/                  Offline suites plus lockfile fixtures.
```

### Conventions

- **TypeScript, ESM, NodeNext.** Relative imports carry the `.js` extension even though the source is `.ts`. `verbatimModuleSyntax` is on, so type-only imports use `import type`.
- **Strict, with `noUncheckedIndexedAccess`.** `arr[0]` is possibly `undefined`; handle it rather than asserting it away.
- **Runtime dependencies are `yaml` and `@modelcontextprotocol/sdk`.** Everything else is a Node builtin. No colour library, no argument parser, no HTTP client. A tool that audits dependencies should be embarrassed to have many.
- **`src/types.ts` changes first.** If a shape needs to change, change it there and let the modules follow.
- **Every claim needs a source.** A verdict the user cannot check is a bug. Evidence carries a URL wherever one exists.
- **Comment the reasoning, not the code.** Explain why a threshold is what it is; do not narrate what the next line does.

### Adding a signal to the scorer

Weights and thresholds in `src/detect/score.ts` are exported constants specifically so the calibration harness can tune them from outside and a reviewer can audit them without reading the logic. Keep it that way: a new signal is a new exported weight, a collector that emits `Evidence` with a URL, and a calibration run showing what it changed.

The score curve is logistic and monotone over an unbounded weight sum, so adding a signal does not require rebalancing the existing ones.

---

## Pull requests

- One topic per pull request. A dataset row and a scorer change do not belong together.
- `npm run typecheck && npm test` before pushing.
- Describe the user-visible change, and for scorer changes include the calibration Summary table.
- New behaviour needs a test. New evidence needs a URL.

By contributing you agree that your contribution is licensed under the [MIT License](./LICENSE).
