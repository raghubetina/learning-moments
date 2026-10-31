import { immediatePromptBudgetAvailable } from "../../core/budget.js";
import { loadConfig } from "../../core/config.js";
import { resolveProject } from "../../core/project.js";
import { parseStopHookInput } from "../../core/hook-input.js";
import { appendEvent, readLedger } from "../../core/log.js";
import { withProjectLock } from "../../core/lock.js";
import {
  READY_MOMENT_TTL_MS,
  pendingFeedbackMoment,
  pendingInjectedMoment,
  pendingReadyMoment
} from "../../core/state.js";

/**
 * Context that has Claude end the turn with the question. Stop-hook
 * context is also shown in the transcript as hook feedback, so the
 * developer sees the question even if Claude does not repeat it. It is
 * written as facts about the session rather than as commands: text that
 * reads like out-of-band system instructions can trip Claude's
 * prompt-injection defenses.
 */
function questionContext(moment) {
  return [
    "Learning Moments, a learning tool the user installed in this project, picked a comprehension question about the change just made:",
    "",
    `Learning Moment \`${moment.short_id}\`: ${moment.question}`,
    "",
    "The user wants this turn to end with that question asked as written, with its ID, and without an answer or hints. They can reply with an answer, \"I don't know\", or \"skip\"."
  ].join("\n");
}

export async function stopHook(input) {
  if (process.env.LEARNING_MOMENTS_INTERNAL === "1") {
    return null;
  }
  const startedAt = Date.now();
  const parsed = parseStopHookInput(input);
  const project = await resolveProject(parsed.cwd);
  if (!project) return null;
  const projectRoot = project.dataRoot;
  const session = {
    session_id: parsed.session_id,
    transcript_path: parsed.transcript_path,
    cwd: parsed.cwd
  };
  const complete = async (outcome, extra = {}) => {
    await appendEvent(projectRoot, {
      type: "hook_completed",
      hook_event_name: parsed.hook_event_name,
      ...session,
      duration_ms: Date.now() - startedAt,
      outcome,
      ...extra
    });
  };
  const events = await readLedger(projectRoot);
  const observedIds = new Set(
    events
      .filter((event) => ["question_observed", "feedback_observed", "feedback_injection_missed"].includes(event.type))
      .map((event) => event.moment_id)
  );

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
      ...session,
      source: "Stop.last_assistant_message"
    });
    await complete(observed ? "feedback_observed" : "feedback_injection_missed", {
      moment_id: feedback.id,
      short_id: feedback.short_id
    });
    return null;
  }

  const pending = pendingInjectedMoment(events, parsed.session_id);
  if (pending) {
    if (observedIds.has(pending.id)) {
      await complete("question_open", { moment_id: pending.id, short_id: pending.short_id });
      return null;
    }
    const relayed = parsed.last_assistant_message?.includes(pending.short_id) ?? false;
    // A question asked at Stop was already shown as hook feedback, so the
    // developer saw it even when Claude did not repeat it.
    const shown = relayed || pending.delivery === "stop";
    await appendEvent(projectRoot, {
      type: shown ? "question_observed" : "moment_injection_missed",
      moment_id: pending.id,
      short_id: pending.short_id,
      ...session,
      relayed,
      source: "Stop.last_assistant_message"
    });
    await complete(shown ? "question_observed" : "moment_injection_missed", {
      moment_id: pending.id,
      short_id: pending.short_id
    });
    return null;
  }

  // Ask at most once per turn: a Stop that follows Stop-hook context is
  // the end of the continuation that context started.
  const ready = parsed.stop_hook_active ? null : pendingReadyMoment(events, parsed.session_id);
  if (!ready) {
    await complete("no_pending_moment");
    return null;
  }

  const config = await loadConfig(projectRoot);
  if (!config.enabled || config.paused.project || config.paused.sessions[parsed.session_id] || config.mode !== "active") {
    await complete("disabled_or_paused");
    return null;
  }

  const delivered = await withProjectLock(projectRoot, "moment-claim", async () => {
    const lockedLedger = await readLedger(projectRoot);
    const current = pendingReadyMoment(lockedLedger, parsed.session_id);
    if (!current || current.moment_id !== ready.moment_id) return "gone";
    if (Date.now() - new Date(current.timestamp).getTime() > READY_MOMENT_TTL_MS) {
      await appendEvent(projectRoot, {
        type: "moment_expired",
        moment_id: current.moment_id,
        short_id: current.short_id,
        ...session,
        reason: "not_asked_in_time"
      });
      return "expired";
    }
    if (pendingInjectedMoment(lockedLedger, parsed.session_id) || !immediatePromptBudgetAvailable(lockedLedger, config)) {
      return "waiting";
    }
    const { id, type, timestamp, ...fields } = current;
    await appendEvent(projectRoot, {
      ...fields,
      type: "moment_injected",
      ...session,
      delivery: "stop"
    });
    return "injected";
  });

  await complete(delivered === "injected" ? "moment_injected" : `moment_${delivered}`, {
    moment_id: ready.moment_id,
    short_id: ready.short_id
  });
  if (delivered !== "injected") return null;
  return {
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: questionContext(ready)
    }
  };
}
