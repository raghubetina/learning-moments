import { appendEvent } from "../../core/log.js";
import { snapshot } from "../../core/git.js";
import { commonHookInputSchema } from "../../types/hooks.js";

export async function sessionStartHook(input: unknown): Promise<void> {
  if (process.env.LEARNING_MOMENTS_INTERNAL === "1") {
    return;
  }
  const startedAt = Date.now();
  const parsed = commonHookInputSchema.parse(input);
  const snap = snapshot(parsed.cwd);
  await appendEvent(snap.root, {
    type: "session_baseline_created",
    session_id: parsed.session_id,
    transcript_path: parsed.transcript_path,
    cwd: parsed.cwd,
    snapshot: snap
  });
  await appendEvent(snap.root, {
    type: "hook_completed",
    hook_event_name: parsed.hook_event_name,
    session_id: parsed.session_id,
    transcript_path: parsed.transcript_path,
    cwd: parsed.cwd,
    duration_ms: Date.now() - startedAt,
    outcome: "session_baseline_created"
  });
}
