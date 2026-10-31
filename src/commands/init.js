import fs from "node:fs/promises";
import path from "node:path";
import { installHooks, uninstallHooks } from "../core/claude-settings.js";
import { defaultConfig, parseConfig, writeConfig } from "../core/config.js";
import { commandPrompts, defaultProfile, defaultPrompts, renderCommandPrompt } from "../core/defaults.js";
import { pathExists, writeJsonFile } from "../core/file-utils.js";
import { findGitRoot, runGit } from "../core/git.js";
import { cliPath } from "../core/path-self.js";
import { migrateLegacyLog } from "../core/migrate.js";
import { configPath, dataDir, noHooksSettingsPath, profilePath, promptsDir } from "../core/paths.js";

async function writeIfMissing(filePath, content) {
  if (await pathExists(filePath)) {
    return false;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  return true;
}

/**
 * Keep Learning Moments' local files out of Git with the repository's own
 * `info/exclude`, not `.gitignore`. A `.gitignore` line is a change to a
 * tracked file that a branch switch or a teammate's commit can undo; when
 * it was lost in one of the author's repositories, the tool's own logs
 * became untracked files that could be committed.
 *
 * @param {string} projectRoot
 * @param {string[]} lines
 */
async function ensureGitExclude(projectRoot, lines) {
  const target = path.resolve(projectRoot, runGit(["rev-parse", "--git-path", "info/exclude"], projectRoot).trim());
  await fs.mkdir(path.dirname(target), { recursive: true });
  const current = (await pathExists(target)) ? await fs.readFile(target, "utf8") : "";
  const existing = new Set(current.split(/\r?\n/));
  const missing = lines.filter((line) => !existing.has(line));
  if (missing.length === 0) return false;
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await fs.appendFile(target, `${prefix}${missing.join("\n")}\n`);
  return true;
}

/** How the installed command prompts run this CLI: its absolute path. */
function cliInvocation() {
  const cli = cliPath();
  return /\s/.test(cli) ? `node "${cli}"` : `node ${cli}`;
}

async function installSlashCommands(projectRoot) {
  const commandDir = path.join(projectRoot, ".claude", "commands", "learning-moments");
  await fs.mkdir(commandDir, { recursive: true });
  let written = 0;
  for (const [name, prompt] of Object.entries(commandPrompts(cliInvocation()))) {
    await fs.writeFile(path.join(commandDir, `${name}.md`), renderCommandPrompt(prompt));
    written += 1;
  }
  return written;
}

export async function initCommand(options) {
  const projectRoot = findGitRoot(process.cwd());
  await fs.mkdir(dataDir(projectRoot), { recursive: true });
  await fs.mkdir(promptsDir(projectRoot), { recursive: true });
  await fs.mkdir(path.join(dataDir(projectRoot), "locks"), { recursive: true });

  const config = {
    ...defaultConfig,
    mode: options.observeOnly ? "observe_only" : defaultConfig.mode
  };
  const configFile = configPath(projectRoot);
  let configAction = "skipped (already valid)";
  if (await pathExists(configFile)) {
    // Existing config — try a strict parse. If it fails (typically because
    // of fields that were removed in a prior version), move the file aside
    // and write the default. We do not silently mutate the user's config;
    // the .bak is preserved so customizations can be merged back by hand.
    try {
      const raw = JSON.parse(await fs.readFile(configFile, "utf8"));
      parseConfig(raw);
    } catch (error) {
      const backup = `${configFile}.bak`;
      await fs.rename(configFile, backup);
      await writeConfig(projectRoot, config);
      configAction = `migrated (moved bad config to ${path.basename(backup)})`;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`Existing config did not validate: ${message}`);
      console.log(`  Backed up to ${backup}`);
      console.log(`  Default config written. Merge any customizations back by hand.`);
    }
  } else {
    await writeConfig(projectRoot, config);
    configAction = "written (new)";
  }

  await writeIfMissing(profilePath(projectRoot), defaultProfile);
  for (const [fileName, content] of Object.entries(defaultPrompts)) {
    await writeIfMissing(path.join(promptsDir(projectRoot), fileName), content);
  }

  await writeJsonFile(noHooksSettingsPath(projectRoot), { disableAllHooks: true });
  const excludeChanged = await ensureGitExclude(projectRoot, [
    ".learning-moments/",
    ...(options.plugin ? [] : [".claude/commands/learning-moments/"])
  ]);
  const migration = await migrateLegacyLog(projectRoot);

  console.log("Learning Moments initialized.");
  console.log(`Project: ${projectRoot}`);
  console.log(`Config: ${configAction}`);
  console.log(`Git exclude updated: ${excludeChanged ? "yes" : "no"}`);

  if (options.plugin) {
    // The plugin supplies the hooks and commands. Settings hooks from an
    // npm install would run every hook twice alongside it.
    const removed = [await uninstallHooks(projectRoot, false), await uninstallHooks(projectRoot, true)].filter(Boolean);
    await fs.rm(path.join(projectRoot, ".claude", "commands", "learning-moments"), { recursive: true, force: true });
    console.log("Hooks and commands: provided by the Learning Moments plugin");
    if (removed.length > 0) console.log(`Removed settings hooks from: ${removed.join(", ")}`);
  } else {
    const settingsFile = await installHooks(projectRoot, Boolean(options.shared));
    const slashCommands = await installSlashCommands(projectRoot);
    console.log(`Settings: ${settingsFile}`);
    console.log(`Slash commands written: ${slashCommands}`);
  }
  if (migration.migrated && migration.ledger + migration.control + migration.telemetry > 0) {
    console.log(
      `Log split: migrated ${migration.ledger + migration.control + migration.telemetry} events ` +
        `(ledger ${migration.ledger} / control ${migration.control} / telemetry ${migration.telemetry})`
    );
  }
}
