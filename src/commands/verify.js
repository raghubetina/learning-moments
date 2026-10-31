import { classifyCandidate } from "../core/classifier.js";
import { loadConfig, storedContext } from "../core/config.js";
import { candidateFiles } from "../core/filter.js";
import { contextForFiles, dirtyFiles, gitHashObjects } from "../core/git.js";
import { createId, shortId } from "../core/ids.js";
import { appendEvent, readLedger } from "../core/log.js";
import { withProjectLock } from "../core/lock.js";
import { requireProject } from "../core/project.js";
import { newestFirst, pendingInjectedMoment, recentQuestions } from "../core/state.js";

/**
 * Ask for a question on demand about the current uncommitted changes.
 * With `session`, the question is opened in that Claude Code session, so
 * the developer's next message there is read and graded as the answer.
 *
 * @param {{ session?: string }} [options]
 */
export async function verifyCommand(options = {}) {
  const { dataRoot: projectRoot, workRoot } = await requireProject();
  const config = await loadConfig(projectRoot);
  const ledger = await readLedger(projectRoot);

  const open = options.session ? pendingInjectedMoment(ledger, options.session) : null;
  if (open) {
    console.log(`Learning Moment ${open.short_id} is still open:`);
    console.log(open.question);
    return;
  }

  const files = newestFirst(workRoot, candidateFiles(dirtyFiles(workRoot), config)).slice(
    0,
    config.context_limits.max_paths
  );
  if (files.length === 0) {
    console.log("No meaningful uncommitted project changes found.");
    return;
  }

  const versions = gitHashObjects(workRoot, files, { write: true });
  const diff = contextForFiles(workRoot, files, config.context_limits.max_diff_chars, { versions });
  const result = await classifyCandidate(projectRoot, config, {
    files,
    diff: diff.text,
    recentQuestions: recentQuestions(ledger),
    onDemand: true
  });
  if (!result) {
    console.log("No readable changes to ask about.");
    return;
  }
  const session = {
    session_id: options.session,
    cwd: workRoot
  };
  if (!result.ok) {
    await appendEvent(projectRoot, {
      type: "classifier_failed_open",
      ...session,
      files,
      failure_reason: result.reason,
      metrics: result.metrics,
      source: "verify"
    });
    console.log(`Could not select a question (${result.reason}).`);
    return;
  }
  await appendEvent(projectRoot, { type: "classifier_completed", ...session, files, metrics: result.metrics, source: "verify" });

  const classification = result.value;
  if (!classification.eligible || classification.delivery === "discard") {
    console.log("No specific question found in the current uncommitted changes.");
    return;
  }

  const momentId = createId("moment");
  const moment = {
    moment_id: momentId,
    short_id: shortId(momentId),
    ...session,
    files,
    question: classification.question,
    expected_answer_outline: classification.expected_answer_outline,
    classifier_reason: classification.reason,
    redaction_findings: diff.findings,
    context_excerpt: storedContext(config, diff.text),
    recall_seed: classification.recall.prompt_seed,
    summary: classification.storage.summary,
    tags: classification.storage.tags
  };
  // Rechecked under the lock: two overlapping verify runs can both pass
  // the early check while their classifiers run.
  const shown = await withProjectLock(projectRoot, "moment-claim", async () => {
    await appendEvent(projectRoot, {
      type: "moment_created",
      ...moment,
      moment_type: classification.moment_type,
      learning_value: classification.learning_value,
      flow_cost: classification.flow_cost
    });
    if (!options.session) return moment;
    const opened = pendingInjectedMoment(await readLedger(projectRoot), options.session);
    if (opened) return { short_id: opened.short_id, question: opened.question };
    await appendEvent(projectRoot, { type: "moment_injected", ...moment, delivery: "verify" });
    return moment;
  });

  console.log(`Learning Moment ${shown.short_id}: ${shown.question}`);
  if (!options.session) {
    console.log("(Run this from /learning-moments:verify in Claude Code to have your answer read and graded.)");
  }
}
