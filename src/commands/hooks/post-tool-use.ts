import { appendEvent } from "../../core/log.js";
import { findGitRoot } from "../../core/git.js";
import { toolHookInputSchema } from "../../types/hooks.js";

function toolFilePath(toolInput: unknown): string | null {
  if (typeof toolInput !== "object" || toolInput === null || !("file_path" in toolInput)) {
    return null;
  }
  const value = (toolInput as { file_path?: unknown }).file_path;
  return typeof value === "string" ? value : null;
}

export async function postToolUseHook(input: unknown): Promise<void> {
  if (process.env.LEARNING_MOMENTS_INTERNAL === "1") {
    return;
  }
  const parsed = toolHookInputSchema.parse(input);
  const projectRoot = findGitRoot(parsed.cwd);
  const filePath = toolFilePath(parsed.tool_input);
  await appendEvent(projectRoot, {
    type: "change_detected",
    session_id: parsed.session_id,
    transcript_path: parsed.transcript_path,
    cwd: parsed.cwd,
    hook_event_name: parsed.hook_event_name,
    tool_name: parsed.tool_name,
    tool_use_id: parsed.tool_use_id,
    files: filePath ? [filePath] : []
  });
}
