// @ts-check
import path from "node:path";

export const dataDirName = ".learning-moments";

/** @param {string} projectRoot */
export function dataDir(projectRoot) {
  return path.join(projectRoot, dataDirName);
}

/** @param {string} projectRoot */
export function configPath(projectRoot) {
  return path.join(dataDir(projectRoot), "config.json");
}

/** @param {string} projectRoot */
export function profilePath(projectRoot) {
  return path.join(dataDir(projectRoot), "profile.md");
}

/**
 * Path for the unified pre-migration log. Migration reads this file,
 * partitions it into the three class files, and deletes it once the
 * `.migration-complete` marker is written. Nothing reads it afterward.
 * Kept distinct from `telemetryPath` so migration never overwrites its
 * own source — a crash mid-migration leaves it intact for a clean retry.
 *
 * @param {string} projectRoot
 */
export function logPath(projectRoot) {
  return path.join(dataDir(projectRoot), "moments.jsonl");
}

/**
 * Path for the durable learning record. Holds Class A events
 * (`moment_*`, `answer_received`, `grade_*`, `classifier_completed`,
 * `grader_completed`, etc.). Retained forever.
 *
 * @param {string} projectRoot
 */
export function ledgerPath(projectRoot) {
  return path.join(dataDir(projectRoot), "ledger.jsonl");
}

/**
 * Path for hot-path control state (Class B): `classifier_called` and
 * `candidate_already_seen`. Age-pruned at session start.
 *
 * @param {string} projectRoot
 */
export function controlPath(projectRoot) {
  return path.join(dataDir(projectRoot), "control.jsonl");
}

/**
 * Path for disposable telemetry (Class C). Truncatable any time via
 * `learning-moments delete-data --logs-only`. Distinct from the legacy
 * unified log (`logPath`) so migration writes here without clobbering its
 * source.
 *
 * @param {string} projectRoot
 */
export function telemetryPath(projectRoot) {
  return path.join(dataDir(projectRoot), "telemetry.jsonl");
}

/**
 * Marker file written by the one-time migration from the unified
 * `moments.jsonl` to the three-class split. Until it exists, hooks fall
 * back to the legacy mixed log. `init` is the only thing that creates it.
 *
 * @param {string} projectRoot
 */
export function migrationCompletePath(projectRoot) {
  return path.join(dataDir(projectRoot), ".migration-complete");
}

/** @param {string} projectRoot */
export function locksDir(projectRoot) {
  return path.join(dataDir(projectRoot), "locks");
}

/** @param {string} projectRoot */
export function promptsDir(projectRoot) {
  return path.join(dataDir(projectRoot), "prompts");
}

/** @param {string} projectRoot */
export function noHooksSettingsPath(projectRoot) {
  return path.join(dataDir(projectRoot), "claude-no-hooks-settings.json");
}
