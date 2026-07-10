import fs from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { settingsPath } from "../core/claude-settings.js";
import { loadConfig } from "../core/config.js";
import { pathExists } from "../core/file-utils.js";
import { findGitRoot } from "../core/git.js";
import { dataDir, noHooksSettingsPath, profilePath, promptsDir } from "../core/paths.js";
import { cliPath } from "../core/path-self.js";

const execFileAsync = promisify(execFile);

export async function writableDirectory(directoryPath) {
  try {
    await fs.access(directoryPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function commandAvailable(command, args) {
  try {
    await execFileAsync(command, args, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function gitignored(projectRoot) {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  try {
    const gitignore = await fs.readFile(gitignorePath, "utf8");
    return gitignore.split(/\r?\n/).includes(".learning-moments/");
  } catch {
    return false;
  }
}

export async function doctorCommand() {
  const checks = [];
  let projectRoot = process.cwd();
  try {
    projectRoot = findGitRoot(process.cwd());
    checks.push({ name: "Git repo", ok: true, detail: projectRoot });
  } catch (error) {
    checks.push({
      name: "Git repo",
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    });
  }

  checks.push({ name: "Learning Moments data", ok: await pathExists(dataDir(projectRoot)) });
  checks.push({ name: "CLI entrypoint", ok: await pathExists(cliPath()), detail: cliPath() });
  checks.push({
    name: "learning-moments on PATH (informational)",
    ok: await commandAvailable("learning-moments", ["--version"])
  });
  checks.push({ name: "Claude Code command", ok: await commandAvailable("claude", ["--version"]) });
  try {
    await loadConfig(projectRoot);
    checks.push({ name: "Configuration", ok: true });
  } catch (error) {
    checks.push({
      name: "Configuration",
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    });
  }
  checks.push({ name: "Profile", ok: await pathExists(profilePath(projectRoot)) });
  checks.push({ name: "Prompt files", ok: await pathExists(promptsDir(projectRoot)) });
  checks.push({ name: "Internal Claude settings", ok: await pathExists(noHooksSettingsPath(projectRoot)) });
  checks.push({ name: "Learning data ignored by Git", ok: await gitignored(projectRoot) });
  checks.push({
    name: "Claude local settings",
    ok:
      (await pathExists(settingsPath(projectRoot, false))) ||
      (await pathExists(settingsPath(projectRoot, true)))
  });
  checks.push({
    name: "Can write local data directory",
    ok: await writableDirectory(dataDir(projectRoot))
  });

  for (const check of checks) {
    const optional = check.name.includes("informational");
    const status = check.ok ? "ok" : optional ? "info" : "fail";
    console.log(`${status} ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
  }

  if (checks.some((check) => !check.ok && !check.name.includes("informational"))) {
    process.exitCode = 1;
  }
}
