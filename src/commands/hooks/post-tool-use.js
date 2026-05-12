import { appendEvent } from "../../core/log.js";
import { findGitRoot } from "../../core/git.js";
import { parseToolHookInput } from "../../core/hook-input.js";

function toolFilePath(toolInput) {
  if (typeof toolInput !== "object" || toolInput === null || !("file_path" in toolInput)) {
    return null;
  }
  const value = toolInput.file_path;
  return typeof value === "string" ? value : null;
}

export async function postToolUseHook(input) {
  if (process.env.LEARNING_MOMENTS_INTERNAL === "1") {
    return;
  }
  const startedAt = Date.now();
  const parsed = parseToolHookInput(input);
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
  await appendEvent(projectRoot, {
    type: "hook_completed",
    session_id: parsed.session_id,
    transcript_path: parsed.transcript_path,
    cwd: parsed.cwd,
    hook_event_name: parsed.hook_event_name,
    duration_ms: Date.now() - startedAt,
    outcome: filePath ? "change_detected" : "no_file_path"
  });
}
