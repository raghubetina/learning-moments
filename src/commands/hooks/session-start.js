import fs from "node:fs/promises";
import { loadConfig } from "../../core/config.js";
import { findGitRoot, workspaceContext } from "../../core/git.js";
import { parseCommonHookInput } from "../../core/hook-input.js";
import { appendEvent, parseEvent } from "../../core/log.js";
import { controlPath, migrationCompletePath } from "../../core/paths.js";

const CONTROL_RETENTION_MS = 60 * 60 * 1000;

/**
 * Drop rows from `control.jsonl` older than the trailing-1h window that
 * `classifierBudgetAvailable` and the PostToolBatch dedupe check use.
 * Best-effort: a failure here must never block a session from starting.
 *
 * @param {string} projectRoot
 */
async function pruneControlLog(projectRoot) {
  try {
    await fs.access(migrationCompletePath(projectRoot));
  } catch {
    return;
  }
  const target = controlPath(projectRoot);
  let raw;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return;
    throw error;
  }
  const cutoff = Date.now() - CONTROL_RETENTION_MS;
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
    if (Number.isFinite(ts) && ts >= cutoff) {
      kept.push(line);
    }
  }
  const staging = `${target}.staging`;
  await fs.writeFile(staging, kept.length > 0 ? `${kept.join("\n")}\n` : "");
  await fs.rename(staging, target);
}

export async function sessionStartHook(input) {
  if (process.env.LEARNING_MOMENTS_INTERNAL === "1") {
    return;
  }
  const startedAt = Date.now();
  const parsed = parseCommonHookInput(input);
  // Resolve the project root cheaply (one git rev-parse) so we can short-
  // circuit on pause/disabled before taking a working-tree snapshot. The
  // snapshot hashes every dirty and untracked file, which we don't want to
  // pay for when the user has disabled the tool for this session or project.
  const projectRoot = findGitRoot(parsed.cwd);
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

  const ctx = workspaceContext(parsed.cwd, config);
  await appendEvent(projectRoot, {
    type: "session_baseline_created",
    session_id: parsed.session_id,
    transcript_path: parsed.transcript_path,
    cwd: parsed.cwd,
    snapshot: ctx.toBaseline()
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
