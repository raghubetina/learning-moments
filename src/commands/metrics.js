import { requireProject } from "../core/project.js";
import { readEvents } from "../core/log.js";

function sinceMs(value = "24h") {
  const match = /^(\d+)(m|h|d)$/.exec(value.trim());
  if (!match) {
    throw new Error("--since must use a value like 30m, 24h, or 7d");
  }
  const amount = Number.parseInt(match[1] ?? "0", 10);
  const unit = match[2];
  if (unit === "m") {
    return amount * 60 * 1000;
  }
  if (unit === "h") {
    return amount * 60 * 60 * 1000;
  }
  return amount * 24 * 60 * 60 * 1000;
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function percentile(values, p) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function countBy(events, field) {
  const counts = {};
  for (const event of events) {
    const value = typeof event[field] === "string" ? event[field] : "unknown";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function summarizeClaude(events) {
  const summary = {
    calls: events.length,
    wall_duration_ms: 0,
    duration_ms: 0,
    duration_api_ms: 0,
    total_cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  };

  for (const event of events) {
    const metrics = event.metrics && typeof event.metrics === "object" ? event.metrics : {};
    summary.wall_duration_ms += numberValue(metrics.wall_duration_ms);
    summary.duration_ms += numberValue(metrics.duration_ms);
    summary.duration_api_ms += numberValue(metrics.duration_api_ms);
    summary.total_cost_usd += numberValue(metrics.total_cost_usd);
    summary.input_tokens += numberValue(metrics.input_tokens);
    summary.output_tokens += numberValue(metrics.output_tokens);
    summary.cache_creation_input_tokens += numberValue(metrics.cache_creation_input_tokens);
    summary.cache_read_input_tokens += numberValue(metrics.cache_read_input_tokens);
  }

  return summary;
}

function avg(total, count) {
  return count === 0 ? 0 : total / count;
}

function ms(value) {
  return `${Math.round(value)}ms`;
}

function seconds(value) {
  return `${(value / 1000).toFixed(1)}s`;
}

function usd(value) {
  return `$${value.toFixed(4)}`;
}

function reasons(counts) {
  const entries = Object.entries(counts);
  return entries.length === 0 ? "" : ` (${entries.map(([reason, n]) => `${reason} ${n}`).join(", ")})`;
}

// Hooks Claude waits on. The others run in the background.
const SYNCHRONOUS_HOOKS = ["SessionStart", "UserPromptSubmit", "Stop"];
const ANSWER_LABELS = ["correct", "partially_correct", "likely_incorrect", "unclear"];

function latency(durations) {
  return {
    runs: durations.length,
    median_ms: percentile(durations, 50),
    p95_ms: percentile(durations, 95)
  };
}

/**
 * The grade that stands for each question: the latest manual override, or
 * else the latest automatic grade. Background grading can finish after an
 * override, and must not replace it.
 */
function effectiveGrades(events) {
  const automatic = new Map();
  const manual = new Map();
  for (const event of events) {
    if (event.type !== "grade_created" || typeof event.moment_id !== "string") continue;
    (event.source === "manual_override" ? manual : automatic).set(event.moment_id, event);
  }
  return [...new Map([...automatic, ...manual]).values()];
}

export async function metricsCommand(options) {
  const { dataRoot: projectRoot } = await requireProject();
  const windowMs = sinceMs(options.since);
  const cutoff = Date.now() - windowMs;
  const events = (await readEvents(projectRoot)).filter((event) => {
    const timestamp = new Date(event.timestamp).getTime();
    const sessionMatches = !options.session || event.session_id === options.session;
    return Number.isFinite(timestamp) && timestamp >= cutoff && sessionMatches;
  });
  const ofType = (type) => events.filter((event) => event.type === type);

  const hookEvents = ofType("hook_completed");
  const hookDurations = hookEvents.map((event) => numberValue(event.duration_ms));
  /** @type {Record<string, ReturnType<typeof latency>>} */
  const byEvent = {};
  for (const name of new Set(hookEvents.map((event) => String(event.hook_event_name)))) {
    byEvent[name] = latency(hookEvents.filter((event) => event.hook_event_name === name).map((event) => numberValue(event.duration_ms)));
  }
  const waited = latency(
    hookEvents.filter((event) => SYNCHRONOUS_HOOKS.includes(String(event.hook_event_name))).map((event) => numberValue(event.duration_ms))
  );

  const classifierCompleted = ofType("classifier_completed");
  const graderCompleted = ofType("grader_completed");
  const classifierFailed = ofType("classifier_failed_open");
  const graderFailed = ofType("grader_failed_open");
  // Failed calls carry metrics when they ran long enough to be billed or
  // timed; count their cost and time alongside completed calls.
  const withMetrics = (event) => event.metrics && typeof event.metrics === "object";
  const classifierMetrics = summarizeClaude([...classifierCompleted, ...classifierFailed.filter(withMetrics)]);
  const graderMetrics = summarizeClaude([...graderCompleted, ...graderFailed.filter(withMetrics)]);

  const answers = ofType("answer_received");
  const grades = effectiveGrades(events);
  const scored = grades.filter((event) => ANSWER_LABELS.includes(String(event.label)) || event.source === "manual_override");
  const distribution = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const event of scored) {
    if (typeof event.grade === "number" && event.grade in distribution) distribution[event.grade] += 1;
  }
  const asked = ofType("moment_injected").length;
  const totalCost = classifierMetrics.total_cost_usd + graderMetrics.total_cost_usd;

  const summary = {
    projectRoot,
    since: options.since ?? "24h",
    session: options.session,
    hooks: {
      total: hookEvents.length,
      by_event: countBy(hookEvents, "hook_event_name"),
      by_outcome: countBy(hookEvents, "outcome"),
      median_duration_ms: percentile(hookDurations, 50),
      p95_duration_ms: percentile(hookDurations, 95),
      latency_by_event: byEvent,
      claude_waited: waited
    },
    classifier: {
      // Completed plus failed calls, which persist, rather than the
      // classifier_called claims that control-log pruning removes.
      calls: classifierCompleted.length + classifierFailed.length,
      completed: classifierCompleted.length,
      declined: ofType("classifier_declined").length,
      failed_open: classifierFailed.length,
      failure_reasons: countBy(classifierFailed, "failure_reason"),
      duplicate_candidates: ofType("candidate_already_seen").length,
      avg_wall_duration_ms: avg(classifierMetrics.wall_duration_ms, classifierMetrics.calls),
      total_cost_usd: classifierMetrics.total_cost_usd,
      input_tokens: classifierMetrics.input_tokens,
      output_tokens: classifierMetrics.output_tokens,
      cache_creation_input_tokens: classifierMetrics.cache_creation_input_tokens,
      cache_read_input_tokens: classifierMetrics.cache_read_input_tokens
    },
    grader: {
      calls: graderCompleted.length,
      failed_open: graderFailed.length,
      failure_reasons: countBy(graderFailed, "failure_reason"),
      avg_wall_duration_ms: avg(graderMetrics.wall_duration_ms, graderMetrics.calls),
      total_cost_usd: graderMetrics.total_cost_usd,
      input_tokens: graderMetrics.input_tokens,
      output_tokens: graderMetrics.output_tokens,
      cache_creation_input_tokens: graderMetrics.cache_creation_input_tokens,
      cache_read_input_tokens: graderMetrics.cache_read_input_tokens
    },
    user: {
      moments_injected: asked,
      recalls_asked: ofType("moment_injected").filter((event) => typeof event.recall_of === "string").length,
      answered: answers.filter((event) => event.answer_kind !== "dont_know").length,
      dont_know: answers.filter((event) => event.answer_kind === "dont_know").length,
      skipped: ofType("skip_recorded").length,
      skipped_by_kind: countBy(ofType("skip_recorded"), "skip_kind"),
      not_an_answer: grades.filter((event) => event.label === "not_an_answer").length,
      expired: ofType("moment_expired").length,
      grades: scored.length,
      grade_distribution: distribution,
      mean_grade: scored.length === 0 ? null : scored.reduce((sum, event) => sum + numberValue(event.grade), 0) / scored.length
    },
    cost: {
      total_usd: totalCost,
      per_question_asked_usd: asked === 0 ? null : totalCost / asked
    }
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const rate = (n) => (asked === 0 ? "" : ` (${Math.round((100 * n) / asked)}%)`);
  const u = summary.user;
  console.log(`Learning Moments metrics (${summary.since})`);
  console.log("");
  console.log("Questions:");
  console.log(`  asked: ${asked}${u.recalls_asked > 0 ? ` (${u.recalls_asked} delayed recall)` : ""}`);
  console.log(`  answered: ${u.answered}${rate(u.answered)}`);
  console.log(`  "don't know": ${u.dont_know}${rate(u.dont_know)}`);
  console.log(`  skipped: ${u.skipped}${rate(u.skipped)}${reasons(u.skipped_by_kind)}`);
  console.log(`  not an answer: ${u.not_an_answer}`);
  console.log(`  selected but never asked (expired): ${u.expired}`);
  if (u.grades > 0) {
    const d = u.grade_distribution;
    console.log(`  grades: 3=${d[3]} 2=${d[2]} 1=${d[1]} 0=${d[0]} (mean ${(u.mean_grade ?? 0).toFixed(2)})`);
  }
  console.log("");
  console.log("Time:");
  console.log(`  Claude waited on Learning Moments: median ${ms(waited.median_ms)}, p95 ${ms(waited.p95_ms)} over ${waited.runs} hook runs`);
  console.log(`  question selection (in the background): ${summary.classifier.calls} calls, avg ${seconds(summary.classifier.avg_wall_duration_ms)}`);
  console.log(`  grading (in the background): ${summary.grader.calls} calls, avg ${seconds(summary.grader.avg_wall_duration_ms)}`);
  console.log("");
  console.log("Question selection:");
  console.log(`  no question needed: ${summary.classifier.declined}`);
  console.log(
    `  selection failures that did not interrupt you: ${summary.classifier.failed_open}${reasons(summary.classifier.failure_reasons)}`
  );
  console.log(`  repeated changes skipped: ${summary.classifier.duplicate_candidates}`);
  console.log(
    `  grading failures that did not interrupt you: ${summary.grader.failed_open}${reasons(summary.grader.failure_reasons)}`
  );
  console.log("");
  console.log("Estimated cost:");
  console.log(`  selection ${usd(summary.classifier.total_cost_usd)}, grading ${usd(summary.grader.total_cost_usd)}, total ${usd(totalCost)}`);
  if (summary.cost.per_question_asked_usd !== null) {
    console.log(`  per question asked: ${usd(summary.cost.per_question_asked_usd)}`);
  }
}
