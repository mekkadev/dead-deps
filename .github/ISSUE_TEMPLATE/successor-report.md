---
name: Successor report
about: Report a dead, deprecated or superseded npm package and what replaced it
title: 'successor: <dead-package> → <successor>'
labels: ['dataset', 'successor-report']
assignees: ''
---

<!--
Thank you — curated rows are the most valuable contribution this project takes.

Everything below marked REQUIRED must be filled in. The one rule that gets rows
rejected more than any other: at least one evidence URL must be a PRIMARY
source — an npm deprecation notice, a maintainer statement, an archived
repository, or an official migration guide. Blog posts and Stack Overflow
answers are supporting evidence, never the only evidence.

Field definitions live in data/SCHEMA.md. The evidence and inclusion bars are
in CONTRIBUTING.md.
-->

## The package that died

**REQUIRED — exact npm package name:**

<!-- e.g. request -->

**REQUIRED — roughly when did it stop being maintained? (`YYYY-MM`, or "unknown"):**

<!-- e.g. 2020-02 -->

## The successor

**REQUIRED — what replaced it:**

<!--
An npm package name (e.g. undici), a platform feature (e.g.
String.prototype.padStart), or the word "none" if nothing credible did.
-->

**REQUIRED — what kind of thing is that? Tick exactly one:**

- [ ] `package` — an npm package you install
- [ ] `platform` — a language or runtime feature; the right fix is to delete the dependency
- [ ] `none` — nothing credible succeeded it

**REQUIRED — how does it succeed the original? Tick exactly one:**

- [ ] `fork` — the community forked the original and carried it on
- [ ] `rename` — same project, new name or scope
- [ ] `replacement` — an unrelated project the ecosystem migrated to
- [ ] `absorbed` — the capability moved into the platform or stdlib
- [ ] `self-declared` — the original maintainers named the successor themselves
- [ ] `reimplementation` — the same idea rebuilt from scratch

**REQUIRED — is it a drop-in swap?**

- [ ] Yes — API-compatible enough to change the dependency and nothing else
- [ ] No — calling code has to change

<!-- "Drop-in" can only be yes for a `package`. There is nothing to swap in otherwise. -->

**REQUIRED — how settled is this succession?**

- [ ] `high` — the ecosystem has clearly moved; nobody credible disagrees
- [ ] `medium` — the common answer, but not unanimous
- [ ] `low` — reasonable engineers still disagree (list the candidates below)

**Other credible options, if any:**

<!-- e.g. got, axios, node-fetch -->

## Evidence

**REQUIRED — at least one PRIMARY source. One per line, as `label — URL`.**

<!--
A primary source is one of:
  - an npm deprecation notice on the package
  - a statement by a maintainer of the dead package (issue, README, release note)
  - an archived source repository
  - an official migration guide from either project

Example:
  Maintainer announcement: request is deprecated — https://github.com/request/request/issues/3142
  npm registry deprecation notice — https://www.npmjs.com/package/request
-->

1.
2.

**Supporting (non-primary) sources, optional:**

<!-- Blog posts, talks, ecosystem surveys. Never sufficient on their own. -->

## Notes for the dataset

**REQUIRED — two or three sentences of plain prose, as a reader of the website would want them.**

<!--
State facts, not judgements. "No releases since 2019" is a fact; "neglected" is
an insult. Say what happened, what the successor is, and anything a reader
needs to know before switching. No marketing.
-->

**One concrete migration hint, if you have one:**

<!--
The import change, the codemod, the flag. E.g. "Node 18+ ships a global fetch()
backed by undici, so most simple call sites need no dependency at all."
-->

## Checks

- [ ] The dead package is genuinely unmaintained, deprecated or superseded, and this is **publicly documented** — not just my own experience of a slow maintainer.
- [ ] At least one evidence URL above is a **primary source**, and every URL resolves today.
- [ ] This is **not** a small, finished, still-working package. Quiet is not dead: `ms`, `inherits` and `once` are complete, not abandoned, and rows for packages like them are rejected.
- [ ] I searched [`data/successors.yaml`](https://github.com/mekkadev/dead-deps/blob/main/data/successors.yaml) and the [package index](https://mekkadev.github.io/dead-deps/) and this package has no row yet.
- [ ] I have read the evidence bar in [CONTRIBUTING.md](https://github.com/mekkadev/dead-deps/blob/main/CONTRIBUTING.md).

<!--
Happy to write the YAML yourself? Even better — send a pull request against
data/successors.yaml using the example row in data/SCHEMA.md, and link it here.
-->
