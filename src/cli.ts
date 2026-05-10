#!/usr/bin/env node
import { Command } from "commander";
import { deleteDataCommand } from "./commands/delete-data.js";
import { doctorCommand } from "./commands/doctor.js";
import { postToolBatchHook } from "./commands/hooks/post-tool-batch.js";
import { postToolUseHook } from "./commands/hooks/post-tool-use.js";
import { sessionStartHook } from "./commands/hooks/session-start.js";
import { stopHook } from "./commands/hooks/stop.js";
import { userPromptExpansionHook } from "./commands/hooks/user-prompt-expansion.js";
import { userPromptSubmitHook } from "./commands/hooks/user-prompt-submit.js";
import { initCommand } from "./commands/init.js";
import { statusCommand } from "./commands/status.js";
import { uninstallCommand } from "./commands/uninstall.js";
import { printJson, readStdin } from "./core/stdin.js";

const program = new Command();

program
  .name("learning-moments")
  .description("Claude Code hooks for situated developer learning checks")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize Learning Moments in the current Git project")
  .option("--shared", "install hooks into shared .claude/settings.json instead of local settings")
  .option("--observe-only", "log candidate moments without injecting questions")
  .action((options: { shared?: boolean; observeOnly?: boolean }) => initCommand(options));

program
  .command("doctor")
  .description("Check Learning Moments installation")
  .option("--fix", "reserved for future automatic safe fixes")
  .action(() => doctorCommand());

program
  .command("status")
  .description("Show Learning Moments status")
  .action(() => statusCommand());

program
  .command("uninstall")
  .description("Remove Learning Moments hooks and slash commands without deleting learning data")
  .action(() => uninstallCommand());

program
  .command("delete-data")
  .description("Delete local .learning-moments data")
  .action(() => deleteDataCommand());

const hook = program.command("hook").description("Claude Code hook entrypoints");

async function readHookJson(): Promise<unknown> {
  const raw = await readStdin();
  return raw.trim().length > 0 ? JSON.parse(raw) : {};
}

hook
  .command("post-tool-use")
  .description("Handle Claude Code PostToolUse events")
  .action(async () => {
    await postToolUseHook(await readHookJson());
  });

hook
  .command("post-tool-batch")
  .description("Handle Claude Code PostToolBatch events")
  .action(async () => {
    const output = await postToolBatchHook(await readHookJson());
    if (output) {
      printJson(output);
    }
  });

hook
  .command("user-prompt-submit")
  .description("Handle Claude Code UserPromptSubmit events")
  .action(async () => {
    const output = await userPromptSubmitHook(await readHookJson());
    if (output) {
      printJson(output);
    }
  });

hook
  .command("user-prompt-expansion")
  .description("Handle Claude Code UserPromptExpansion events")
  .action(async () => {
    await userPromptExpansionHook(await readHookJson());
  });

hook
  .command("stop")
  .description("Handle Claude Code Stop events")
  .action(async () => {
    await stopHook(await readHookJson());
  });

hook
  .command("session-start")
  .description("Handle Claude Code SessionStart events")
  .action(async () => {
    await sessionStartHook(await readHookJson());
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
