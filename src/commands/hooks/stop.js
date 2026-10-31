import { immediatePromptBudgetAvailable } from "../../core/budget.js";
import { loadConfig } from "../../core/config.js";
import { resolveProject } from "../../core/project.js";
import { parseStopHookInput } from "../../core/hook-input.js";
import { appendEvent, readLedger } from "../../core/log.js";
import { createId, shortId } from "../../core/ids.js";
import { withProjectLock } from "../../core/lock.js";
import { dueRecalls, recallQuestion, recallsAskedInSession } from "../../core/recall.js";
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
    const shown = relayed || pending.delivery === "stop" || pending.delivery === "band";
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
  if (parsed.stop_hook_active) {
    await complete("no_pending_moment");
    return null;
  }
  const ready = pendingReadyMoment(events, parsed.session_id);
  const recallLimitReached = (limit) => limit === 0 || recallsAskedInSession(events, parsed.session_id) >= limit;
  if (!ready && dueRecalls(events, parsed.session_id).length === 0) {
    await complete("no_pending_moment");
    return null;
  }

  const config = await loadConfig(projectRoot);
  if (!config.enabled || config.paused.project || config.paused.sessions[parsed.session_id] || config.mode !== "active") {
    await complete("disabled_or_paused");
    return null;
  }
  if (!ready && recallLimitReached(config.frequency.session_start_recall_limit)) {
    await complete("no_pending_moment");
    return null;
  }

  // With the plugin's experimental question band on, the band shows the
  // question and takes the answer, so it never enters Claude's context.
  const band = process.env.CLAUDE_PLUGIN_OPTION_QUESTION_BAND === "true";
  const delivery = band ? "band" : "stop";
  const delivered = await withProjectLock(projectRoot, "moment-claim", async () => {
    const lockedLedger = await readLedger(projectRoot);
    if (pendingInjectedMoment(lockedLedger, parsed.session_id) || !immediatePromptBudgetAvailable(lockedLedger, config)) {
      return { status: "waiting" };
    }
    const current = pendingReadyMoment(lockedLedger, parsed.session_id);
    if (current) {
      if (Date.now() - new Date(current.timestamp).getTime() > READY_MOMENT_TTL_MS) {
        await appendEvent(projectRoot, {
          type: "moment_expired",
          moment_id: current.moment_id,
          short_id: current.short_id,
          ...session,
          reason: "not_asked_in_time"
        });
        return { status: "expired" };
      }
      const { id, type, timestamp, ...fields } = current;
      await appendEvent(projectRoot, { ...fields, type: "moment_injected", ...session, delivery });
      return { status: "injected", moment: { short_id: String(current.short_id), question: String(current.question) } };
    }

    // No new question is waiting: ask about an earlier one instead, once
    // its spacing interval has passed.
    const [due] = recallLimitReached(config.frequency.session_start_recall_limit) ? [] : dueRecalls(lockedLedger, parsed.session_id);
    if (!due) return { status: "gone" };
    const momentId = createId("moment");
    const question = recallQuestion(due.original);
    const recall = {
      type: "moment_injected",
      moment_id: momentId,
      short_id: shortId(momentId),
      ...session,
      recall_of: due.original.moment_id,
      recall_stage: due.stage,
      files: due.original.files,
      question,
      expected_answer_outline: due.original.expected_answer_outline,
      context_excerpt: due.original.context_excerpt,
      delivery
    };
    await appendEvent(projectRoot, recall);
    return { status: "injected", moment: { short_id: recall.short_id, question } };
  });

  const outcomeIds = delivered.moment ? { short_id: delivered.moment.short_id } : {};
  if (delivered.status === "injected" && band) {
    // The experimental question band shows it; Claude never sees it.
    await complete("moment_injected_band", outcomeIds);
    return null;
  }
  await complete(delivered.status === "injected" ? "moment_injected" : `moment_${delivered.status}`, outcomeIds);
  if (delivered.status !== "injected" || !delivered.moment) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: questionContext(delivered.moment)
    }
  };
}
