## What changed, and why

<!-- One paragraph. The "why" matters more than the "what" — the diff shows the what. -->

## How it was verified

<!-- Tick what you ran. -->

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm run calibrate` — required for any change to `src/detect/score.ts`
- [ ] `npm run site` — required for any change to `site/` or `data/successors.yaml`

<!--
Changing the detector? Paste the before/after calibration summary. A change
that raises recall while raising the false-positive rate on the
`stable-complete` bucket will not be merged — that rate is the product.
-->

## Adding rows to `data/successors.yaml`?

Delete this section if not. Otherwise every box must be ticked — see
[`data/SCHEMA.md`](../blob/main/data/SCHEMA.md).

- [ ] The `from` package is genuinely deprecated, unmaintained or superseded, **and this is publicly documented**
- [ ] It is **not** a small finished package that simply needs no commits (`ms`, `inherits`, `once` and friends do not belong here)
- [ ] At least one `evidence` entry points at a **primary source**: an npm deprecation notice, a maintainer statement, an archived repository, a README, or an official migration guide
- [ ] Every evidence URL resolves
- [ ] `type` is correct: `fork`, `rename`, `replacement`, `absorbed`, `self-declared` or `reimplementation`
- [ ] `toKind` is correct: `package`, `platform` (the capability moved into the language or runtime) or `none`
- [ ] `dropIn` is `false` unless the successor is an API-compatible package swap
- [ ] The successor itself is alive
- [ ] `notes` states facts and does not disparage maintainers — abandonment is normal and usually unpaid
