import { findGitRoot } from "../../core/git.js";
import { appendEvent, readEvents } from "../../core/log.js";
import { pendingInjectedMoment } from "../../core/state.js";
import { stopHookInputSchema } from "../../types/hooks.js";

export async function stopHook(input: unknown): Promise<void> {
  if (process.env.LEARNING_MOMENTS_INTERNAL === "1") {
    return;
  }
  const parsed = stopHookInputSchema.parse(input);
  const projectRoot = findGitRoot(parsed.cwd);
  const events = await readEvents(projectRoot);
  const pending = pendingInjectedMoment(events, parsed.session_id);
  if (!pending) {
    return;
  }

  const asked = parsed.last_assistant_message?.includes(pending.short_id) ?? false;
  await appendEvent(projectRoot, {
    type: asked ? "question_observed" : "moment_injection_missed",
    moment_id: pending.id,
    short_id: pending.short_id,
    session_id: parsed.session_id,
    transcript_path: parsed.transcript_path,
    cwd: parsed.cwd,
    source: "Stop.last_assistant_message"
  });
}
