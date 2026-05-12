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

/** @param {string} projectRoot */
export function logPath(projectRoot) {
  return path.join(dataDir(projectRoot), "moments.jsonl");
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
