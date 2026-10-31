import { loadConfig } from "../../core/config.js";
import { runInBackground } from "../../core/background.js";
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
  // A question shown in the question band is answered there; prompts to
  // Claude are left alone.
  if (pending.delivery === "band") {
    await complete("band_question_open", { moment_id: pending.id, short_id: pending.short_id });
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

  // Claude already has the change in context, so it gives the feedback
  // now, with no model call in the way. Structured grading for the record
  // runs in the background.
  const spawnError = await runInBackground(["grade", pending.id, "--project", projectRoot]);
  if (spawnError) {
    await appendEvent(projectRoot, {
      type: "grader_failed_open",
      ...momentFields,
      failure_reason: "spawn_error"
    });
  }
  await appendEvent(projectRoot, {
    type: "feedback_injected",
    ...momentFields,
    files: pending.files,
    feedback_kind: "agent"
  });
  await complete("feedback_injected", { moment_id: pending.id, short_id: pending.short_id });

  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: [
        `The user's message is likely their reply to Learning Moment \`${pending.short_id}\`.`,
        "",
        "Question:",
        pending.question,
        "",
        // A recall is answered in a later session, where Claude may never
        // have seen the change; the stored redacted excerpt stands in for it.
        ...(pending.recall_of
          ? [
              "This is a delayed recall question about an earlier change, which may no longer be in Claude's context. The change as it looked then (redacted):",
              pending.context_excerpt ? `\`\`\`diff\n${pending.context_excerpt}\n\`\`\`` : "(no code was stored for it)",
              "Feedback on a recall answer rewards remembered purpose and risk over exact names.",
              ""
            ]
          : []),
        // The hidden answer outline stays out of the conversation: this
        // message may not be an answer at all, and Claude has the code to
        // judge against. The background grader uses the outline.
        `If the message answers the question, the user wants brief feedback first, starting with "Learning Moment ${pending.short_id}:": one or two sentences, judged against the code, on what is right and what is missing, with no score. Then any other request in the message gets handled as usual. If the message is not an answer to the question, the Learning Moment can be ignored.`
      ].join("\n")
    }
  };
}
