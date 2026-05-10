import { immediatePromptBudgetAvailable, classifierBudgetAvailable } from "../../core/budget.js";
import { classifyCandidate } from "../../core/classifier.js";
import { loadConfig } from "../../core/config.js";
import { candidateFiles } from "../../core/filter.js";
import { changedSinceBaseline, diffForFiles, snapshot } from "../../core/git.js";
import { createId, shortId } from "../../core/ids.js";
import { appendEvent, readEvents } from "../../core/log.js";
import { redactSecrets } from "../../core/redaction.js";
import { latestSessionBaseline } from "../../core/state.js";
import { withProjectLock } from "../../core/lock.js";
import type { AdditionalContextOutput } from "../../types/hooks.js";
import { postToolBatchInputSchema } from "../../types/hooks.js";

export async function postToolBatchHook(input: unknown): Promise<AdditionalContextOutput | null> {
  if (process.env.LEARNING_MOMENTS_INTERNAL === "1") {
    return null;
  }
  const parsed = postToolBatchInputSchema.parse(input);
  const current = snapshot(parsed.cwd);
  const projectRoot = current.root;
  const config = await loadConfig(projectRoot);
  if (!config.enabled || config.paused.project) {
    return null;
  }

  const events = await readEvents(projectRoot);
  if (!classifierBudgetAvailable(events, config)) {
    return null;
  }

  const baseline = latestSessionBaseline(events, parsed.session_id) ?? {
    root: projectRoot,
    dirtyFiles: [],
    hashes: {}
  };
  const files = candidateFiles(changedSinceBaseline(baseline, current), config).slice(
    0,
    config.context_limits.max_paths
  );
  if (files.length === 0) {
    return null;
  }

  return withProjectLock(projectRoot, "moment-claim", async () => {
    const lockedEvents = await readEvents(projectRoot);
    await appendEvent(projectRoot, {
      type: "classifier_called",
      session_id: parsed.session_id,
      transcript_path: parsed.transcript_path,
      cwd: parsed.cwd
    });

    const diff = redactSecrets(diffForFiles(projectRoot, files, config.context_limits.max_diff_chars));
    const classification = await classifyCandidate(projectRoot, config, { files, diff: diff.text });
    if (!classification) {
      await appendEvent(projectRoot, {
        type: "classifier_failed_open",
        session_id: parsed.session_id,
        transcript_path: parsed.transcript_path,
        cwd: parsed.cwd,
        files,
        redaction_findings: diff.findings
      });
      return null;
    }
    if (!classification.eligible || classification.delivery === "discard") {
      await appendEvent(projectRoot, {
        type: "classifier_declined",
        session_id: parsed.session_id,
        transcript_path: parsed.transcript_path,
        cwd: parsed.cwd,
        files,
        reason: classification.reason,
        redaction_findings: diff.findings
      });
      return null;
    }

    const momentId = createId("moment");
    const displayId = shortId(momentId);
    const baseEvent = {
      moment_id: momentId,
      short_id: displayId,
      session_id: parsed.session_id,
      transcript_path: parsed.transcript_path,
      cwd: parsed.cwd,
      files,
      question: classification.question,
      expected_answer_outline: classification.expected_answer_outline,
      classifier_reason: classification.reason,
      redaction_findings: diff.findings
    };

    await appendEvent(projectRoot, {
      type: "moment_created",
      ...baseEvent,
      moment_type: classification.moment_type,
      learning_value: classification.learning_value,
      flow_cost: classification.flow_cost
    });

    const canInject =
      config.mode === "active" &&
      classification.delivery === "active" &&
      immediatePromptBudgetAvailable(lockedEvents, config);

    if (!canInject) {
      await appendEvent(projectRoot, {
        type: "moment_silenced",
        ...baseEvent,
        reason: config.mode === "observe_only" ? "observe_only" : "budget_or_delivery"
      });
      return null;
    }

    await appendEvent(projectRoot, {
      type: "moment_injected",
      ...baseEvent
    });

    return {
      hookSpecificOutput: {
        hookEventName: "PostToolBatch",
        additionalContext: [
          "Learning Moments selected an ask-now checkpoint.",
          "",
          "Ask the user this question before explaining the change further:",
          "",
          `Learning Moment \`${displayId}\``,
          classification.question,
          "",
          "Wait for the user's answer before giving any explanation. Include the marker in the question."
        ].join("\n")
      }
    };
  });
}
