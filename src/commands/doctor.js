import fs from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { settingsPath } from "../core/claude-settings.js";
import { loadConfig } from "../core/config.js";
import { pathExists, readJsonFile } from "../core/file-utils.js";
import { findGitRoot, runGit } from "../core/git.js";
import { scanJsonlFile } from "../core/log.js";
import { controlPath, dataDir, ledgerPath, noHooksSettingsPath, profilePath, promptsDir, telemetryPath } from "../core/paths.js";
import { cliPath, version } from "../core/path-self.js";
import { resolveProject } from "../core/project.js";

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

// Asks Git, so .gitignore, info/exclude, and global excludes all count.
function gitignored(projectRoot) {
  try {
    // check-ignore refuses the literal-pathspec mode runGit sets for diffs.
    runGit(["--no-literal-pathspecs", "check-ignore", "-q", "--no-index", ".learning-moments/config.json"], projectRoot);
    return true;
  } catch {
    return false;
  }
}

/**
 * The CLI paths that installed settings hooks run, from both settings files.
 *
 * @param {string} projectRoot
 */
async function settingsHookTargets(projectRoot) {
  const targets = new Set();
  for (const shared of [false, true]) {
    const file = settingsPath(projectRoot, shared);
    if (!(await pathExists(file))) continue;
    const settings = await readJsonFile(file).catch(() => null);
    for (const groups of Object.values(settings?.hooks ?? {})) {
      for (const group of Array.isArray(groups) ? groups : []) {
        for (const entry of Array.isArray(group?.hooks) ? group.hooks : []) {
          const [cli, sub] = Array.isArray(entry?.args) ? entry.args : [];
          if (entry?.command === "node" && sub === "hook" && typeof cli === "string" && cli.endsWith(path.join("src", "cli.js"))) {
            targets.add(cli);
          }
        }
      }
    }
  }
  return [...targets];
}

/**
 * Whether the Learning Moments plugin is enabled here. Claude Code merges
 * enabledPlugins per plugin ID, user then project then local, so a later
 * file can turn off what an earlier one turned on.
 */
async function pluginEnabled(projectRoot) {
  const files = [
    path.join(os.homedir(), ".claude", "settings.json"),
    settingsPath(projectRoot, true),
    settingsPath(projectRoot, false)
  ];
  /** @type {Record<string, unknown>} */
  const merged = {};
  for (const file of files) {
    const settings = (await pathExists(file)) ? await readJsonFile(file).catch(() => null) : null;
    Object.assign(merged, settings?.enabledPlugins ?? {});
  }
  return Object.entries(merged).some(([id, on]) => id.startsWith("learning-moments@") && on === true);
}

export async function doctorCommand() {
  const checks = [];
  let projectRoot = process.cwd();
  try {
    projectRoot = findGitRoot(process.cwd());
    checks.push({ name: "Git repo", ok: true, detail: projectRoot });
    // In a linked worktree, the data lives in the checkout where init ran.
    const project = await resolveProject(process.cwd());
    if (project && project.dataRoot !== projectRoot) {
      projectRoot = project.dataRoot;
      checks.push({ name: "Learning Moments project (informational)", ok: true, detail: projectRoot });
    }
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
  const plugin = await pluginEnabled(projectRoot);
  const hookTargets = await settingsHookTargets(projectRoot);
  checks.push({ name: "Learning data ignored by Git", ok: gitignored(projectRoot) });
  // Hooks run whatever CLI path init recorded. A Node upgrade or a version
  // manager can leave that path missing, or pointing at an old release.
  for (const target of hookTargets) {
    const pkgFile = path.join(path.dirname(path.dirname(target)), "package.json");
    const installed = (await pathExists(pkgFile)) ? (await readJsonFile(pkgFile).catch(() => ({}))).version : undefined;
    checks.push({
      name: "Hooks run this version",
      ok: installed === version(),
      detail: installed
        ? `hooks run ${installed} from ${target}; this CLI is ${version()}. Run init again to point them here.`
        : `hooks point to ${target}, which no longer exists. Run init again.`
    });
  }
  if (hookTargets.length > 0 && plugin) {
    checks.push({
      name: "Hooks installed once",
      ok: false,
      detail: "both the plugin and settings hooks are installed, so every hook runs twice. Run `init --plugin` to remove the settings hooks."
    });
  }
  checks.push({
    name: "Hooks installed",
    ok: plugin || hookTargets.length > 0,
    detail: plugin ? "by the Learning Moments plugin" : hookTargets.length > 0 ? "in Claude Code settings" : "run init"
  });
  checks.push({
    name: "Can write local data directory",
    ok: await writableDirectory(dataDir(projectRoot))
  });
  for (const [label, file] of [
    ["ledger", ledgerPath(projectRoot)],
    ["control", controlPath(projectRoot)],
    ["telemetry", telemetryPath(projectRoot)]
  ]) {
    const { malformed } = await scanJsonlFile(file, label);
    if (malformed.length > 0) {
      const lines = malformed.map((entry) => entry.line).join(", ");
      checks.push({
        name: `Readable ${label} log`,
        ok: false,
        detail: `${malformed.length} unreadable line(s) set aside in ${file} (line ${lines})`
      });
    }
  }

  for (const check of checks) {
    const optional = check.name.includes("informational");
    const status = check.ok ? "ok" : optional ? "info" : "fail";
    console.log(`${status} ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
  }

  if (checks.some((check) => !check.ok && !check.name.includes("informational"))) {
    process.exitCode = 1;
  }
}
