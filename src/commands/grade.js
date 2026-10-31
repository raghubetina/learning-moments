import { loadConfig } from "../core/config.js";
import { gradeAnswer } from "../core/grader.js";
import { appendEvent, readLedger } from "../core/log.js";
import { withProjectLock } from "../core/lock.js";

/**
 * Grade the latest answer to one question and record the result. Runs in
 * the background after UserPromptSubmit, so its latency and failures never
 * reach the conversation; Claude has already given its own feedback.
 *
 * @param {string} momentId
 * @param {{ project: string }} options
 */
export async function gradeCommand(momentId, options) {
  const projectRoot = options.project;
  const config = await loadConfig(projectRoot);
  const events = await readLedger(projectRoot);
  const moment = events.find((event) => event.type === "moment_injected" && event.moment_id === momentId);
  const answer = [...events].reverse().find((event) => event.type === "answer_received" && event.moment_id === momentId);
  if (!moment || !answer || typeof answer.answer_text !== "string") {
    throw new Error(`No answered question ${momentId} to grade.`);
  }
  // A second grader for the same answer would double-count it.
  const claimed = await withProjectLock(projectRoot, "moment-claim", async () => {
    const latest = await readLedger(projectRoot);
    if (latest.some((event) => event.type === "grade_started" && event.moment_id === momentId)) return false;
    await appendEvent(projectRoot, { type: "grade_started", moment_id: momentId, cwd: projectRoot });
    return true;
  });
  if (!claimed) return;

  const fields = {
    moment_id: momentId,
    short_id: moment.short_id,
    session_id: moment.session_id,
    transcript_path: moment.transcript_path,
    cwd: moment.cwd
  };
  const result = await gradeAnswer(projectRoot, config, {
    question: String(moment.question ?? ""),
    expectedAnswerOutline: typeof moment.expected_answer_outline === "string" ? moment.expected_answer_outline : undefined,
    answer: answer.answer_text,
    files: Array.isArray(moment.files) ? moment.files.map(String) : [],
    excerpt: typeof moment.context_excerpt === "string" ? moment.context_excerpt : undefined,
    recall: typeof moment.recall_of === "string"
  });
  if (!result.ok) {
    await appendEvent(projectRoot, {
      type: "grader_failed_open",
      ...fields,
      failure_reason: result.reason,
      metrics: result.metrics
    });
    return;
  }
  await appendEvent(projectRoot, { type: "grader_completed", ...fields, metrics: result.metrics });
  await appendEvent(projectRoot, {
    type: "grade_created",
    ...fields,
    grade: result.value.grade,
    label: result.value.label,
    feedback: result.value.feedback,
    grader_reason: result.value.reason,
    confidence: result.value.confidence
  });
}
