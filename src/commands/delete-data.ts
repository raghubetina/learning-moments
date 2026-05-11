import fs from "node:fs/promises";
import { findGitRoot } from "../core/git.js";
import { dataDir } from "../core/paths.js";

export async function deleteDataCommand(): Promise<void> {
  const projectRoot = findGitRoot(process.cwd());
  await fs.rm(dataDir(projectRoot), { recursive: true, force: true });
  console.log("Deleted local Learning Moments data (.learning-moments/).");
}
