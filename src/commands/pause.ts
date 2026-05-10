import { loadConfig, writeConfig } from "../core/config.js";
import { findGitRoot } from "../core/git.js";
import { appendEvent } from "../core/log.js";

export interface PauseOptions {
  project?: boolean;
  session?: string;
}

export async function pauseCommand(options: PauseOptions): Promise<void> {
  const projectRoot = findGitRoot(process.cwd());
  const config = await loadConfig(projectRoot);
  if (options.session && !options.project) {
    config.paused.sessions[options.session] = true;
  } else {
    config.paused.project = true;
  }
  await writeConfig(projectRoot, config);
  await appendEvent(projectRoot, {
    type: "pause_changed",
    scope: options.session && !options.project ? "session" : "project",
    session_id: options.session,
    paused: true,
    cwd: projectRoot
  });
  console.log(options.session && !options.project ? `Paused session ${options.session}.` : "Paused project.");
}
