import { loadConfig } from "../../core/config.js";
import { gradeAnswer } from "../../core/grader.js";
import { resolveProject } from "../../core/project.js";
import { parseUserPromptSubmitInput } from "../../core/hook-input.js";
import { appendEvent, readLedger } from "../../core/log.js";
import { redactSecrets } from "../../core/redaction.js";
import { classifyReply } from "../../core/reply.js";
import { pendingInjectedMoment } from "../../core/state.js";

export async function userPromptSubmitHook(input) {
  if (process.env.LEARNING_MOMENTS_INTERNAL === "1") {
    return null;
  }
  const startedAt = Date.now();
  const parsed = parseUserPromptSubmitInput(input);
  const project = await resolveProject(parsed.cwd);
  if (!project) return null;
  const projectRoot = project.dataRoot;
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
  const events = await readLedger(projectRoot);
  const pending = pendingInjectedMoment(events, parsed.session_id);
  if (!pending) {
    await complete("no_pending_moment");
    return null;
  }

  // Pattern-redact the user's message once. The redacted text is what
  // gets persisted and what travels to the grader; the raw prompt never
  // leaves this scope.
  const redactedAnswer = redactSecrets(parsed.prompt);
  const kind = classifyReply(redactedAnswer.text);
  const momentFields = {
    moment_id: pending.id,
    short_id: pending.short_id,
    session_id: parsed.session_id,
    transcript_path: parsed.transcript_path,
    cwd: parsed.cwd
  };

  // A command or an automatic prompt is not the developer's reply; the
  // question stays open for the next message.
  if (kind === "command" || kind === "automatic") {
    await complete(kind === "command" ? "command_not_an_answer" : "automatic_prompt_not_an_answer", {
      moment_id: pending.id,
      short_id: pending.short_id
    });
    return null;
  }

  if (kind === "pause" || kind === "skip" || kind === "continue") {
    await appendEvent(projectRoot, {
      type: "skip_recorded",
      ...momentFields,
      skip_kind: kind,
      reason: redactedAnswer.text,
      redaction_findings: redactedAnswer.findings
    });
    await complete("skip_recorded", { moment_id: pending.id, short_id: pending.short_id, skip_kind: kind });
    return null;
  }

  await appendEvent(projectRoot, {
    type: "answer_received",
    ...momentFields,
    answer_text: redactedAnswer.text,
    answer_kind: kind,
    redaction_findings: redactedAnswer.findings,
    source: "UserPromptSubmit"
  });

  if (kind === "dont_know") {
    // Saying so is an honest answer, not a wrong one. Nothing to grade;
    // the useful response is the explanation the outline already holds.
    await appendEvent(projectRoot, {
      type: "grade_created",
      ...momentFields,
      grade: 0,
      label: "dont_know",
      source: "rule"
    });
    await appendEvent(projectRoot, {
      type: "feedback_injected",
      ...momentFields,
      files: pending.files,
      feedback_kind: "explanation"
    });
    await complete("feedback_injected", { moment_id: pending.id, short_id: pending.short_id, answer_kind: kind });
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: [
          `The user's message replies to Learning Moment \`${pending.short_id}\` and says they don't know the answer.`,
          "",
          "Question:",
          pending.question,
          "",
          "Reference answer outline, written when the question was chosen:",
          pending.expected_answer_outline ?? "(none recorded)",
          "",
          `A brief explanation of the answer, starting with "Learning Moment ${pending.short_id}:", is what the user is asking for here.`
        ].join("\n")
      }
    };
  }

  const gradeResult = await gradeAnswer(projectRoot, config, {
    question: pending.question,
    expectedAnswerOutline: pending.expected_answer_outline,
    answer: redactedAnswer.text,
    files: pending.files
  });

  if (!gradeResult.ok) {
    await appendEvent(projectRoot, {
      type: "grader_failed_open",
      ...momentFields,
      failure_reason: gradeResult.reason,
      metrics: gradeResult.metrics
    });
    await complete("grader_failed_open", {
      moment_id: pending.id,
      short_id: pending.short_id,
      failure_reason: gradeResult.reason
    });
    return null;
  }

  const grade = gradeResult.value;
  await appendEvent(projectRoot, {
    type: "grader_completed",
    ...momentFields,
    metrics: gradeResult.metrics
  });

  await appendEvent(projectRoot, {
    type: "grade_created",
    ...momentFields,
    grade: grade.grade,
    label: grade.label,
    feedback: grade.feedback,
    grader_reason: grade.reason,
    confidence: grade.confidence
  });

  // The message was something else, such as a new instruction. Feedback
  // on it would read as a scolding; let the conversation carry on.
  if (grade.label === "not_an_answer") {
    await complete("not_an_answer", { moment_id: pending.id, short_id: pending.short_id });
    return null;
  }

  await appendEvent(projectRoot, {
    type: "feedback_injected",
    ...momentFields,
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
