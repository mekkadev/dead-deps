# the health archive

One `HealthSnapshot` per line, one file per ISO week: `YYYY-Www.ndjson`.

## why it exists

Every index in this space — the npm registry, ecosyste.ms, deps.dev, every
commercial scanner — publishes a package's **current** state and nothing else.
Ask any of them "is this getting worse?" and there is no answer, because the
question needs two observations and they keep one.

That gap is not an oversight, it is a property of the data: history cannot be
bought, licensed, or backfilled. It can only be accumulated. A week that goes
unsampled is gone permanently, and someone who starts sampling a year from now
is a year behind for good.

So the archive started before the features that read it were finished. It is
the one asset here that grows while nobody is working on it.

## format

Newline-delimited JSON. One line per package per week, fields in the order they
are declared on `HealthSnapshot` in `src/types.ts`, no whitespace, sorted by
case-folded package name.

NDJSON rather than one JSON document per week because a weekly append is then a
clean one-sided git diff, and a truncated write costs one line instead of the
file. Roughly 360 bytes per row: 500 packages sampled weekly is about 9 MB a
year.

Only fields whose **change** carries meaning are stored. Prose, URLs and
descriptions never move, and keeping them would multiply the archive for
nothing.

## reading it

```ts
import { readAllSnapshots, readSnapshotsFor, computeTrajectory } from 'dead-deps';

const samples = await readSnapshotsFor('request');
const trend = computeTrajectory(samples); // null until two samples exist
```

A corrupt line is skipped, never thrown on — eleven good months should not be
lost to one bad write. Load-bearing fields (`name`, `observedAt`, `state`,
`score`, the two counts) must be present or the row is dropped; a missing
`activeMaintainers` is **not** defaulted to zero, because inventing a maintainer
exodus out of a truncated line is worse than having no sample at all.

## how it is filled

`.github/workflows/snapshot.yml` runs weekly and commits the result. The sample
is the most-depended-on npm packages plus every `from` in
[`../successors.yaml`](../successors.yaml) — the packages this project makes
claims about are the ones whose history matters most.

Locally: `DEAD_DEPS_CONTACT=you@example.com npm run snapshot -- --top 500`

## what is not here

The archive is **not** shipped in the npm tarball. It grows without bound and a
consumer installing the CLI wants a tool, not a few megabytes of somebody
else's time series. `--history` therefore works from a clone, or against any
directory named by `DEAD_DEPS_HISTORY_DIR`, and says plainly when it has
nothing to go on rather than implying stability it has not observed.
