// @ts-check
import fs from "node:fs/promises";
import { EVENT_CLASSES } from "./event-registry.js";
import { withProjectLock } from "./lock.js";
import { invalidateMigrationCache, parseEvent } from "./log.js";
import { controlPath, ledgerPath, logPath, migrationCompletePath, telemetryPath } from "./paths.js";

/**
 * One-time migration from the unified `moments.jsonl` to the three-class
 * split. Idempotent — does nothing once `.migration-complete` exists.
 *
 * Strategy: write each class to a `.staging` sibling, then rename atomically
 * over the destination. Telemetry has its own file (`telemetry.jsonl`),
 * distinct from the legacy unified log, so migration never overwrites its
 * own source. The marker is written before the legacy log is unlinked;
 * until the marker appears the legacy file stays intact, so a crash at any
 * point leaves a clean, fully retryable state. Until the marker exists,
 * every reader and writer continues to use the unified file.
 *
 * Takes the `moments-jsonl` lock — the same lock `appendEvent`, control
 * pruning, and telemetry truncation use — so a hook can't append to the
 * legacy file while migration is partitioning it (which would silently
 * drop the appended row when the rename happens).
 *
 * @param {string} projectRoot
 * @returns {Promise<{migrated: boolean, ledger: number, control: number, telemetry: number}>}
 */
export async function migrateLegacyLog(projectRoot) {
  return withProjectLock(projectRoot, "moments-jsonl", async () => {
    try {
      await fs.access(migrationCompletePath(projectRoot));
      return { migrated: false, ledger: 0, control: 0, telemetry: 0 };
    } catch {
      // Marker missing — proceed.
    }

    /** @type {string | null} */
    let raw = null;
    try {
      raw = await fs.readFile(logPath(projectRoot), "utf8");
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? /** @type {{code?: string}} */ (error).code : undefined;
      if (code !== "ENOENT") throw error;
    }

    /** @type {string[]} */
    const ledgerLines = [];
    /** @type {string[]} */
    const controlLines = [];
    /** @type {string[]} */
    const telemetryLines = [];

    if (raw) {
      const lines = raw.split("\n").filter((line) => line.trim().length > 0);
      lines.forEach((line, index) => {
        const event = parseEvent(JSON.parse(line), `legacy[${index}]`);
        const klass = EVENT_CLASSES[event.type];
        const out = `${line}\n`;
        if (klass === "ledger") ledgerLines.push(out);
        else if (klass === "control") controlLines.push(out);
        else telemetryLines.push(out);
      });
    }

    const ledgerStaging = `${ledgerPath(projectRoot)}.staging`;
    const controlStaging = `${controlPath(projectRoot)}.staging`;
    const telemetryStaging = `${telemetryPath(projectRoot)}.staging`;

    // Clean up debris from any prior aborted run.
    for (const stale of [ledgerStaging, controlStaging, telemetryStaging]) {
      try {
        await fs.unlink(stale);
      } catch {
        // not present — fine
      }
    }

    await fs.writeFile(ledgerStaging, ledgerLines.join(""));
    await fs.writeFile(controlStaging, controlLines.join(""));
    await fs.writeFile(telemetryStaging, telemetryLines.join(""));

    await fs.rename(ledgerStaging, ledgerPath(projectRoot));
    await fs.rename(controlStaging, controlPath(projectRoot));
    await fs.rename(telemetryStaging, telemetryPath(projectRoot));

    const marker = {
      migrated_at: new Date().toISOString(),
      counts: {
        ledger: ledgerLines.length,
        control: controlLines.length,
        telemetry: telemetryLines.length
      },
      source_total: ledgerLines.length + controlLines.length + telemetryLines.length
    };
    await fs.writeFile(migrationCompletePath(projectRoot), `${JSON.stringify(marker, null, 2)}\n`);

    // The legacy unified log is now fully partitioned and the marker is
    // durable, so nothing reads it anymore. Remove it. A crash before this
    // point leaves it intact for a clean retry; a crash after is a no-op
    // (the marker already short-circuits re-migration).
    try {
      await fs.unlink(logPath(projectRoot));
    } catch {
      // already gone (no legacy log, or removed by a prior run) — fine
    }

    // Invalidate the per-process cache so subsequent reads/writes pick up
    // the marker. Matters for tests and for the `init` command, which
    // typically writes events before exiting.
    invalidateMigrationCache();

    return {
      migrated: true,
      ledger: ledgerLines.length,
      control: controlLines.length,
      telemetry: telemetryLines.length
    };
  });
}
