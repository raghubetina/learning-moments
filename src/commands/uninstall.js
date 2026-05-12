import fs from "node:fs/promises";
import path from "node:path";
import { uninstallHooks } from "../core/claude-settings.js";
import { findGitRoot } from "../core/git.js";

export async function uninstallCommand() {
  const projectRoot = findGitRoot(process.cwd());
  const local = await uninstallHooks(projectRoot, false);
  const shared = await uninstallHooks(projectRoot, true);
  await fs.rm(path.join(projectRoot, ".claude", "commands", "learning-moments"), {
    recursive: true,
    force: true
  });

  console.log("Learning Moments hooks and slash commands removed.");
  if (local) {
    console.log(`Updated: ${local}`);
  }
  if (shared) {
    console.log(`Updated: ${shared}`);
  }
  console.log("Local learning data was not deleted. Run `learning-moments delete-data` to remove it.");
}
