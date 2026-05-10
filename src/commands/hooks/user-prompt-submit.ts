import { findGitRoot } from "../../core/git.js";
import { appendEvent, readEvents } from "../../core/log.js";
import { pendingInjectedMoment } from "../../core/state.js";
import type { AdditionalContextOutput } from "../../types/hooks.js";
import { userPromptSubmitInputSchema } from "../../types/hooks.js";

function isSkip(prompt: string): boolean {
  return /^(skip|not now|too busy|pass)\b/i.test(prompt.trim());
}

export async function userPromptSubmitHook(input: unknown): Promise<AdditionalContextOutput | null> {
  if (process.env.LEARNING_MOMENTS_INTERNAL === "1") {
    return null;
  }
  const parsed = userPromptSubmitInputSchema.parse(input);
  const projectRoot = findGitRoot(parsed.cwd);
  const events = await readEvents(projectRoot);
  const pending = pendingInjectedMoment(events, parsed.session_id);
  if (!pending) {
    return null;
  }

  if (isSkip(parsed.prompt)) {
    await appendEvent(projectRoot, {
      type: "skip_recorded",
      moment_id: pending.id,
      short_id: pending.short_id,
      session_id: parsed.session_id,
      transcript_path: parsed.transcript_path,
      cwd: parsed.cwd,
      reason: parsed.prompt
    });
    return null;
  }

  await appendEvent(projectRoot, {
    type: "answer_received",
    moment_id: pending.id,
    short_id: pending.short_id,
    session_id: parsed.session_id,
    transcript_path: parsed.transcript_path,
    cwd: parsed.cwd,
    answer_text: parsed.prompt,
    source: "UserPromptSubmit"
  });

  await appendEvent(projectRoot, {
    type: "feedback_injected",
    moment_id: pending.id,
    short_id: pending.short_id,
    session_id: parsed.session_id,
    transcript_path: parsed.transcript_path,
    cwd: parsed.cwd
  });

  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: [
        `The user just answered Learning Moment \`${pending.short_id}\`.`,
        "",
        "Question:",
        pending.question,
        "",
        "Expected answer outline:",
        pending.expected_answer_outline ?? "(none recorded)",
        "",
        "Give brief feedback: correct / partially correct / likely incorrect, with one sentence explaining why. Do not over-elaborate unless the user asks."
      ].join("\n")
    }
  };
}
