// @ts-check

const DAY_MS = 24 * 60 * 60 * 1000;

// Days from a question (or its last recall) to the next recall. Expanding
// gaps follow the spacing literature: retrieval after a delay strengthens
// retention more than retrieval right away, and later gaps can grow.
export const RECALL_SCHEDULE_DAYS = [1, 7, 30];
// After a weak answer or "I don't know", try again sooner.
const RETRY_AFTER_DAYS = 1;
// A recall nobody gets to within this window after it falls due is
// dropped: a question about a long-settled change reads as random.
const RECALL_WINDOW_MS = 7 * DAY_MS;

/**
 * @typedef {import("./log.js").EventRecord} EventRecord
 * @typedef {{ original: EventRecord, stage: number, dueAt: number, priority: number }} DueRecall
 */

/** @param {EventRecord[]} events */
function latestGrades(events) {
  const automatic = new Map();
  const manual = new Map();
  for (const event of events) {
    if (event.type !== "grade_created" || typeof event.moment_id !== "string") continue;
    (event.source === "manual_override" ? manual : automatic).set(event.moment_id, event);
  }
  return new Map([...automatic, ...manual]);
}

/**
 * Questions due for delayed recall in this project, most useful first.
 * Originals are questions that were asked, or that the selector chose to
 * hold for later (`moment_created` with timing ask_later); each gets up to
 * RECALL_SCHEDULE_DAYS.length recalls.
 *
 * @param {EventRecord[]} events the ledger
 * @param {string} sessionId recall never repeats a question from this session
 * @param {Date} [now]
 * @returns {DueRecall[]}
 */
export function dueRecalls(events, sessionId, now = new Date()) {
  const grades = latestGrades(events);
  /** @type {Map<string, EventRecord>} */
  const originals = new Map();
  /** @type {Map<string, EventRecord[]>} */
  const recalls = new Map();
  for (const event of events) {
    const id = typeof event.moment_id === "string" ? event.moment_id : null;
    if (!id) continue;
    if (event.type === "moment_injected" && typeof event.recall_of === "string") {
      const list = recalls.get(event.recall_of) ?? [];
      list.push(event);
      recalls.set(event.recall_of, list);
    } else if (event.type === "moment_injected" || (event.type === "moment_created" && event.timing === "ask_later")) {
      if (typeof event.question === "string" && !originals.has(id)) originals.set(id, event);
    }
  }

  /** @type {DueRecall[]} */
  const due = [];
  for (const [id, original] of originals) {
    if (original.session_id === sessionId) continue;
    const done = recalls.get(id) ?? [];
    if (done.length >= RECALL_SCHEDULE_DAYS.length) continue;
    const last = done.at(-1) ?? original;
    const lastGrade = grades.get(String(last.moment_id));
    const weak = lastGrade ? lastGrade.label === "dont_know" || Number(lastGrade.grade) < 2 : false;
    const days = weak && done.length > 0 ? RETRY_AFTER_DAYS : RECALL_SCHEDULE_DAYS[done.length];
    const dueAt = new Date(last.timestamp).getTime() + days * DAY_MS;
    if (dueAt > now.getTime() || now.getTime() - dueAt > RECALL_WINDOW_MS) continue;
    // Weak answers, then higher learning value, then the oldest due.
    const priority = (weak ? 10 : 0) + Number(original.learning_value ?? 0);
    due.push({ original, stage: done.length, dueAt, priority });
  }
  return due.sort((a, b) => b.priority - a.priority || a.dueAt - b.dueAt);
}

/**
 * @param {EventRecord[]} events
 * @param {string} sessionId
 */
export function recallsAskedInSession(events, sessionId) {
  return events.filter(
    (event) => event.type === "moment_injected" && event.session_id === sessionId && typeof event.recall_of === "string"
  ).length;
}

/**
 * The question to ask at recall: the selector's recall prompt when it
 * wrote one, else the original question, framed as retrieval from memory.
 *
 * @param {EventRecord} original
 * @param {Date} [now]
 */
export function recallQuestion(original, now = new Date()) {
  const days = Math.max(1, Math.round((now.getTime() - new Date(original.timestamp).getTime()) / DAY_MS));
  const files = Array.isArray(original.files) ? original.files.slice(0, 3).map((file) => `\`${file}\``).join(", ") : "";
  const seed = typeof original.recall_seed === "string" && original.recall_seed.trim().length > 0 ? original.recall_seed : null;
  const when = days === 1 ? "yesterday" : `${days} days ago`;
  return `From memory, before looking at the code: ${when}, a change touched ${files || "this project"}. ${seed ?? original.question}`;
}
