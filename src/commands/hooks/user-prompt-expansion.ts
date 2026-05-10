import { findGitRoot } from "../../core/git.js";
import { appendEvent } from "../../core/log.js";
import { commonHookInputSchema } from "../../types/hooks.js";

export async function userPromptExpansionHook(input: unknown): Promise<void> {
  if (process.env.LEARNING_MOMENTS_INTERNAL === "1") {
    return;
  }
  const parsed = commonHookInputSchema.parse(input);
  const projectRoot = findGitRoot(parsed.cwd);
  await appendEvent(projectRoot, {
    type: "slash_command_observed",
    session_id: parsed.session_id,
    transcript_path: parsed.transcript_path,
    cwd: parsed.cwd,
    hook_event_name: parsed.hook_event_name
  });
}
