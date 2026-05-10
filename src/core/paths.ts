import path from "node:path";

export const dataDirName = ".learning-moments";

export function dataDir(projectRoot: string): string {
  return path.join(projectRoot, dataDirName);
}

export function configPath(projectRoot: string): string {
  return path.join(dataDir(projectRoot), "config.json");
}

export function profilePath(projectRoot: string): string {
  return path.join(dataDir(projectRoot), "profile.md");
}

export function logPath(projectRoot: string): string {
  return path.join(dataDir(projectRoot), "moments.jsonl");
}

export function locksDir(projectRoot: string): string {
  return path.join(dataDir(projectRoot), "locks");
}

export function promptsDir(projectRoot: string): string {
  return path.join(dataDir(projectRoot), "prompts");
}

export function noHooksSettingsPath(projectRoot: string): string {
  return path.join(dataDir(projectRoot), "claude-no-hooks-settings.json");
}
