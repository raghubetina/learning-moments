import { findGitRoot } from "../../core/git.js";
import { loadConfig } from "../../core/config.js";
import { gradeAnswer } from "../../core/grader.js";
import { parseUserPromptSubmitInput } from "../../core/hook-input.js";
import { appendEvent, readEvents } from "../../core/log.js";
import { pendingInjectedMoment } from "../../core/state.js";

function isSkip(prompt) {
  return /^(skip|not now|too busy|pass)\b/i.test(prompt.trim());
}

export async function userPromptSubmitHook(input) {
  if (process.env.LEARNING_MOMENTS_INTERNAL === "1") {
    return null;
  }
  const startedAt = Date.now();
  const parsed = parseUserPromptSubmitInput(input);
  const projectRoot = findGitRoot(parsed.cwd);
  const complete = async (outcome, extra = {}) => {
    await appendEvent(projectRoot, {
      type: "hook_completed",
      hook_event_name: parsed.hook_event_name,
      session_id: parsed.session_id,
      transcript_path: parsed.transcript_path,
      cwd: parsed.cwd,
      duration_ms: Date.now() - startedAt,
      outcome,
      ...extra
    });
  };

  const config = await loadConfig(projectRoot);
  const sessionPaused = !!config.paused.sessions[parsed.session_id];
  if (!config.enabled || config.paused.project || sessionPaused) {
    await complete("disabled_or_paused");
    return null;
  }
  const events = await readEvents(projectRoot);
  const pending = pendingInjectedMoment(events, parsed.session_id);
  if (!pending) {
    await complete("no_pending_moment");
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
    await complete("skip_recorded", { moment_id: pending.id, short_id: pending.short_id });
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

  const gradeResult = await gradeAnswer(projectRoot, config, {
    question: pending.question,
    expectedAnswerOutline: pending.expected_answer_outline,
    answer: parsed.prompt,
    files: pending.files
  });

  if (!gradeResult) {
    await appendEvent(projectRoot, {
      type: "grader_failed_open",
      moment_id: pending.id,
      short_id: pending.short_id,
      session_id: parsed.session_id,
      transcript_path: parsed.transcript_path,
      cwd: parsed.cwd
    });
    await complete("grader_failed_open", { moment_id: pending.id, short_id: pending.short_id });
    return null;
  }

  const grade = gradeResult.grade;
  await appendEvent(projectRoot, {
    type: "grader_completed",
    moment_id: pending.id,
    short_id: pending.short_id,
    session_id: parsed.session_id,
    transcript_path: parsed.transcript_path,
    cwd: parsed.cwd,
    metrics: gradeResult.metrics
  });

  await appendEvent(projectRoot, {
    type: "grade_created",
    moment_id: pending.id,
    short_id: pending.short_id,
    session_id: parsed.session_id,
    transcript_path: parsed.transcript_path,
    cwd: parsed.cwd,
    grade: grade.grade,
    label: grade.label,
    feedback: grade.feedback,
    grader_reason: grade.reason,
    confidence: grade.confidence
  });

  await appendEvent(projectRoot, {
    type: "feedback_injected",
    moment_id: pending.id,
    short_id: pending.short_id,
    session_id: parsed.session_id,
    transcript_path: parsed.transcript_path,
    cwd: parsed.cwd,
    files: pending.files,
    feedback: grade.feedback
  });
  await complete("feedback_injected", { moment_id: pending.id, short_id: pending.short_id });

  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: [
        `The user just answered Learning Moment \`${pending.short_id}\`.`,
        "",
        "Question:",
        pending.question,
        "",
        "Give the user this brief feedback:",
        grade.feedback,
        "",
        `Internal grade: ${grade.grade}/3 (${grade.label}, confidence ${grade.confidence}).`,
        "Do not mention the numeric grade unless the user asks."
      ].join("\n")
    }
  };
}
