import fs from "node:fs/promises";
import path from "node:path";
import { installHooks } from "../core/claude-settings.js";
import { defaultConfig, parseConfig, writeConfig } from "../core/config.js";
import { defaultProfile, defaultPrompts, slashCommandPrompts } from "../core/defaults.js";
import { pathExists, writeJsonFile } from "../core/file-utils.js";
import { findGitRoot } from "../core/git.js";
import { configPath, dataDir, noHooksSettingsPath, profilePath, promptsDir } from "../core/paths.js";

async function writeIfMissing(filePath, content) {
  if (await pathExists(filePath)) {
    return false;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  return true;
}

async function ensureGitignore(projectRoot) {
  const target = path.join(projectRoot, ".gitignore");
  const line = ".learning-moments/";
  const current = (await pathExists(target)) ? await fs.readFile(target, "utf8") : "";
  if (current.split(/\r?\n/).includes(line)) {
    return false;
  }
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await fs.writeFile(target, `${current}${prefix}${line}\n`);
  return true;
}

async function installSlashCommands(projectRoot) {
  const commandDir = path.join(projectRoot, ".claude", "commands", "learning-moments");
  await fs.mkdir(commandDir, { recursive: true });
  let written = 0;
  for (const [fileName, content] of Object.entries(slashCommandPrompts)) {
    if (await writeIfMissing(path.join(commandDir, fileName), content)) {
      written += 1;
    }
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
      console.log(`Existing config did not validate: ${error?.message ?? error}`);
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
  const gitignoreChanged = await ensureGitignore(projectRoot);
  const settingsFile = await installHooks(projectRoot, Boolean(options.shared));
  const slashCommands = await installSlashCommands(projectRoot);

  console.log("Learning Moments initialized.");
  console.log(`Project: ${projectRoot}`);
  console.log(`Settings: ${settingsFile}`);
  console.log(`Config: ${configAction}`);
  console.log(`Slash commands written: ${slashCommands}`);
  console.log(`Gitignore updated: ${gitignoreChanged ? "yes" : "no"}`);
}
