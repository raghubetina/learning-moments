import { findGitRoot } from "../core/git.js";
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

export async function metricsCommand(options) {
  const projectRoot = findGitRoot(process.cwd());
  const windowMs = sinceMs(options.since);
  const cutoff = Date.now() - windowMs;
  const events = (await readEvents(projectRoot)).filter((event) => {
    const timestamp = new Date(event.timestamp).getTime();
    const sessionMatches = !options.session || event.session_id === options.session;
    return Number.isFinite(timestamp) && timestamp >= cutoff && sessionMatches;
  });

  const hookEvents = events.filter((event) => event.type === "hook_completed");
  const hookDurations = hookEvents.map((event) => numberValue(event.duration_ms));
  const classifierCompleted = events.filter((event) => event.type === "classifier_completed");
  const graderCompleted = events.filter((event) => event.type === "grader_completed");
  const classifierMetrics = summarizeClaude(classifierCompleted);
  const graderMetrics = summarizeClaude(graderCompleted);

  const summary = {
    projectRoot,
    since: options.since ?? "24h",
    session: options.session,
    hooks: {
      total: hookEvents.length,
      by_event: countBy(hookEvents, "hook_event_name"),
      by_outcome: countBy(hookEvents, "outcome"),
      median_duration_ms: percentile(hookDurations, 50),
      p95_duration_ms: percentile(hookDurations, 95)
    },
    classifier: {
      calls: events.filter((event) => event.type === "classifier_called").length,
      completed: classifierCompleted.length,
      declined: events.filter((event) => event.type === "classifier_declined").length,
      failed_open: events.filter((event) => event.type === "classifier_failed_open").length,
      duplicate_candidates: events.filter((event) => event.type === "candidate_already_seen").length,
      avg_wall_duration_ms: avg(classifierMetrics.wall_duration_ms, classifierMetrics.calls),
      total_cost_usd: classifierMetrics.total_cost_usd,
      input_tokens: classifierMetrics.input_tokens,
      output_tokens: classifierMetrics.output_tokens,
      cache_creation_input_tokens: classifierMetrics.cache_creation_input_tokens,
      cache_read_input_tokens: classifierMetrics.cache_read_input_tokens
    },
    grader: {
      calls: graderCompleted.length,
      failed_open: events.filter((event) => event.type === "grader_failed_open").length,
      avg_wall_duration_ms: avg(graderMetrics.wall_duration_ms, graderMetrics.calls),
      total_cost_usd: graderMetrics.total_cost_usd,
      input_tokens: graderMetrics.input_tokens,
      output_tokens: graderMetrics.output_tokens,
      cache_creation_input_tokens: graderMetrics.cache_creation_input_tokens,
      cache_read_input_tokens: graderMetrics.cache_read_input_tokens
    },
    user: {
      moments_injected: events.filter((event) => event.type === "moment_injected").length,
      answered: events.filter((event) => event.type === "answer_received").length,
      skipped: events.filter((event) => event.type === "skip_recorded").length,
      grades: events.filter((event) => event.type === "grade_created").length
    }
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Learning Moments metrics (${summary.since})`);
  console.log("");
  console.log("Workflow impact:");
  console.log(`  runs: ${summary.hooks.total}`);
  console.log(`  median added time: ${ms(summary.hooks.median_duration_ms)}`);
  console.log(`  p95 added time: ${ms(summary.hooks.p95_duration_ms)}`);
  console.log(`  outcomes: ${JSON.stringify(summary.hooks.by_outcome)}`);
  console.log("");
  console.log("Moment selection:");
  console.log(`  attempts: ${summary.classifier.calls}`);
  console.log(`  checked: ${summary.classifier.completed}`);
  console.log(`  no question needed: ${summary.classifier.declined}`);
  console.log(`  selection failures that did not interrupt you: ${summary.classifier.failed_open}`);
  console.log(`  repeated changes skipped: ${summary.classifier.duplicate_candidates}`);
  console.log(`  avg latency: ${seconds(summary.classifier.avg_wall_duration_ms)}`);
  console.log(`  estimated cost: ${usd(summary.classifier.total_cost_usd)}`);
  console.log("");
  console.log("Answer feedback:");
  console.log(`  attempts: ${summary.grader.calls}`);
  console.log(`  feedback failures that did not interrupt you: ${summary.grader.failed_open}`);
  console.log(`  avg latency: ${seconds(summary.grader.avg_wall_duration_ms)}`);
  console.log(`  estimated cost: ${usd(summary.grader.total_cost_usd)}`);
  console.log("");
  console.log("User:");
  console.log(`  questions asked: ${summary.user.moments_injected}`);
  console.log(`  answered: ${summary.user.answered}`);
  console.log(`  skipped: ${summary.user.skipped}`);
  console.log(`  feedback grades: ${summary.user.grades}`);
}
