import { requireProject } from "../core/project.js";
import { loadConfig } from "../core/config.js";
import { readEvents } from "../core/log.js";
import { pendingInjectedMoment } from "../core/state.js";

function ago(timestamp) {
  const minutes = Math.round((Date.now() - new Date(timestamp).getTime()) / 60000);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

export async function statusCommand() {
  const { dataRoot: projectRoot } = await requireProject();
  const config = await loadConfig(projectRoot);
  const events = await readEvents(projectRoot);
  const count = (type) => events.filter((event) => event.type === type).length;
  const lastError = [...events].reverse().find((event) => event.type === "hook_error");
  const lastAsked = [...events].reverse().find((event) => event.type === "moment_injected");
  const open = lastAsked && typeof lastAsked.session_id === "string" ? pendingInjectedMoment(events, lastAsked.session_id) : null;

  const mode = config.mode === "observe_only" ? "observe only (logging, no questions)" : config.mode;
  console.log(`Learning Moments: ${config.enabled ? "enabled" : "disabled"}`);
  console.log(`Mode: ${mode}`);
  console.log(`Project paused: ${config.paused.project ? "yes" : "no"}`);
  console.log(
    `At most ${config.frequency.immediate_prompts_per_hour} question(s) per hour, ${config.frequency.minimum_minutes_between_immediate_prompts} minutes apart`
  );
  console.log(
    `Questions asked/answered/skipped: ${count("moment_injected")}/${count("answer_received")}/${count("skip_recorded")}`
  );
  if (lastAsked) {
    console.log(`Last question: ${lastAsked.short_id}, ${ago(lastAsked.timestamp)}${open ? " (still open)" : ""}`);
  }
  if (lastError) {
    const message = typeof lastError.error_message === "string" ? lastError.error_message : "";
    console.log(`Last hook error: ${lastError.timestamp} ${message}`);
  }
}
