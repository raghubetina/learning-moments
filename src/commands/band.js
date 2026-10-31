import { runInBackground } from "../core/background.js";
import { appendEvent, readLedger, readTelemetry } from "../core/log.js";
import { requireProject } from "../core/project.js";
import { redactSecrets } from "../core/redaction.js";
import { classifyReply } from "../core/reply.js";
import { pendingInjectedMoment } from "../core/state.js";

// Feedback stays in the band this long after the grade lands.
const FEEDBACK_WINDOW_MS = 10 * 60 * 1000;

/**
 * What the experimental question band shows for a session, as JSON: the
 * open question delivered to the band, and the latest feedback on an
 * answer given there. The band mod runs this after each turn.
 *
 * @param {{ session: string }} options
 */
export async function bandCommand(options) {
  const { dataRoot } = await requireProject();
  const events = await readLedger(dataRoot);
  const open = pendingInjectedMoment(events, options.session);
  const question =
    open && open.delivery === "band" ? { moment_id: open.id, short_id: open.short_id, question: open.question } : null;
  const bandMoments = new Set(
    events
      .filter((event) => event.type === "moment_injected" && event.delivery === "band" && event.session_id === options.session)
      .map((event) => event.moment_id)
  );
  const grade = [...events]
    .reverse()
    .find((event) => event.type === "grade_created" && bandMoments.has(event.moment_id) && typeof event.feedback === "string");
  // A failed grade ends the wait too, instead of leaving the band polling.
  // Grader failures are telemetry, not ledger events.
  const failure = [...(await readTelemetry(dataRoot))]
    .reverse()
    .find((event) => event.type === "grader_failed_open" && bandMoments.has(event.moment_id));
  const latest = !failure ? grade : !grade ? failure : grade.timestamp >= failure.timestamp ? grade : failure;
  const recent = latest && Date.now() - new Date(latest.timestamp).getTime() < FEEDBACK_WINDOW_MS;
  const feedback = !recent
    ? null
    : latest.type === "grade_created"
      ? { moment_id: latest.moment_id, short_id: latest.short_id, label: latest.label, text: latest.feedback }
      : {
          moment_id: latest.moment_id,
          short_id: latest.short_id,
          label: "failed",
          text: `Couldn't grade this answer (${latest.failure_reason ?? "error"}). It is still recorded.`
        };
  process.stdout.write(`${JSON.stringify({ question, feedback })}\n`);
}

/**
 * Record an answer given in the question band, or a skip, and grade it in
 * the background. The grader's feedback is what the band shows: nothing
 * passes through Claude's context.
 *
 * @param {string} momentId
 * @param {{ session: string, text?: string, skip?: boolean }} options
 */
export async function answerCommand(momentId, options) {
  const { dataRoot } = await requireProject();
  const pending = pendingInjectedMoment(await readLedger(dataRoot), options.session);
  if (!pending || pending.id !== momentId) {
    throw new Error(`Learning Moment ${momentId} is not open in this session.`);
  }
  const fields = { moment_id: pending.id, short_id: pending.short_id, session_id: options.session, cwd: dataRoot };
  const redacted = redactSecrets(options.text ?? "");
  const kind = options.skip ? "skip" : classifyReply(redacted.text);
  if (options.skip || ["skip", "continue", "pause"].includes(kind)) {
    await appendEvent(dataRoot, { type: "skip_recorded", ...fields, skip_kind: options.skip ? "band" : kind });
    return;
  }
  await appendEvent(dataRoot, {
    type: "answer_received",
    ...fields,
    answer_text: redacted.text,
    answer_kind: kind === "dont_know" ? "dont_know" : "answer",
    redaction_findings: redacted.findings,
    source: "band"
  });
  const spawnError = await runInBackground(["grade", pending.id, "--project", dataRoot]);
  if (spawnError) {
    await appendEvent(dataRoot, { type: "grader_failed_open", ...fields, failure_reason: "spawn_error" });
  }
}
