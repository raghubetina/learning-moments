import path from "node:path";

export const dataDirName = ".learning-moments";

export function dataDir(projectRoot) {
  return path.join(projectRoot, dataDirName);
}

export function configPath(projectRoot) {
  return path.join(dataDir(projectRoot), "config.json");
}

export function profilePath(projectRoot) {
  return path.join(dataDir(projectRoot), "profile.md");
}

export function logPath(projectRoot) {
  return path.join(dataDir(projectRoot), "moments.jsonl");
}

export function locksDir(projectRoot) {
  return path.join(dataDir(projectRoot), "locks");
}

export function promptsDir(projectRoot) {
  return path.join(dataDir(projectRoot), "prompts");
}

export function noHooksSettingsPath(projectRoot) {
  return path.join(dataDir(projectRoot), "claude-no-hooks-settings.json");
}
