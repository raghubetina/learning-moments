import type { GitSnapshot } from "./git.js";
import { shortId } from "./ids.js";
import type { EventRecord } from "./log.js";

export interface MomentState {
  id: string;
  short_id: string;
  question: string;
  expected_answer_outline?: string;
  files: string[];
}

export function latestSessionBaseline(events: EventRecord[], sessionId: string): GitSnapshot | null {
  const baseline = [...events].reverse().find(
    (event) => event.type === "session_baseline_created" && event.session_id === sessionId
  );
  if (!baseline || typeof baseline.snapshot !== "object" || baseline.snapshot === null) {
    return null;
  }
  return baseline.snapshot as GitSnapshot;
}

export function pendingInjectedMoment(events: EventRecord[], sessionId: string): MomentState | null {
  const closed = new Set<string>();
  for (const event of events) {
    const momentId = typeof event.moment_id === "string" ? event.moment_id : undefined;
    if (
      momentId &&
      ["answer_received", "skip_recorded", "grade_created"].includes(event.type)
    ) {
      closed.add(momentId);
    }
  }

  const injected = [...events].reverse().find(
    (event) =>
      event.type === "moment_injected" &&
      event.session_id === sessionId &&
      typeof event.moment_id === "string" &&
      !closed.has(event.moment_id)
  );
  if (!injected || typeof injected.moment_id !== "string") {
    return null;
  }

  return {
    id: injected.moment_id,
    short_id: typeof injected.short_id === "string" ? injected.short_id : shortId(injected.moment_id),
    question: typeof injected.question === "string" ? injected.question : "",
    expected_answer_outline:
      typeof injected.expected_answer_outline === "string" ? injected.expected_answer_outline : undefined,
    files: Array.isArray(injected.files) ? injected.files.map(String) : []
  };
}
