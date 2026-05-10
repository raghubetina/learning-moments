import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { settingsPath } from "../core/claude-settings.js";
import { loadConfig } from "../core/config.js";
import { pathExists } from "../core/file-utils.js";
import { findGitRoot } from "../core/git.js";
import { dataDir, logPath, noHooksSettingsPath, profilePath, promptsDir } from "../core/paths.js";

const execFileAsync = promisify(execFile);

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

async function commandAvailable(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function gitignored(projectRoot: string): Promise<boolean> {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  try {
    const gitignore = await fs.readFile(gitignorePath, "utf8");
    return gitignore.split(/\r?\n/).includes(".learning-moments/");
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
  checks.push({ name: "learning-moments command", ok: await commandAvailable("learning-moments", ["--version"]) });
  checks.push({ name: "Claude Code command", ok: await commandAvailable("claude", ["--version"]) });
  try {
    await loadConfig(projectRoot);
    checks.push({ name: "Config", ok: true });
  } catch (error) {
    checks.push({ name: "Config", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  checks.push({ name: "Profile", ok: await pathExists(profilePath(projectRoot)) });
  checks.push({ name: "Prompts", ok: await pathExists(promptsDir(projectRoot)) });
  checks.push({ name: "No-hooks settings", ok: await pathExists(noHooksSettingsPath(projectRoot)) });
  checks.push({ name: ".learning-moments gitignored", ok: await gitignored(projectRoot) });
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
