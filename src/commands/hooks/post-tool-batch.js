import { immediatePromptBudgetAvailable, classifierBudgetAvailable } from "../../core/budget.js";
import { classifyCandidate } from "../../core/classifier.js";
import { loadConfig } from "../../core/config.js";
import { candidateFiles } from "../../core/filter.js";
import { candidateFingerprint } from "../../core/fingerprint.js";
import { changedSinceBaseline, contextForFiles, gitHashObjects, workspaceContext } from "../../core/git.js";
import { parsePostToolBatchInput } from "../../core/hook-input.js";
import { createId, shortId } from "../../core/ids.js";
import { appendEvent, readControl, readLedger } from "../../core/log.js";
import {
  latestSessionBaseline,
  newestFirst,
  pendingInjectedMoment,
  pendingReadyMoment,
  recentQuestions,
  reviewedVersions
} from "../../core/state.js";
import { withProjectLock } from "../../core/lock.js";
import { resolveProject } from "../../core/project.js";

export async function postToolBatchHook(input) {
  if (process.env.LEARNING_MOMENTS_INTERNAL === "1") {
    return null;
  }
  const startedAt = Date.now();
  const parsed = parsePostToolBatchInput(input);
  // Context added here would reach a subagent, not the developer, while
  // still spending the question budget. The subagent's edits are seen
  // when the main conversation's own tool batch ends.
  if (parsed.agent_id) return null;
  // Resolve the project cheaply so we can short-circuit on pause/disabled
  // before incurring the expense of a full working-tree snapshot, which
  // hashes every dirty and untracked file.
  const project = await resolveProject(parsed.cwd);
  if (!project) return null;
  const { dataRoot: projectRoot, workRoot } = project;
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
  // A question already waiting for the end of the turn makes another
  // classification wasted work.
  const ledger = await readLedger(projectRoot);
  if (pendingReadyMoment(ledger, parsed.session_id)) {
    await complete("moment_already_ready");
    return null;
  }
  if (!classifierBudgetAvailable(controlEvents, config)) {
    await complete("classifier_budget_exhausted");
    return null;
  }

  // Gate on the prompt budget upstream while the classifier is still
  // inline. In active mode there's no point paying for a ~20s model call
  // when the result will be silenced anyway (budget=1/hour by default
  // means most calls would be silenced after the first one each hour).
  // The authoritative budget check still happens inside the phase-2 lock
  // — this is just an optimization that skips the slow path when the
  // outcome is foreseeable. Observe-only mode still classifies so the
  // ledger keeps capturing "what would have happened."
  if (config.mode === "active") {
    const ledgerForBudget = await readLedger(projectRoot);
    if (!immediatePromptBudgetAvailable(ledgerForBudget, config)) {
      await complete("immediate_prompt_budget_exhausted");
      return null;
    }
  }

  // Defer the working-tree context until after every early-return path so
  // that disabled, paused, or budget-exhausted invocations never pay for
  // path discovery (and never trigger lazy hashing).
  const ctx = workspaceContext(workRoot, config);

  // Baselines live in the control class — bounded retention so the hot
  // path doesn't read more history than it needs.
  const baseline = latestSessionBaseline(controlEvents, parsed.session_id) ?? {
    root: workRoot,
    head: ctx.head,
    branch: ctx.branch,
    candidates: [],
    hashes: {}
  };
  if (baseline.root !== workRoot || baseline.head !== ctx.head || baseline.branch !== ctx.branch) {
    await appendEvent(projectRoot, {
      type: "session_baseline_created",
      session_id: parsed.session_id,
      transcript_path: parsed.transcript_path,
      cwd: parsed.cwd,
      snapshot: ctx.toBaseline({ write: true }),
      reason: "head_or_branch_changed"
    });
    await complete("baseline_reset_head_or_branch_changed");
    return null;
  }
  const current = ctx.toBaseline();
  // Filter again after the comparison: a baseline saved by an older
  // version, or under an older config, can list paths that are excluded
  // now, and their absence from the current snapshot reads as a change.
  const changed = candidateFiles(changedSinceBaseline(baseline, current), config);
  // Only what changed since this session's classifier last looked. Without
  // this, a cumulative diff keeps re-showing the same early hunk, crowds
  // later edits out of the bounded context, and invites the same question
  // twice.
  const reviewed = reviewedVersions(controlEvents, parsed.session_id);
  const fresh = changed.filter((file) => current.hashes[file] !== reviewed[file]);
  if (fresh.length === 0) {
    await complete(changed.length === 0 ? "no_candidate" : "no_new_changes");
    return null;
  }
  const files = newestFirst(workRoot, fresh).slice(0, config.context_limits.max_paths);
  // Diff against the version last reviewed or, for a file that was already
  // dirty when the session began, its baseline version, so the context is
  // this session's work rather than edits from before it.
  /** @type {Record<string, string | null>} */
  const since = Object.fromEntries(files.map((file) => [file, reviewed[file] ?? baseline.hashes[file] ?? null]));

  // Phase 1 — claim the fingerprint under a brief lock so concurrent hooks
  // can't both pass dedupe and call the classifier twice for the same
  // change. We deliberately do NOT hold the lock across the classifier
  // call (default 45s timeout vs. 5s lock acquisition timeout); a slow
  // model call shouldn't make a second hook fail-open just because one
  // request is in flight.
  // Capture each file's version once, as a blob. The context, the
  // fingerprint, and the reviewed record all describe these exact
  // versions, even if Claude edits a file while this hook waits on a lock.
  const versions = gitHashObjects(workRoot, files, { write: true });
  const diff = contextForFiles(workRoot, files, config.context_limits.max_diff_chars, { versions, since });
  // Over every selected file's version, not the truncated context, so an
  // edit past the context limit still counts as new.
  const fingerprint = candidateFingerprint(files, JSON.stringify(files.map((file) => versions[file] ?? null)));
  // Only files whose context fit whole count as reviewed; the rest stay
  // eligible for the next look.
  const reviewedNow = Object.fromEntries(diff.complete.map((file) => [file, versions[file] ?? null]));

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

    // Rechecked under the lock: async batches can overlap, and each can
    // pass the early check before any of them records its call.
    if (!classifierBudgetAvailable(lockedControl, config)) {
      return { status: "budget" };
    }

    await appendEvent(projectRoot, {
      type: "classifier_called",
      session_id: parsed.session_id,
      transcript_path: parsed.transcript_path,
      cwd: parsed.cwd,
      files,
      candidate_fingerprint: fingerprint,
      // Stored as blobs so the next look can diff against exactly these.
      reviewed: reviewedNow
    });
    return { status: "claimed" };
  });

  if (claim.status === "budget") {
    await complete("classifier_budget_exhausted");
    return null;
  }
  if (claim.status === "already_seen") {
    await complete("candidate_already_seen", { candidate_fingerprint: fingerprint });
    return null;
  }

  // Slow path — runs OUTSIDE the moment-claim lock so parallel hooks with
  // distinct fingerprints don't serialize on each other's model calls.
  const result = await classifyCandidate(projectRoot, config, {
    files,
    diff: diff.text,
    recentQuestions: recentQuestions(ledger)
  });
  if (!result || !result.ok) {
    const failureReason = result ? result.reason : "empty_context";
    await appendEvent(projectRoot, {
      type: "classifier_failed_open",
      session_id: parsed.session_id,
      transcript_path: parsed.transcript_path,
      cwd: parsed.cwd,
      files,
      candidate_fingerprint: fingerprint,
      failure_reason: failureReason,
      metrics: result?.metrics,
      redaction_findings: diff.findings
    });
    await complete("classifier_failed_open", {
      candidate_fingerprint: fingerprint,
      failure_reason: failureReason
    });
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

  const classification = result.value;
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

  // Phase 2 — re-acquire the lock to decide atomically whether this
  // question waits for the end of the turn. Between phase 1 and here
  // another hook may have queued or asked a question of its own.
  const queued = await withProjectLock(projectRoot, "moment-claim", async () => {
    await appendEvent(projectRoot, {
      type: "moment_created",
      ...baseEvent,
      moment_type: classification.moment_type,
      learning_value: classification.learning_value,
      flow_cost: classification.flow_cost
    });

    const lockedLedger = await readLedger(projectRoot);
    // One open question per session: a second would make it ambiguous
    // which one the next message answers.
    const questionPending =
      pendingInjectedMoment(lockedLedger, parsed.session_id) !== null ||
      pendingReadyMoment(lockedLedger, parsed.session_id) !== null;
    const canQueue =
      config.mode === "active" &&
      classification.delivery === "active" &&
      classification.timing === "ask_now" &&
      !questionPending &&
      immediatePromptBudgetAvailable(lockedLedger, config);

    if (!canQueue) {
      let reason;
      if (config.mode === "observe_only") reason = "observe_only";
      else if (classification.timing !== "ask_now") reason = "ask_later";
      else if (questionPending) reason = "question_pending";
      else reason = "budget_or_delivery";
      await appendEvent(projectRoot, {
        type: "moment_silenced",
        ...baseEvent,
        reason
      });
      return false;
    }

    await appendEvent(projectRoot, {
      type: "moment_ready",
      ...baseEvent,
      moment_type: classification.moment_type
    });
    return true;
  });

  await complete(queued ? "moment_ready" : "moment_silenced", { candidate_fingerprint: fingerprint });
  return null;
}
