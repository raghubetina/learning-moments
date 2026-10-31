// @ts-check
import { spawn } from "node:child_process";
import { cliPath } from "./path-self.js";

/**
 * Start a Learning Moments command in a detached process. Resolves once
 * the process has started, with the error instead if it could not start;
 * it never rejects, because a hook must fail open. The child's output goes
 * nowhere: a hook's stdout must carry only its own JSON, and a background
 * process holding it open would make Claude Code wait for it.
 *
 * @param {string[]} args
 * @returns {Promise<Error | null>}
 */
export function runInBackground(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath(), ...args], {
      detached: true,
      stdio: "ignore",
      env: process.env
    });
    // Without this listener a spawn failure (such as the Node binary
    // removed during an upgrade) is an unhandled error that crashes the
    // hook.
    child.once("error", (error) => resolve(error));
    child.once("spawn", () => {
      child.unref();
      resolve(null);
    });
  });
}
