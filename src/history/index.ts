/**
 * Longitudinal health: the archive, and what reading it twice tells you.
 *
 * Two halves that only make sense together. `store` accumulates one
 * `HealthSnapshot` per package per ISO week on disk — the part that has to
 * start early, because history cannot be backfilled. `trajectory` is what that
 * archive buys: the direction a package is moving, which no upstream index can
 * answer because none of them publish anything but the present.
 */

// The archive.
export {
  HISTORY_DIR,
  appendSnapshots,
  isoWeekKey,
  readAllSnapshots,
  readSnapshotsFor,
  snapshotPath,
} from './store.js';

// What the archive is for: the questions a single snapshot cannot answer.
export {
  computeTrajectory,
  summarise,
  MIN_SAMPLES_FOR_TRAJECTORY,
  SCORE_DELTA_MATERIAL,
  SCORE_DELTA_SEVERE,
  DEPENDENT_FLIGHT_MATERIAL,
  DEPENDENT_FLIGHT_SEVERE,
  DEPENDENT_FLIGHT_MIN_BASELINE,
  IMPLAUSIBLE_STEP_RATIO,
  RESPONSIVENESS_MATERIAL,
  RESPONSIVENESS_MIN_ISSUES,
} from './trajectory.js';
