/**
 * The file `npm test` actually runs.
 *
 * `npm test` invokes `node --import tsx --test test/**\/*.test.ts`. The shell
 * expands that pattern before node ever sees it, and `sh` has no `globstar`, so
 * `**` collapses to a single `*`: the pattern means `test/<dir>/<file>.test.ts`
 * and never matches the suites sitting directly in `test/`. Node 22 would glob
 * the pattern itself if the shell passed it through untouched, but Node 20 —
 * which this project supports and CI tests — treats it as a literal path and
 * exits with "Could not find".
 *
 * One file one directory deep satisfies the shell on every supported Node, and
 * importing the suites here registers all of their tests in this process. The
 * suites remain independently runnable: `node --import tsx --test
 * test/score.test.ts` works exactly as it reads.
 */

// First, so nothing imported below can reach upstream.
import '../no-network.js';

import '../cache.test.js';
import '../lockfile.test.js';
import '../report.test.js';
import '../robustness.test.js';
import '../score.test.js';
import '../semver.test.js';
import '../successors.test.js';
