import { loadConfig } from "../../core/config.js";
import { findGitRoot, snapshot } from "../../core/git.js";
import { parseCommonHookInput } from "../../core/hook-input.js";
import { appendEvent } from "../../core/log.js";

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

  const snap = snapshot(parsed.cwd, config);
  await appendEvent(projectRoot, {
    type: "session_baseline_created",
    session_id: parsed.session_id,
    transcript_path: parsed.transcript_path,
    cwd: parsed.cwd,
    snapshot: snap
  });
  await complete("session_baseline_created");
}
