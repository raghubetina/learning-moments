#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
  .name("learning-moments")
  .description("Claude Code hooks for situated developer learning checks")
  .version("0.1.0");

program
  .command("status")
  .description("Show Learning Moments status")
  .action(() => {
    console.log("Learning Moments is not initialized in this project yet.");
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
