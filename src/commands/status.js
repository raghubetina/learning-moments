import { requireProject } from "../core/project.js";
import { loadConfig } from "../core/config.js";
import { readEvents } from "../core/log.js";

export async function statusCommand() {
  const { dataRoot: projectRoot } = await requireProject();
  const config = await loadConfig(projectRoot);
  const events = await readEvents(projectRoot);
  const answered = events.filter((event) => event.type === "answer_received").length;
  const skipped = events.filter((event) => event.type === "skip_recorded").length;
  const lastError = [...events].reverse().find((event) => event.type === "hook_error");

  const mode = config.mode === "observe_only" ? "observe only (logging, no questions)" : config.mode;
  console.log(`Learning Moments: ${config.enabled ? "enabled" : "disabled"}`);
  console.log(`Mode: ${mode}`);
  console.log(`Project paused: ${config.paused.project ? "yes" : "no"}`);
  console.log(`Questions/hour: ${config.frequency.immediate_prompts_per_hour}`);
  console.log(`Minimum minutes between questions: ${config.frequency.minimum_minutes_between_immediate_prompts}`);
  console.log(`Questions answered/skipped: ${answered}/${skipped}`);
  if (lastError) {
    const message = typeof lastError.error_message === "string" ? lastError.error_message : "";
    console.log(`Last hook error: ${lastError.timestamp} ${message}`);
  }
}
