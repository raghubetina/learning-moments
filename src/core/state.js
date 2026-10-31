import fs from "node:fs";
import path from "node:path";
import { shortId } from "./ids.js";

/**
 * Per file, the version this session's classifier last looked at, as
 * recorded by `classifier_called` events since the session's latest
 * baseline. A new baseline (after HEAD or the branch moved) starts over,
 * since versions reviewed before it describe a different history.
 *
 * @returns {Record<string, string | null>}
 */
export function reviewedVersions(events, sessionId) {
  /** @type {Record<string, string | null>} */
  let out = {};
  for (const event of events) {
    if (event.session_id !== sessionId) continue;
    if (event.type === "session_baseline_created") out = {};
    else if (event.type === "classifier_called" && event.reviewed && typeof event.reviewed === "object") {
      Object.assign(out, event.reviewed);
    }
  }
  return out;
}

/** Files ordered by modification time, newest first; deleted files lead. */
export function newestFirst(root, files) {
  const mtime = (file) => {
    try {
      return fs.lstatSync(path.join(root, file)).mtimeMs;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };
  return files
    .map((file) => ({ file, at: mtime(file) }))
    .sort((a, b) => b.at - a.at || a.file.localeCompare(b.file))
    .map((entry) => entry.file);
}

const RECENT_QUESTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The latest distinct questions selected in this project, newest first. */
export function recentQuestions(events, limit = 5, now = new Date()) {
  const out = [];
  for (const event of [...events].reverse()) {
    if (out.length >= limit) break;
    if (!["moment_ready", "moment_injected"].includes(event.type) || typeof event.question !== "string") continue;
    if (now.getTime() - new Date(event.timestamp).getTime() > RECENT_QUESTION_WINDOW_MS) break;
    if (!out.includes(event.question)) out.push(event.question);
  }
  return out;
}

export function latestSessionBaseline(events, sessionId) {
  const baseline = [...events].reverse().find(
    (event) => event.type === "session_baseline_created" && event.session_id === sessionId
  );
  if (!baseline || typeof baseline.snapshot !== "object" || baseline.snapshot === null) {
    return null;
  }
  return baseline.snapshot;
}

// A question selected in the background waits for the end of a turn. If
// no turn ends within this window, the change it was about has moved on.
export const READY_MOMENT_TTL_MS = 30 * 60 * 1000;

/**
 * The newest question selected for this session that has not yet been
 * asked, expired, or set aside.
 */
export function pendingReadyMoment(events, sessionId) {
  const settled = new Set();
  for (const event of events) {
    if (
      typeof event.moment_id === "string" &&
      ["moment_injected", "moment_expired", "moment_silenced"].includes(event.type)
    ) {
      settled.add(event.moment_id);
    }
  }
  const ready = [...events].reverse().find(
    (event) =>
      event.type === "moment_ready" &&
      event.session_id === sessionId &&
      typeof event.moment_id === "string" &&
      !settled.has(event.moment_id)
  );
  return ready ?? null;
}

// A question nobody answered within this window no longer captures the
// next message: hours later, that message is about something else.
export const PENDING_ANSWER_WINDOW_MS = 2 * 60 * 60 * 1000;

export function pendingInjectedMoment(events, sessionId, now = new Date()) {
  const closed = new Set();
  for (const event of events) {
    const momentId = typeof event.moment_id === "string" ? event.moment_id : undefined;
    if (momentId && ["answer_received", "skip_recorded", "moment_injection_missed"].includes(event.type)) {
      closed.add(momentId);
    }
  }

  const injected = [...events].reverse().find(
    (event) =>
      event.type === "moment_injected" &&
      event.session_id === sessionId &&
      typeof event.moment_id === "string" &&
      !closed.has(event.moment_id) &&
      now.getTime() - new Date(event.timestamp).getTime() <= PENDING_ANSWER_WINDOW_MS
  );
  if (!injected || typeof injected.moment_id !== "string") {
    return null;
  }

  return {
    id: injected.moment_id,
    short_id: typeof injected.short_id === "string" ? injected.short_id : shortId(injected.moment_id),
    question: typeof injected.question === "string" ? injected.question : "",
    expected_answer_outline:
      typeof injected.expected_answer_outline === "string" ? injected.expected_answer_outline : undefined,
    files: Array.isArray(injected.files) ? injected.files.map(String) : [],
    delivery: typeof injected.delivery === "string" ? injected.delivery : undefined
  };
}

export function pendingFeedbackMoment(events, sessionId) {
  const observed = new Set();
  for (const event of events) {
    const momentId = typeof event.moment_id === "string" ? event.moment_id : undefined;
    if (momentId && ["feedback_observed", "feedback_injection_missed"].includes(event.type)) {
      observed.add(momentId);
    }
  }

  const feedback = [...events].reverse().find(
    (event) =>
      event.type === "feedback_injected" &&
      event.session_id === sessionId &&
      typeof event.moment_id === "string" &&
      !observed.has(event.moment_id)
  );
  if (!feedback || typeof feedback.moment_id !== "string") {
    return null;
  }

  const grade = [...events].reverse().find(
    (event) =>
      event.type === "grade_created" &&
      event.session_id === sessionId &&
      event.moment_id === feedback.moment_id
  );

  return {
    id: feedback.moment_id,
    short_id: typeof feedback.short_id === "string" ? feedback.short_id : shortId(feedback.moment_id),
    question: typeof feedback.question === "string" ? feedback.question : "",
    feedback: grade && typeof grade.feedback === "string" ? grade.feedback : undefined,
    files: Array.isArray(feedback.files) ? feedback.files.map(String) : []
  };
}
