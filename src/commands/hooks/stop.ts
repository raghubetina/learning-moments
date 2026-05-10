import { findGitRoot } from "../../core/git.js";
import { appendEvent, readEvents } from "../../core/log.js";
import { pendingFeedbackMoment, pendingInjectedMoment } from "../../core/state.js";
import { stopHookInputSchema } from "../../types/hooks.js";

export async function stopHook(input: unknown): Promise<void> {
  if (process.env.LEARNING_MOMENTS_INTERNAL === "1") {
    return;
  }
  const startedAt = Date.now();
  const parsed = stopHookInputSchema.parse(input);
  const projectRoot = findGitRoot(parsed.cwd);
  const events = await readEvents(projectRoot);
  const feedback = pendingFeedbackMoment(events, parsed.session_id);
  if (feedback) {
    const observed =
      parsed.last_assistant_message?.includes(feedback.short_id) ||
      (feedback.feedback ? parsed.last_assistant_message?.includes(feedback.feedback) : false) ||
      false;
    await appendEvent(projectRoot, {
      type: observed ? "feedback_observed" : "feedback_injection_missed",
      moment_id: feedback.id,
      short_id: feedback.short_id,
      session_id: parsed.session_id,
      transcript_path: parsed.transcript_path,
      cwd: parsed.cwd,
      source: "Stop.last_assistant_message"
    });
    await appendEvent(projectRoot, {
      type: "hook_completed",
      hook_event_name: parsed.hook_event_name,
      session_id: parsed.session_id,
      transcript_path: parsed.transcript_path,
      cwd: parsed.cwd,
      duration_ms: Date.now() - startedAt,
      outcome: observed ? "feedback_observed" : "feedback_injection_missed",
      moment_id: feedback.id,
      short_id: feedback.short_id
    });
    return;
  }

  const pending = pendingInjectedMoment(events, parsed.session_id);
  if (!pending) {
    await appendEvent(projectRoot, {
      type: "hook_completed",
      hook_event_name: parsed.hook_event_name,
      session_id: parsed.session_id,
      transcript_path: parsed.transcript_path,
      cwd: parsed.cwd,
      duration_ms: Date.now() - startedAt,
      outcome: "no_pending_moment"
    });
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
  await appendEvent(projectRoot, {
    type: "hook_completed",
    hook_event_name: parsed.hook_event_name,
    session_id: parsed.session_id,
    transcript_path: parsed.transcript_path,
    cwd: parsed.cwd,
    duration_ms: Date.now() - startedAt,
    outcome: asked ? "question_observed" : "moment_injection_missed",
    moment_id: pending.id,
    short_id: pending.short_id
  });
}
