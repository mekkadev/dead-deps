# Security policy

## Reporting a vulnerability

Report security issues in dead-deps itself through
[GitHub's private vulnerability reporting](https://github.com/mekkadev/dead-deps/security/advisories/new).
Please do not open a public issue for something exploitable.

Expect an acknowledgement within a week. If a fix is warranted it ships as a
patch release with an advisory naming the affected versions.

**This is not the place to report a vulnerability in some other npm package.**
dead-deps only reads public advisory data; it does not originate it. Report
those to the package's own maintainers, or to
[GitHub Security Advisories](https://github.com/advisories).

## What dead-deps actually does

A tool that talks about supply-chain risk should be precise about its own
surface, so here is the whole of it.

**It reads:**

- Lockfiles and `package.json` in the directory you point it at — only the
  dependency names, version specifiers and scopes.
- Its own cache, by default under `$XDG_CACHE_HOME/dead-deps` or
  `~/.cache/dead-deps` (override with `DEAD_DEPS_CACHE_DIR`).
- The bundled `data/successors.yaml`.

**It sends:**

- One HTTPS request per package to
  [`packages.ecosyste.ms`](https://packages.ecosyste.ms) and one to
  [`registry.npmjs.org`](https://registry.npmjs.org), containing the package
  name and nothing else.
- A `User-Agent` identifying the tool and its version. If you pass `--contact`
  or set `DEAD_DEPS_CONTACT`, that address is included so ecosyste.ms can reach
  you and can place your requests in their polite pool. It is optional.

**It never:**

- Uploads your source code, your lockfile, or any file contents. Package names
  and versions are the only project data that leaves the machine, and they go
  only to the two hosts above.
- Executes, installs, imports or evaluates any dependency it inspects. Verdicts
  come entirely from registry and index metadata.
- Requires, reads or stores credentials. Both upstreams are public and
  unauthenticated; there is no token to leak.
- Writes anywhere outside its cache directory. It never modifies your project.

**Threat model.** The realistic risks are that a compromised upstream index
returns bad metadata and the tool reports a wrong verdict, or that a malicious
package name in a lockfile is echoed into terminal output. Verdict data is
treated as untrusted input: it is parsed defensively, and text interpolated
into reports is truncated and escaped. Because nothing is executed and no
credentials exist, a bad response is a correctness problem rather than a code
execution one.

**Network.** Outbound access is required for a scan. With no network, the tool
degrades to `unknown` verdicts and a clear error rather than crashing. The
on-disk cache means repeated runs may make no requests at all.

## Supported versions

Pre-1.0. Only the latest published version receives fixes.
