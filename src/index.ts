/**
 * dead-deps — public library entry point.
 *
 * `scan()` is the whole tool in one call: point it at a project and it returns
 * a fully populated `ScanResult`. The pieces underneath it are exported too,
 * so a caller that already has a lockfile, or wants to judge a single package,
 * can use them directly. The CLI and the MCP server are both built on exactly
 * what is re-exported here.
 */

// The one-call pipeline.
export { scan } from './scan.js';

// Lockfile discovery and parsing, for callers driving the pipeline themselves.
export { detectLockfiles, parseLockfile } from './lockfile/index.js';

// Upstream signals. `gatherSignals` needs an `HttpClient`, so they travel together.
export { HttpClient, gatherSignals } from './sources/index.js';
export type { HttpClientOptions } from './sources/index.js';

// The verdict engine.
export { assess } from './detect/score.js';

// The curated succession dataset.
export { DEFAULT_DATASET_PATH, loadSuccessors, lookupSuccessor } from './successors/index.js';

// Reporters.
export { renderTerminal } from './report/terminal.js';
export { renderJson, SCHEMA_VERSION } from './report/json.js';

// Shared contracts: every type, plus `STATE_SEVERITY`, `DEFAULT_SCAN_OPTIONS` and `EXIT`.
export * from './types.js';
