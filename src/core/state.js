import { shortId } from "./ids.js";

export function latestSessionBaseline(events, sessionId) {
  const baseline = [...events].reverse().find(
    (event) => event.type === "session_baseline_created" && event.session_id === sessionId
  );
  if (!baseline || typeof baseline.snapshot !== "object" || baseline.snapshot === null) {
    return null;
  }
  return baseline.snapshot;
}

export function pendingInjectedMoment(events, sessionId) {
  const closed = new Set();
  for (const event of events) {
    const momentId = typeof event.moment_id === "string" ? event.moment_id : undefined;
    if (momentId && ["answer_received", "skip_recorded"].includes(event.type)) {
      closed.add(momentId);
    }
  }

  const injected = [...events].reverse().find(
    (event) =>
      event.type === "moment_injected" &&
      event.session_id === sessionId &&
      typeof event.moment_id === "string" &&
      !closed.has(event.moment_id)
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
    files: Array.isArray(injected.files) ? injected.files.map(String) : []
  };
}

export function pendingFeedbackMoment(events, sessionId) {
  const observed = new Set();
  for (const event of events) {
    const momentId = typeof event.moment_id === "string" ? event.moment_id : undefined;
    if (momentId && event.type === "feedback_observed") {
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
