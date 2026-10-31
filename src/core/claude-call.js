// @ts-check

/**
 * Failure categories for nested `claude -p` calls. Hooks fail open on every
 * model failure, so the category is what tells metrics and `doctor` why a
 * question never appeared. Raw provider errors are not persisted.
 *
 * @typedef {"disabled" | "claude_not_found" | "timeout" | "rate_limited" | "auth"
 *   | "output_too_large" | "cli_error" | "exit_nonzero" | "invalid_json"
 *   | "invalid_output" | "spawn_error"} ClaudeFailureReason
 */

export class ClaudeCallError extends Error {
  /**
   * @param {ClaudeFailureReason} reason
   * @param {string} message
   * @param {Record<string, unknown>} [metrics]
   */
  constructor(reason, message, metrics = {}) {
    super(message);
    this.name = "ClaudeCallError";
    this.reason = reason;
    this.metrics = metrics;
  }
}

/**
 * @template T
 * @typedef {{ ok: true, value: T, metrics: Record<string, unknown> }
 *   | { ok: false, reason: ClaudeFailureReason, metrics: Record<string, unknown> }} ClaudeAttempt
 */

/**
 * Run a structured model call and parse its output, returning a failure
 * category instead of throwing for the failures a hook should absorb.
 * Anything that is not a ClaudeCallError is a bug in this package and
 * propagates, so it surfaces as a descriptive `hook_error`.
 *
 * @template T
 * @param {() => Promise<{ output: unknown, metrics: Record<string, unknown> }>} run
 * @param {(output: unknown) => T} parse
 * @returns {Promise<ClaudeAttempt<T>>}
 */
export async function attemptClaudeCall(run, parse) {
  let result;
  try {
    result = await run();
  } catch (error) {
    if (!(error instanceof ClaudeCallError)) throw error;
    return { ok: false, reason: error.reason, metrics: error.metrics };
  }
  let value;
  try {
    value = parse(result.output);
  } catch {
    // The call succeeded and was billed, so keep its metrics.
    return { ok: false, reason: "invalid_output", metrics: result.metrics };
  }
  return { ok: true, value, metrics: result.metrics };
}
