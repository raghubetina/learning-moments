import { immediatePromptBudgetAvailable, classifierBudgetAvailable } from "../../core/budget.js";
import { classifyCandidate } from "../../core/classifier.js";
import { loadConfig } from "../../core/config.js";
import { candidateFingerprint } from "../../core/fingerprint.js";
import { changedSinceBaseline, contextForFiles, findGitRoot, workspaceContext } from "../../core/git.js";
import { parsePostToolBatchInput } from "../../core/hook-input.js";
import { createId, shortId } from "../../core/ids.js";
import { appendEvent, readControl, readLedger } from "../../core/log.js";
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

  const controlEvents = await readControl(projectRoot);
  if (!classifierBudgetAvailable(controlEvents, config)) {
    await complete("classifier_budget_exhausted");
    return null;
  }

  // Defer the working-tree context until after every early-return path so
  // that disabled, paused, or budget-exhausted invocations never pay for
  // path discovery (and never trigger lazy hashing).
  const ctx = workspaceContext(parsed.cwd, config);

  // Baselines live in the control class — bounded retention so the hot
  // path doesn't read more history than it needs.
  const baseline = latestSessionBaseline(controlEvents, parsed.session_id) ?? {
    root: projectRoot,
    head: ctx.head,
    branch: ctx.branch,
    candidates: [],
    hashes: {}
  };
  if (baseline.head !== ctx.head || baseline.branch !== ctx.branch) {
    await appendEvent(projectRoot, {
      type: "session_baseline_created",
      session_id: parsed.session_id,
      transcript_path: parsed.transcript_path,
      cwd: parsed.cwd,
      snapshot: ctx.toBaseline(),
      reason: "head_or_branch_changed"
    });
    await complete("baseline_reset_head_or_branch_changed");
    return null;
  }
  const current = ctx.toBaseline();
  const files = changedSinceBaseline(baseline, current).slice(0, config.context_limits.max_paths);
  if (files.length === 0) {
    await complete("no_candidate");
    return null;
  }

  // Phase 1 — claim the fingerprint under a brief lock so concurrent hooks
  // can't both pass dedupe and call the classifier twice for the same
  // change. We deliberately do NOT hold the lock across the classifier
  // call (default 45s timeout vs. 5s lock acquisition timeout); a slow
  // model call shouldn't make a second hook fail-open just because one
  // request is in flight.
  const diff = redactSecrets(contextForFiles(projectRoot, files, config.context_limits.max_diff_chars));
  const fingerprint = candidateFingerprint(files, diff.text);

  const claim = await withProjectLock(projectRoot, "moment-claim", async () => {
    const lockedControl = await readControl(projectRoot);
    const alreadySeen = lockedControl.some(
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
      return { status: "already_seen" };
    }

    await appendEvent(projectRoot, {
      type: "classifier_called",
      session_id: parsed.session_id,
      transcript_path: parsed.transcript_path,
      cwd: parsed.cwd,
      files,
      candidate_fingerprint: fingerprint
    });
    return { status: "claimed" };
  });

  if (claim.status === "already_seen") {
    await complete("candidate_already_seen", { candidate_fingerprint: fingerprint });
    return null;
  }

  // Slow path — runs OUTSIDE the moment-claim lock so parallel hooks with
  // distinct fingerprints don't serialize on each other's model calls.
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

  // Phase 2 — re-acquire the lock to do the budget check + injection
  // decision atomically. Between phase 1 and here another hook may have
  // injected a moment of its own; the budget read inside the lock is what
  // makes the inject/silence call coherent.
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

  const injection = await withProjectLock(projectRoot, "moment-claim", async () => {
    await appendEvent(projectRoot, {
      type: "moment_created",
      ...baseEvent,
      moment_type: classification.moment_type,
      learning_value: classification.learning_value,
      flow_cost: classification.flow_cost
    });

    const lockedLedger = await readLedger(projectRoot);
    const canInject =
      config.mode === "active" &&
      classification.delivery === "active" &&
      classification.timing === "ask_now" &&
      immediatePromptBudgetAvailable(lockedLedger, config);

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
      return { status: "silenced" };
    }

    await appendEvent(projectRoot, {
      type: "moment_injected",
      ...baseEvent
    });
    return { status: "injected" };
  });

  if (injection.status === "silenced") {
    await complete("moment_silenced", { candidate_fingerprint: fingerprint });
    return null;
  }

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
}
