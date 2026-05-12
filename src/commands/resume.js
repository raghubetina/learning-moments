import { loadConfig, writeConfig } from "../core/config.js";
import { findGitRoot } from "../core/git.js";
import { appendEvent } from "../core/log.js";

export async function resumeCommand(options) {
  const projectRoot = findGitRoot(process.cwd());
  const config = await loadConfig(projectRoot);
  if (options.session && !options.project) {
    delete config.paused.sessions[options.session];
  } else {
    config.paused.project = false;
  }
  await writeConfig(projectRoot, config);
  await appendEvent(projectRoot, {
    type: "pause_changed",
    scope: options.session && !options.project ? "session" : "project",
    session_id: options.session,
    paused: false,
    cwd: projectRoot
  });
  console.log(
    options.session && !options.project
      ? `Learning Moments resumed for session ${options.session}.`
      : "Learning Moments resumed for this project."
  );
}
