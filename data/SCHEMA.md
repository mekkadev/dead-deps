# `successors.yaml` schema

A curated, hand-verified map from packages that stopped being maintained to
whatever actually succeeded them. Every row is checked by a human against
primary sources. Machine-generated guesses do not belong in this file.

## Inclusion rules

A row may be added only when **all** of these hold:

1. The `from` package is genuinely no longer maintained, deprecated, or
   explicitly superseded — and this is publicly documented.
2. The succession is **consensus**, not opinion. If reasonable engineers
   disagree about the replacement, either set `confidence: low` and list the
   candidates under `alternatives`, or leave the row out.
3. At least one `evidence` entry points at a primary source: an npm deprecation
   notice, a maintainer statement, an archived repository, a README, a release
   note, or an official migration guide. Blog posts and Stack Overflow answers
   are supporting evidence, never the only evidence.

Rows about small, finished, still-working packages (`six`-style "it is done,
not dead") must **not** be added. Being quiet is not being abandoned.

## Fields

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `from` | string | yes | Exact npm package name that is dead or superseded. |
| `to` | string \| null | yes | Primary recommended successor. `null` when nothing credible exists. |
| `toKind` | `package` \| `platform` \| `none` | yes | What `to` actually is. See below. |
| `type` | enum | yes | How the successor relates to `from`. See below. |
| `confidence` | `high` \| `medium` \| `low` | yes | How settled the succession is. |
| `since` | `YYYY-MM` \| null | yes | Approximately when `from` stopped being maintained. |
| `dropIn` | boolean | yes | Whether the successor is API-compatible enough to swap directly. |
| `alternatives` | string[] | yes | Other credible options. May be empty. |
| `notes` | string | yes | Two or three sentences of plain prose. Rendered on the website. |
| `migration` | string \| null | yes | One concrete migration hint, or `null`. |
| `evidence` | list | yes | `{ label, url }` pairs. At least one. |

### `toKind` values

About a fifth of real successions do not point at a package at all. Forcing a
language feature into a package-name field would make the tool recommend
installing something that does not exist, so the schema names the difference.

| Value | Meaning | `to` holds |
| --- | --- | --- |
| `package` | The successor is an npm package you install. | `undici` |
| `platform` | The capability moved into the language or runtime — the right fix is to delete the dependency. | `String.prototype.padStart` |
| `bundled` | The capability now ships inside a package the project already has. Delete the line; install nothing. `to` names the package that carries it. | `uuid` (for `@types/uuid`) |
| `none` | No *single* package succeeds it — either nothing did, or it fragmented into a family and which piece you need depends on your usage. `to` is `null`; name the pieces under `alternatives`. | `null` |

Every deprecated `@types/*` stub is `bundled`: the typings moved into the
library itself. Recording those as `none` would read as a dead end when the
instruction is simply to remove the dependency.

`dropIn` must be `false` whenever `toKind` is not `package`: there is no package
to swap in.

### `type` values

| Value | Meaning | Example |
| --- | --- | --- |
| `fork` | Community forked the original and carried it on. | `faker` → `@faker-js/faker` |
| `rename` | Same project, published under a new name or scope. | `istanbul` → `nyc` |
| `replacement` | Unrelated project that the ecosystem migrated to. | `request` → `undici` |
| `absorbed` | Functionality moved into the platform or stdlib. | `left-pad` → `String.prototype.padStart` |
| `self-declared` | Original maintainers named the successor themselves. | `moment` → `luxon` |
| `reimplementation` | Same idea rebuilt from scratch, usually by the same team. | `node-sass` → `sass` |

## Example row

```yaml
- from: request
  to: undici
  toKind: package
  type: replacement
  confidence: high
  since: "2020-02"
  dropIn: false
  alternatives:
    - got
    - axios
    - node-fetch
  notes: >-
    request was fully deprecated in February 2020 after the maintainers
    concluded the project could not keep up with modern HTTP features. It still
    installs and still works, but receives no fixes, and its callback-first API
    predates promises.
  migration: >-
    undici ships with Node.js as the engine behind global fetch; for most
    call sites `fetch()` is enough and no dependency is needed at all.
  evidence:
    - label: "Maintainer announcement: request is deprecated"
      url: https://github.com/request/request/issues/3142
    - label: "npm registry deprecation notice"
      url: https://www.npmjs.com/package/request
```

## Style

- `notes` is read by humans on a web page. Write plainly, no marketing.
- Never disparage maintainers. "No longer maintained" is a fact; "neglected" is
  an insult. Abandonment is normal and usually unpaid.
- Prefer the successor the ecosystem actually moved to over the one that is
  technically nicest.
