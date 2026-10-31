import fs from "node:fs/promises";
import { loadConfig } from "../../core/config.js";
import { workspaceContext } from "../../core/git.js";
import { parseCommonHookInput } from "../../core/hook-input.js";
import { appendEvent, parseEvent, readControl } from "../../core/log.js";
import { withProjectLock } from "../../core/lock.js";
import { controlPath, migrationCompletePath } from "../../core/paths.js";
import { resolveProject } from "../../core/project.js";
import { latestSessionBaseline } from "../../core/state.js";

const CONTROL_HOT_RETENTION_MS = 60 * 60 * 1000;
const SESSION_BASELINE_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Drop rows from `control.jsonl` once they pass their retention window.
 * Hot-path control events (classifier_called, candidate_already_seen) only
 * matter for the trailing 1h that `classifierBudgetAvailable` and the
 * PostToolBatch dedupe check inspect. Session baselines need a longer
 * window so that hot hooks can find the latest baseline for a session that
 * spans hours. Best-effort: a failure here must never block a session
 * from starting.
 *
 * Takes the `moments-jsonl` lock so the rewrite serializes against
 * concurrent `appendEvent` calls (and any other future control-file
 * mutator).
 *
 * @param {string} projectRoot
 */
async function pruneControlLog(projectRoot) {
  try {
    await fs.access(migrationCompletePath(projectRoot));
  } catch {
    return;
  }
  await withProjectLock(projectRoot, "moments-jsonl", async () => {
    const target = controlPath(projectRoot);
    let raw;
    try {
      raw = await fs.readFile(target, "utf8");
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return;
      throw error;
    }
    const now = Date.now();
    const hotCutoff = now - CONTROL_HOT_RETENTION_MS;
    const baselineCutoff = now - SESSION_BASELINE_RETENTION_MS;
    const kept = [];
    for (const [index, line] of raw.split("\n").entries()) {
      if (line.trim().length === 0) continue;
      let event;
      try {
        event = parseEvent(JSON.parse(line), `control[${index}]`);
      } catch {
        // Malformed line: keep it so the user notices, but it won't be
        // referenced by hot paths anyway.
        kept.push(line);
        continue;
      }
      const ts = new Date(event.timestamp).getTime();
      if (!Number.isFinite(ts)) {
        kept.push(line);
        continue;
      }
      // Reviewed versions in classifier_called must outlive the hour the
      // budget looks at, or a long session would re-review old changes.
      const longLived = event.type === "session_baseline_created" || event.type === "classifier_called";
      const cutoff = longLived ? baselineCutoff : hotCutoff;
      if (ts >= cutoff) {
        kept.push(line);
      }
    }
    const staging = `${target}.staging`;
    await fs.writeFile(staging, kept.length > 0 ? `${kept.join("\n")}\n` : "");
    await fs.rename(staging, target);
  });
}

export async function sessionStartHook(input) {
  if (process.env.LEARNING_MOMENTS_INTERNAL === "1") {
    return;
  }
  const startedAt = Date.now();
  const parsed = parseCommonHookInput(input);
  // Resolve the project cheaply so we can short-circuit on pause/disabled
  // before taking a working-tree snapshot. The snapshot hashes every dirty
  // and untracked file, which we don't want to pay for when the user has
  // disabled the tool for this session or project.
  const project = await resolveProject(parsed.cwd);
  if (!project) return;
  const { dataRoot: projectRoot, workRoot } = project;
  const complete = async (outcome) => {
    await appendEvent(projectRoot, {
      type: "hook_completed",
      hook_event_name: parsed.hook_event_name,
      session_id: parsed.session_id,
      transcript_path: parsed.transcript_path,
      cwd: parsed.cwd,
      duration_ms: Date.now() - startedAt,
      outcome
    });
  };

  const config = await loadConfig(projectRoot);
  const sessionPaused = !!config.paused.sessions[parsed.session_id];
  if (!config.enabled || config.paused.project || sessionPaused) {
    await complete("disabled_or_paused");
    return;
  }

  // Resume, compaction, and /clear fire SessionStart again for a session
  // that may already have a baseline. Replacing it would fold every change
  // Claude made before that point into the new baseline, so those changes
  // could never be asked about.
  const existing = latestSessionBaseline(await readControl(projectRoot), parsed.session_id);
  if (existing && existing.root === workRoot) {
    await complete("session_baseline_kept");
    return;
  }

  const ctx = workspaceContext(workRoot, config);
  await appendEvent(projectRoot, {
    type: "session_baseline_created",
    session_id: parsed.session_id,
    transcript_path: parsed.transcript_path,
    cwd: parsed.cwd,
    source: typeof input.source === "string" ? input.source : undefined,
    // Stored as blobs, so files already dirty now can later be diffed
    // against this version instead of HEAD.
    snapshot: ctx.toBaseline({ write: true })
  });
  // Best-effort pruning of the control log. We deliberately swallow errors:
  // a failure to compact control.jsonl must not interrupt session start.
  try {
    await pruneControlLog(projectRoot);
  } catch {
    // ignored — next session-start will retry
  }
  await complete("session_baseline_created");
}
