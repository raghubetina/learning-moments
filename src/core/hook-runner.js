// @ts-check
import { findGitRoot } from "./git.js";
import { appendEvent } from "./log.js";

// Wraps a hook action with fail-open semantics: hook errors must never break
// the user's Claude Code workflow. To avoid silent failure (which leaves
// corrupt JSONL, bad config, stale locks, and parse errors undebuggable), we
// best-effort record a `hook_error` event before exiting 0. A failure to
// record is itself swallowed so the contract holds even when the log is
// the thing that's broken.
/**
 * @param {string} eventName
 * @param {() => Promise<unknown>} action
 */
export async function runHook(eventName, action) {
  const startedAt = Date.now();
  try {
    await action();
  } catch (error) {
    try {
      const projectRoot = findGitRoot(process.cwd());
      await appendEvent(projectRoot, {
        type: "hook_error",
        hook_event_name: eventName,
        cwd: process.cwd(),
        duration_ms: Date.now() - startedAt,
        error_message: error instanceof Error ? error.message : String(error),
        error_stack: error instanceof Error ? error.stack : undefined
      });
    } catch {
      // intentional: never let logging failure break fail-open behavior
    }
    process.exitCode = 0;
  }
}
