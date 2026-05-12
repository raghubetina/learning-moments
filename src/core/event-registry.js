// @ts-check

/**
 * Authoritative classification of every event type written by the tool.
 *
 * Three classes:
 *   - "ledger"    — durable learning record, retained forever
 *   - "control"   — hot-path control state, bounded retention
 *   - "telemetry" — disposable, truncatable any time
 *
 * `appendEvent` looks up each event by type and throws on unknown types so that
 * a new event introduced without a registry decision fails loudly at write
 * time rather than silently routing to the wrong file once log splitting lands.
 *
 * Keep this in sync with `tmp/sec_3_log_split.md`. A test enumerates the
 * literal `type: "..."` strings under `src/` and asserts every one appears
 * here.
 *
 * @typedef {"ledger" | "control" | "telemetry"} EventClass
 */

/** @type {Readonly<Record<string, EventClass>>} */
export const EVENT_CLASSES = Object.freeze({
  // Class A — durable learning record
  session_baseline_created: "ledger",
  moment_created: "ledger",
  moment_injected: "ledger",
  feedback_injected: "ledger",
  answer_received: "ledger",
  skip_recorded: "ledger",
  grade_created: "ledger",
  classifier_completed: "ledger",
  grader_completed: "ledger",
  feedback_observed: "ledger",
  feedback_injection_missed: "ledger",
  question_observed: "ledger",
  moment_injection_missed: "ledger",

  // Class B — hot-path control state
  classifier_called: "control",
  candidate_already_seen: "control",

  // Class C — disposable telemetry
  hook_completed: "telemetry",
  change_detected: "telemetry",
  classifier_declined: "telemetry",
  classifier_failed_open: "telemetry",
  grader_failed_open: "telemetry",
  moment_silenced: "telemetry",
  slash_command_observed: "telemetry",
  pause_changed: "telemetry",
  hook_error: "telemetry"
});

/**
 * @param {string} type
 * @returns {EventClass | undefined}
 */
export function eventClass(type) {
  return EVENT_CLASSES[type];
}

/**
 * @param {string} type
 * @returns {boolean}
 */
export function isKnownEventType(type) {
  return Object.prototype.hasOwnProperty.call(EVENT_CLASSES, type);
}
