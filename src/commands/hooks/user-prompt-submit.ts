import { findGitRoot } from "../../core/git.js";
import { loadConfig } from "../../core/config.js";
import { gradeAnswer } from "../../core/grader.js";
import { appendEvent, readEvents } from "../../core/log.js";
import { pendingInjectedMoment } from "../../core/state.js";
import type { AdditionalContextOutput } from "../../types/hooks.js";
import { userPromptSubmitInputSchema } from "../../types/hooks.js";

function isSkip(prompt: string): boolean {
  return /^(skip|not now|too busy|pass)\b/i.test(prompt.trim());
}

export async function userPromptSubmitHook(input: unknown): Promise<AdditionalContextOutput | null> {
  if (process.env.LEARNING_MOMENTS_INTERNAL === "1") {
    return null;
  }
  const parsed = userPromptSubmitInputSchema.parse(input);
  const projectRoot = findGitRoot(parsed.cwd);
  const config = await loadConfig(projectRoot);
  const events = await readEvents(projectRoot);
  const pending = pendingInjectedMoment(events, parsed.session_id);
  if (!pending) {
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

  const grade = await gradeAnswer(projectRoot, config, {
    question: pending.question,
    expectedAnswerOutline: pending.expected_answer_outline,
    answer: parsed.prompt,
    files: pending.files
  });

  if (!grade) {
    await appendEvent(projectRoot, {
      type: "grader_failed_open",
      moment_id: pending.id,
      short_id: pending.short_id,
      session_id: parsed.session_id,
      transcript_path: parsed.transcript_path,
      cwd: parsed.cwd
    });
    return null;
  }

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
    cwd: parsed.cwd
  });

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
