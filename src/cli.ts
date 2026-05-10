#!/usr/bin/env node
import { Command } from "commander";
import { deleteDataCommand } from "./commands/delete-data.js";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { statusCommand } from "./commands/status.js";
import { uninstallCommand } from "./commands/uninstall.js";

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

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
