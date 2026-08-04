# Calibration

`dead-deps` makes a claim — that it can tell a *finished* package from a *dead*
one — and that claim is worth exactly nothing unless it is measured. This
document describes how it is measured, what the measurement covers, and, at
some length, what it does not cover. The limitations section is the important
half. A tool that publishes accuracy numbers without publishing their limits is
asking to be trusted rather than earning it.

Everything here is reproducible: the corpus is in the repository, the harness is
one file, and the run needs nothing but network access.

## What is being measured

The detector's whole job is to output one of eight `MaintenanceState` values for
a package. Calibration scores those outputs against a hand-labelled corpus of
real npm packages and reports:

| Metric | Question it answers |
| --- | --- |
| **False-positive rate on `stable-complete`** | How often does it cry wolf on a finished package? |
| False-alarm rate on healthy packages | Same, widened to `active` as well. |
| Missed-dead rate | How many genuinely dead packages does it stay silent about? |
| Strict accuracy | How often is the exact state right? |
| Lenient accuracy | How often is the *advice* right, even if the word is wrong? |
| Per-label precision and recall | Which specific states is it good and bad at? |
| Confusion matrix | Where, specifically, do the errors go? |
| Every individual disagreement | Which package, and on what evidence? |

The first row is the headline. The rest are context for it.

## What the detector is *not* given

Calibration scores `assess()` — inference from upstream signals alone. Two
deliberate exclusions keep the numbers meaningful.

**The succession dataset is withheld.** `data/successors.yaml` is hand-verified
ground truth about which packages are dead, and several corpus packages appear
in it. Feeding it to the scorer would be grading the detector on answers it was
handed. In the product it *is* used, but one layer up: `applyCuratedFloor()` in
`src/scan.ts` raises a verdict to at least `unmaintained` when a curated row
exists. So the shipped tool catches packages the measured detector misses —
`enzyme` and `colors` among them — and the published accuracy figures do not
take credit for it.

**Advisories only count when the newest release is still exposed.** An advisory
that was fixed in a later version is evidence the maintainer showed up, not
evidence of abandonment. This is not a hypothetical refinement: an early build
scored `ms@2.1.3` as `hijack-risk` on the strength of GHSA-w9mr-4mfr-499f, a
ReDoS patched back in `2.0.0`. That single bug was the entire false-positive
rate on the headline bucket. Affected-version windows now come from the advisory
data itself, and a range the tool cannot parse keeps counting rather than being
silently discarded — understating risk is the worse error.

## Why the `stable-complete` bucket is the headline

The naive abandoned-package detector reads the date of the last release and
calls anything old dead. It scores impressively on obviously dead projects and
is still worthless, because a large fraction of the npm dependency graph rests
on tiny packages that were *finished* years ago: `once`, `wrappy`,
`util-deprecate`, `inherits`, `imurmurhash`. They do one small thing, they do it
correctly, there is nothing left to add, and so nobody commits to them. On
release date alone they are indistinguishable from abandoned packages, and they
are downloaded hundreds of millions of times a week.

A tool that tells its user to migrate off `inherits` has not found a problem; it
has become one. Worse, it only has to do it once. The first bogus finding
teaches the user that the output needs checking, and a security tool whose
output needs checking is deleted.

So one bucket of the corpus is nothing but these packages, and its
false-positive rate is reported separately from and above overall accuracy.
Overall accuracy can be bought by flagging everything old. This number cannot:
it goes *up* when the detector gets more aggressive. It is the only metric here
that a lazy detector cannot game.

The `deprecated` bucket contains the same trap inverted — `code-point-at` and
`path-is-absolute` are micro-libraries that look exactly like the
`stable-complete` set but carry real npm deprecation notices and archived
repositories. A detector cannot pass by learning "small and old means fine"
either.

"Flagged" is defined as the predicted state reaching the tool's own default
reporting threshold (`DEFAULT_SCAN_OPTIONS.minState`, currently `low-activity`).
That is deliberately the user-visible definition rather than an internal one: a
misclassification the user never sees is not a false positive, and the harness
should not get credit for one or blame for the other.

## The corpus

`data/calibration.yaml`. Roughly fifty real npm packages, each a row of:

```yaml
- name: bluebird
  label: unmaintained        # a MaintenanceState from src/types.ts
  rationale: >-
    One sentence explaining why this label and not the neighbouring one.
  evidence:
    - label: "npm registry: bluebird@3.7.2 published 2019-11-28"
      url: https://registry.npmjs.org/bluebird
```

It is deliberately adversarial rather than representative. The buckets are
weighted toward the cases that are hard to tell apart, not toward the cases that
occur most often, because the easy cases are not where a detector fails. Roughly
a quarter of the corpus is `stable-complete` — far more than its share of a real
lockfile — precisely because that is the bucket that decides the tool's worth.

Labels use five of the eight states: `active`, `stable-complete`,
`low-activity`, `unmaintained`, `deprecated`. The remaining three —
`abandoned`, `hijack-risk`, `unknown` — are detector outputs with no
ground-truth rows, so they can appear as columns in the confusion matrix but
never as rows. They show up in the per-label table with `—` for recall, which is
correct and not a bug: you cannot have recall on a class nobody labelled.

Every row was checked against two primary sources: the npm registry document
(latest version, its `deprecated` field, its publish time) and the ecosyste.ms
package/repository APIs (archived flag, last push, trailing-year commits). Where
the two disagreed, npm was treated as authoritative for release facts and the
repository host for commit facts.

## Strict versus lenient accuracy

Two accuracy numbers are published and both are labelled.

**Strict** is exact state match. It is the honest number and it is always
printed first.

**Lenient** additionally forgives *near misses* — pairs of states where the tool
got the word wrong but the advice right. The test for admitting a pair is "would
the user do anything different?", not "are these adjacent in the enum". The
complete list, printed on every run so it cannot drift silently from this
document:

| Pair | Why it is a near miss |
| --- | --- |
| `active` ↔ `stable-complete` | Both produce no finding. The user does nothing either way. |
| `unmaintained` ↔ `abandoned` | Both mean "this is dead, plan a migration". |
| `unmaintained` ↔ `hijack-risk` | Same, with more urgency. |
| `deprecated` ↔ `abandoned` | Both mean "formally retired, migrate". |
| `deprecated` ↔ `hijack-risk` | Same, with more urgency. |
| `abandoned` ↔ `hijack-risk` | Both are terminal verdicts on a dead package. |

Deliberately **not** forgiven:

- **`low-activity` against anything.** "Keep an eye on it" and "replace it" are
  different instructions, and `low-activity` over a `stable-complete` package is
  exactly the false positive being measured. Forgiving this pair would erase the
  headline metric.
- **`unmaintained` against `deprecated`.** The corpus distinguishes them on a
  checkable fact: whether a registry deprecation notice exists. Asserting one
  that does not exist is a false statement, not a rounding error.
- **`unknown` against anything.** Abstaining is more honest than guessing, but
  it is still a miss, and counting it as a hit would reward the detector for
  knowing nothing.

Lenient accuracy is always higher than strict, sometimes by a lot. Quoting it
without the word "lenient" attached, or without the pair list, would be
dishonest. The harness prints both together for that reason.

One structural consequence worth knowing before reading the numbers: the corpus
distinguishes `deprecated` from `abandoned` by formality, while the detector
escalates a deprecated package that has also been silent for years straight to
`abandoned`. That single mapping accounts for most of the gap between the strict
and lenient figures. It is a taxonomy disagreement between corpus and detector,
not a failure to notice anything — but it is counted as wrong under strict
accuracy, and it should be.

## Running it

```bash
# Full run. Writes docs/calibration-results.json and prints markdown.
npm run calibrate

# Quick smoke test: a stratified sample across all buckets, not the first n rows.
node --import tsx scripts/calibrate.ts --limit 5

# Machine-readable on stdout.
node --import tsx scripts/calibrate.ts --json

# Cold run, no cached upstream responses.
node --import tsx scripts/calibrate.ts --no-cache

# CI gate: fail if the headline rate regresses past a ceiling.
node --import tsx scripts/calibrate.ts --max-fp-rate 10
```

Set `DEAD_DEPS_CONTACT` to an email address. It is forwarded to ecosyste.ms,
which routes requests carrying one into its polite pool — faster for you and
neighbourly toward a free service.

The run hits the network for real: same `HttpClient`, same `gatherSignals`, same
`assess` the CLI uses, at concurrency 6. Responses are cached on disk for 24
hours by default, so reruns while tuning thresholds are nearly free. A full run
from cold takes about a minute.

Output:

- **stdout** is markdown, ready to paste into the README or into the
  `<!--CALIBRATION-TABLE-->` slot on the site's methodology page.
- **`docs/calibration-results.json`** is the full machine-readable record,
  including every per-package outcome and the evidence behind each
  disagreement.
- **stderr** carries progress, so stdout stays pasteable.

A partial run (`--limit`) is marked `partial` in both outputs and writes to
`docs/calibration-results.partial.json` instead, so a smoke test can never
overwrite a published number.

If `data/calibration.yaml` is missing, the harness says so and exits 0 — there
is nothing to measure, and that is not a build failure. If the file exists but
is malformed, it exits 2 and refuses to produce numbers, because a corpus whose
labels cannot be parsed cannot be trusted to score anything.

## Known limitations

Read this section before quoting any number above it.

**The corpus is small.** Around fifty packages. Every percentage moves by
roughly two points if a single row changes, and the per-label figures rest on
buckets of six to thirteen rows each. Treat differences of a few points between
runs as noise. Confidence intervals on samples this size are wide enough that
publishing them to one decimal place, as the harness does, is arguably false
precision — the decimal is there for run-to-run comparison while tuning, not
because the third significant figure means anything.

**The labels are one person's judgement.** They are sourced and each carries a
rationale and a primary-source link, so they are checkable, but they were not
produced by multiple independent annotators and there is no inter-rater
agreement figure. The genuinely hard calls — is `moment` `low-activity` or
`unmaintained`? — are exactly where a second annotator would most likely
disagree, and they are also the rows that move the numbers most. If you think a
label is wrong, the rationale and evidence are right there in the YAML; open an
issue.

**Labels drift, and the corpus does not.** `low-activity` becomes
`unmaintained`; `unmaintained` acquires a deprecation notice and becomes
`deprecated`. A package can be re-adopted. Every label was verified on a
specific date recorded at the top of the corpus file, and accuracy measured
against a stale corpus will silently decay as the world moves on. Re-verify
before quoting these numbers in a release.

**Upstream indexes lag.** ecosyste.ms mirrors can be months behind on commit
counts, issue statistics and archived flags. The detector already tracks this
and marks affected verdicts as stale with lowered confidence, and the harness
reports how many rows in each run were judged on stale data — but a verdict
built on year-old issue statistics can be wrong through no fault of the scoring
logic. Some fraction of any disagreement list is upstream lag rather than a
detector error, and the harness cannot tell you which fraction.

**Accuracy on popular packages overstates accuracy on the long tail.** This is
the most serious limitation and the least visible one. The corpus is built from
packages that are well known enough to have a checkable public history: news
coverage, maintainer statements, GitHub archive flags, download counts in the
millions. That is precisely the population where the data sources are richest
and where the detector therefore performs best. The packages a real user most
needs help with are the opposite: an obscure transitive dependency with two
hundred downloads a week, no repository link, no issue history and no advisories
— where several of the detector's signals are simply absent and it must fall
back on release cadence alone. The published numbers say very little about that
case. Assume real-world accuracy on a random lockfile is meaningfully worse than
what this harness reports, and read the `unknown` verdicts in a real scan as the
tool telling you where it has run out of data.

**The corpus is not representative by construction.** It is weighted toward hard
cases on purpose. Neither the accuracy figures nor the base rates here estimate
what fraction of a typical lockfile is abandoned; they estimate how the detector
behaves on the cases that are hard to call. Those are different questions.

**Only npm is measured.** Other registries the sources cover are untested here.

**The harness scores states, not usefulness.** A correct `unmaintained` verdict
with no successor to recommend is scored identically to one that names the fork
everybody migrated to, even though only the second is worth reading. Succession
quality is a separate concern with a separate dataset (`data/successors.yaml`)
and is not measured by this harness.
