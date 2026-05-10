import fs from "node:fs/promises";
import path from "node:path";
import { settingsPath } from "../core/claude-settings.js";
import { loadConfig } from "../core/config.js";
import { pathExists } from "../core/file-utils.js";
import { findGitRoot } from "../core/git.js";
import { dataDir, logPath, noHooksSettingsPath, profilePath, promptsDir } from "../core/paths.js";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

async function writable(filePath: string): Promise<boolean> {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, "");
    return true;
  } catch {
    return false;
  }
}

export async function doctorCommand(): Promise<void> {
  const checks: Check[] = [];
  let projectRoot = process.cwd();
  try {
    projectRoot = findGitRoot(process.cwd());
    checks.push({ name: "Git repo", ok: true, detail: projectRoot });
  } catch (error) {
    checks.push({ name: "Git repo", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  checks.push({ name: "Data directory", ok: await pathExists(dataDir(projectRoot)) });
  try {
    await loadConfig(projectRoot);
    checks.push({ name: "Config", ok: true });
  } catch (error) {
    checks.push({ name: "Config", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  checks.push({ name: "Profile", ok: await pathExists(profilePath(projectRoot)) });
  checks.push({ name: "Prompts", ok: await pathExists(promptsDir(projectRoot)) });
  checks.push({ name: "No-hooks settings", ok: await pathExists(noHooksSettingsPath(projectRoot)) });
  checks.push({
    name: "Claude local settings",
    ok: await pathExists(settingsPath(projectRoot, false)) || await pathExists(settingsPath(projectRoot, true))
  });
  checks.push({ name: "Log path writable", ok: await writable(logPath(projectRoot)) });

  for (const check of checks) {
    console.log(`${check.ok ? "ok" : "fail"} ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
  }

  if (checks.some((check) => !check.ok)) {
    process.exitCode = 1;
  }
}
