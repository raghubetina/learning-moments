import { loadConfig } from "../core/config.js";
import { findGitRoot } from "../core/git.js";
import { readEvents } from "../core/log.js";

export async function statusCommand(): Promise<void> {
  const projectRoot = findGitRoot(process.cwd());
  const config = await loadConfig(projectRoot);
  const events = await readEvents(projectRoot);
  const pendingRecalls = events.filter((event) => event.type === "recall_scheduled").length;
  const answered = events.filter((event) => event.type === "answer_received").length;
  const skipped = events.filter((event) => event.type === "skip_recorded").length;
  const lastError = [...events].reverse().find((event) => event.type === "hook_error");

  console.log(`Learning Moments: ${config.enabled ? "enabled" : "disabled"}`);
  console.log(`Mode: ${config.mode}`);
  console.log(`Project paused: ${config.paused.project ? "yes" : "no"}`);
  console.log(`Questions/hour: ${config.frequency.immediate_prompts_per_hour}`);
  console.log(`Minimum minutes between questions: ${config.frequency.minimum_minutes_between_immediate_prompts}`);
  console.log(`Scheduled recall questions: ${pendingRecalls}`);
  console.log(`Answered/skipped: ${answered}/${skipped}`);
  if (lastError) {
    console.log(`Last hook error: ${lastError.timestamp} ${String(lastError.reason ?? lastError.message ?? "")}`);
  }
}
