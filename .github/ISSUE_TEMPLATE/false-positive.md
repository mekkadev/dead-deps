---
name: False positive — a healthy package was flagged
about: dead-deps reported a package that is fine. This is the most valuable bug report this project receives.
title: 'False positive: <package>'
labels: ['false-positive', 'calibration']
---

Keeping finished packages out of the report is this tool's main design goal, and
the published false-positive rate is measured against a labelled corpus. A
confirmed report here gets added to that corpus, so it protects everyone from
the same mistake permanently. Thank you for filing it.

**Package name and version**

<!-- e.g. inherits@2.0.4 -->

**What dead-deps said**

<!-- Paste the finding, including the state, the score and the evidence lines. -->

```
```

**Why you believe it is fine**

<!-- The important part. Which of these applies? -->

- [ ] It is **finished** — small, stable, does its job, nothing left to add
- [ ] It is **still maintained**, just slowly or on a long release cycle
- [ ] Maintenance moved somewhere the tool cannot see (a fork, a monorepo, a new name)
- [ ] The evidence itself is wrong or out of date
- [ ] Something else

**Evidence, if you have any**

<!-- A recent commit, a maintainer statement, a release. Links beat assertions. -->

**Version and command**

<!-- Output of `dead-deps --version`, and the exact command you ran. -->
