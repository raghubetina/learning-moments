import fs from "node:fs/promises";
import { findGitRoot } from "../core/git.js";
import { withProjectLock } from "../core/lock.js";
import { dataDir, migrationCompletePath, telemetryPath } from "../core/paths.js";

/**
 * Truncate the telemetry log (Class C) without touching the durable ledger
 * or the hot-path control file. Refuses if the project hasn't been migrated
 * yet — pre-migration telemetry still lives mixed into the unified log, so
 * there is no standalone telemetry file to truncate and we must not touch
 * the unified log (it holds ledger rows too).
 *
 * Takes the `moments-jsonl` lock so the truncate serializes against any
 * in-flight `appendEvent` calls.
 *
 * @param {string} projectRoot
 */
async function truncateTelemetry(projectRoot) {
  try {
    await fs.access(migrationCompletePath(projectRoot));
  } catch {
    console.error(
      "delete-data --logs-only requires the log split to be active. Run `learning-moments init` first."
    );
    process.exitCode = 1;
    return;
  }
  await withProjectLock(projectRoot, "moments-jsonl", async () => {
    await fs.writeFile(telemetryPath(projectRoot), "");
  });
  console.log("Truncated telemetry log (telemetry.jsonl). Ledger and control logs untouched.");
}

/**
 * @param {{ logsOnly?: boolean }} [options]
 */
export async function deleteDataCommand(options = {}) {
  const projectRoot = findGitRoot(process.cwd());
  if (options.logsOnly) {
    await truncateTelemetry(projectRoot);
    return;
  }
  await fs.rm(dataDir(projectRoot), { recursive: true, force: true });
  console.log("Deleted local Learning Moments data (.learning-moments/).");
}
