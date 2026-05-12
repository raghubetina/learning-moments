// @ts-check
import { findGitRoot } from "./git.js";
import { appendEvent } from "./log.js";

// Wraps a hook action with fail-open semantics: hook errors must never break
// the user's Claude Code workflow. To avoid silent failure (which leaves
// corrupt JSONL, bad config, stale locks, and parse errors undebuggable), we
// best-effort record a `hook_error` event before exiting 0. A failure to
// record is itself swallowed so the contract holds even when the log is
// the thing that's broken.
//
// By default we record only the error message (no stack). Stacks can include
// local paths and tend to clutter the persisted record. Set
// LEARNING_MOMENTS_DEBUG=1 to record the full stack and surface it on stderr
// for immediate visibility while debugging.
/**
 * @param {string} eventName
 * @param {() => Promise<unknown>} action
 */
export async function runHook(eventName, action) {
  const startedAt = Date.now();
  try {
    await action();
  } catch (error) {
    const debug = process.env.LEARNING_MOMENTS_DEBUG === "1";
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    if (debug) {
      process.stderr.write(`[learning-moments] hook ${eventName} failed: ${message}\n`);
      if (stack) process.stderr.write(`${stack}\n`);
    }
    try {
      const projectRoot = findGitRoot(process.cwd());
      await appendEvent(projectRoot, {
        type: "hook_error",
        hook_event_name: eventName,
        cwd: process.cwd(),
        duration_ms: Date.now() - startedAt,
        error_message: message,
        ...(debug && stack ? { error_stack: stack } : {})
      });
    } catch {
      // intentional: never let logging failure break fail-open behavior
    }
    process.exitCode = 0;
  }
}
