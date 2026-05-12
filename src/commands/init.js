import fs from "node:fs/promises";
import path from "node:path";
import { installHooks } from "../core/claude-settings.js";
import { defaultConfig, writeConfig } from "../core/config.js";
import { defaultProfile, defaultPrompts, slashCommandPrompts } from "../core/defaults.js";
import { pathExists, writeJsonFile } from "../core/file-utils.js";
import { findGitRoot } from "../core/git.js";
import { dataDir, noHooksSettingsPath, profilePath, promptsDir } from "../core/paths.js";

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
  if (!(await pathExists(path.join(dataDir(projectRoot), "config.json")))) {
    await writeConfig(projectRoot, config);
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
  console.log(`Slash commands written: ${slashCommands}`);
  console.log(`Gitignore updated: ${gitignoreChanged ? "yes" : "no"}`);
}
