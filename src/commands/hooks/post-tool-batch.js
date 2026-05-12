import { immediatePromptBudgetAvailable, classifierBudgetAvailable } from "../../core/budget.js";
import { classifyCandidate } from "../../core/classifier.js";
import { loadConfig } from "../../core/config.js";
import { candidateFingerprint } from "../../core/fingerprint.js";
import { candidateFiles } from "../../core/filter.js";
import { changedSinceBaseline, contextForFiles, findGitRoot, snapshot } from "../../core/git.js";
import { parsePostToolBatchInput } from "../../core/hook-input.js";
import { createId, shortId } from "../../core/ids.js";
import { appendEvent, readEvents } from "../../core/log.js";
import { redactSecrets } from "../../core/redaction.js";
import { latestSessionBaseline } from "../../core/state.js";
import { withProjectLock } from "../../core/lock.js";

export async function postToolBatchHook(input) {
  if (process.env.LEARNING_MOMENTS_INTERNAL === "1") {
    return null;
  }
  const startedAt = Date.now();
  const parsed = parsePostToolBatchInput(input);
  // Resolve the project root cheaply (one git rev-parse) so we can short-
  // circuit on pause/disabled before incurring the expense of a full
  // working-tree snapshot, which hashes every dirty and untracked file.
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
  if (!classifierBudgetAvailable(events, config)) {
    await complete("classifier_budget_exhausted");
    return null;
  }

  // Defer the working-tree snapshot until after every early-return path so
  // that disabled, paused, or budget-exhausted invocations never pay its cost.
  // Pass config so candidates are filtered (via ignore.paths and
  // ignore.extensions) before any file is opened for hashing.
  const current = snapshot(parsed.cwd, config);

  const baseline = latestSessionBaseline(events, parsed.session_id) ?? {
    root: projectRoot,
    head: current.head,
    branch: current.branch,
    dirtyFiles: [],
    hashes: {}
  };
  if (baseline.head !== current.head || baseline.branch !== current.branch) {
    await appendEvent(projectRoot, {
      type: "session_baseline_created",
      session_id: parsed.session_id,
      transcript_path: parsed.transcript_path,
      cwd: parsed.cwd,
      snapshot: current,
      reason: "head_or_branch_changed"
    });
    await complete("baseline_reset_head_or_branch_changed");
    return null;
  }
  const files = candidateFiles(changedSinceBaseline(baseline, current), config).slice(
    0,
    config.context_limits.max_paths
  );
  if (files.length === 0) {
    await complete("no_candidate");
    return null;
  }

  return withProjectLock(projectRoot, "moment-claim", async () => {
    const lockedEvents = await readEvents(projectRoot);
    const diff = redactSecrets(contextForFiles(projectRoot, files, config.context_limits.max_diff_chars));
    const fingerprint = candidateFingerprint(files, diff.text);
    const alreadySeen = lockedEvents.some(
      (event) =>
        event.session_id === parsed.session_id &&
        event.candidate_fingerprint === fingerprint &&
        ["classifier_called", "candidate_already_seen"].includes(event.type)
    );

    if (alreadySeen) {
      await appendEvent(projectRoot, {
        type: "candidate_already_seen",
        session_id: parsed.session_id,
        transcript_path: parsed.transcript_path,
        cwd: parsed.cwd,
        files,
        candidate_fingerprint: fingerprint,
        redaction_findings: diff.findings
      });
      await complete("candidate_already_seen", { candidate_fingerprint: fingerprint });
      return null;
    }

    await appendEvent(projectRoot, {
      type: "classifier_called",
      session_id: parsed.session_id,
      transcript_path: parsed.transcript_path,
      cwd: parsed.cwd,
      files,
      candidate_fingerprint: fingerprint
    });

    const result = await classifyCandidate(projectRoot, config, { files, diff: diff.text });
    if (!result) {
      await appendEvent(projectRoot, {
        type: "classifier_failed_open",
        session_id: parsed.session_id,
        transcript_path: parsed.transcript_path,
        cwd: parsed.cwd,
        files,
        candidate_fingerprint: fingerprint,
        redaction_findings: diff.findings
      });
      await complete("classifier_failed_open", { candidate_fingerprint: fingerprint });
      return null;
    }

    await appendEvent(projectRoot, {
      type: "classifier_completed",
      session_id: parsed.session_id,
      transcript_path: parsed.transcript_path,
      cwd: parsed.cwd,
      files,
      candidate_fingerprint: fingerprint,
      metrics: result.metrics
    });

    const classification = result.classification;
    if (!classification.eligible || classification.delivery === "discard") {
      await appendEvent(projectRoot, {
        type: "classifier_declined",
        session_id: parsed.session_id,
        transcript_path: parsed.transcript_path,
        cwd: parsed.cwd,
        files,
        candidate_fingerprint: fingerprint,
        reason: classification.reason,
        redaction_findings: diff.findings
      });
      await complete("classifier_declined", { candidate_fingerprint: fingerprint });
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
      candidate_fingerprint: fingerprint,
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
      classification.timing === "ask_now" &&
      immediatePromptBudgetAvailable(lockedEvents, config);

    if (!canInject) {
      let reason;
      if (config.mode === "observe_only") reason = "observe_only";
      else if (classification.timing !== "ask_now") reason = "ask_later";
      else reason = "budget_or_delivery";
      await appendEvent(projectRoot, {
        type: "moment_silenced",
        ...baseEvent,
        reason
      });
      await complete("moment_silenced", { candidate_fingerprint: fingerprint });
      return null;
    }

    await appendEvent(projectRoot, {
      type: "moment_injected",
      ...baseEvent
    });
    await complete("moment_injected", { candidate_fingerprint: fingerprint });

    return {
      hookSpecificOutput: {
        hookEventName: "PostToolBatch",
        additionalContext: [
          "Learning Moments found a question for the user.",
          "",
          "Ask the user this question before explaining the change further:",
          "",
          `Learning Moment \`${displayId}\``,
          classification.question,
          "",
          "Wait for the user's answer before giving any explanation. Include the Learning Moment ID in the question."
        ].join("\n")
      }
    };
  });
}
