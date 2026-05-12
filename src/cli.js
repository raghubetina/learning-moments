#!/usr/bin/env node
import { parseArgs } from "node:util";
import { auditCommand } from "./commands/audit.js";
import { deleteDataCommand } from "./commands/delete-data.js";
import { doctorCommand } from "./commands/doctor.js";
import { postToolBatchHook } from "./commands/hooks/post-tool-batch.js";
import { postToolUseHook } from "./commands/hooks/post-tool-use.js";
import { sessionStartHook } from "./commands/hooks/session-start.js";
import { stopHook } from "./commands/hooks/stop.js";
import { userPromptExpansionHook } from "./commands/hooks/user-prompt-expansion.js";
import { userPromptSubmitHook } from "./commands/hooks/user-prompt-submit.js";
import { initCommand } from "./commands/init.js";
import { metricsCommand } from "./commands/metrics.js";
import { overrideCommand } from "./commands/override.js";
import { pauseCommand } from "./commands/pause.js";
import { resumeCommand } from "./commands/resume.js";
import { statusCommand } from "./commands/status.js";
import { uninstallCommand } from "./commands/uninstall.js";
import { verifyCommand } from "./commands/verify.js";
import { runHook } from "./core/hook-runner.js";
import { version } from "./core/path-self.js";
import { printJson, readStdin } from "./core/stdin.js";

const USAGE = `learning-moments — Claude Code hooks for brief questions tied to the code you are working on

Usage:
  learning-moments <command> [options]

Commands:
  init [--shared] [--observe-only]   Initialize Learning Moments in the current Git project
  doctor                              Check Learning Moments installation
  status                              Show Learning Moments status
  metrics [--json] [--since <w>] [--session <id>]
                                      Show speed and cost metrics (window like 30m, 24h, 7d)
  pause   [--project] [--session <id>]
  resume  [--project] [--session <id>]
  verify                              Check understanding of current uncommitted changes
  override <moment-id> --grade <0-3> [--note <text>]
                                      Record a manual grade override
  uninstall                           Remove hooks and slash commands (keep data)
  delete-data                         Delete local .learning-moments data
  audit [--json]                      Print install mode, hook paths, and file hashes
  hook <event>                        Internal: Claude Code hook entrypoint

Other:
  --version, -v   print version
  --help,    -h   print this message
`;

async function readHookJson() {
  const raw = await readStdin();
  return raw.trim().length > 0 ? JSON.parse(raw) : {};
}

function parse(args, schema) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: schema
  });
}

const dispatch = {
  async init(args) {
    const { values } = parse(args, {
      shared: { type: "boolean" },
      "observe-only": { type: "boolean" }
    });
    await initCommand({ shared: values.shared, observeOnly: values["observe-only"] });
  },

  async doctor() {
    await doctorCommand();
  },

  async status() {
    await statusCommand();
  },

  async metrics(args) {
    const { values } = parse(args, {
      json: { type: "boolean" },
      since: { type: "string", default: "24h" },
      session: { type: "string" }
    });
    await metricsCommand({ json: values.json, since: values.since, session: values.session });
  },

  async uninstall() {
    await uninstallCommand();
  },

  async pause(args) {
    const { values } = parse(args, {
      project: { type: "boolean" },
      session: { type: "string" }
    });
    await pauseCommand({ project: values.project, session: values.session });
  },

  async resume(args) {
    const { values } = parse(args, {
      project: { type: "boolean" },
      session: { type: "string" }
    });
    await resumeCommand({ project: values.project, session: values.session });
  },

  async verify() {
    await verifyCommand();
  },

  async override(args) {
    const { values, positionals } = parse(args, {
      grade: { type: "string" },
      note: { type: "string" }
    });
    const momentId = positionals[0];
    if (!momentId) {
      throw new Error("override requires a moment id: learning-moments override <moment-id> --grade <0-3>");
    }
    if (values.grade === undefined) {
      throw new Error("override requires --grade <0-3>");
    }
    await overrideCommand(momentId, { grade: values.grade, note: values.note });
  },

  async "delete-data"() {
    await deleteDataCommand();
  },

  async audit(args) {
    const { values } = parse(args, {
      json: { type: "boolean" }
    });
    await auditCommand({ json: values.json });
  },

  async hook(args) {
    // Hook dispatch must stay inside the fail-open boundary. A typo or a
    // stale installed hook entry from an older version would otherwise throw
    // before runHook is invoked, exit non-zero, and interrupt the user's
    // Claude Code session — exactly what runHook exists to prevent. By
    // moving the lookup inside the wrapped action, any unknown event
    // produces a logged hook_error and a clean exit 0.
    const action = args[0] ?? "(missing)";
    await runHook(action, async () => {
      if (!args[0]) {
        throw new Error("hook requires an event name");
      }
      const handlers = {
        "post-tool-use": async () => {
          await postToolUseHook(await readHookJson());
        },
        "post-tool-batch": async () => {
          const output = await postToolBatchHook(await readHookJson());
          if (output) printJson(output);
        },
        "user-prompt-submit": async () => {
          const output = await userPromptSubmitHook(await readHookJson());
          if (output) printJson(output);
        },
        "user-prompt-expansion": async () => {
          await userPromptExpansionHook(await readHookJson());
        },
        stop: async () => {
          await stopHook(await readHookJson());
        },
        "session-start": async () => {
          await sessionStartHook(await readHookJson());
        }
      };
      const handler = handlers[action];
      if (!handler) {
        throw new Error(`unknown hook event: ${action}`);
      }
      await handler();
    });
  }
};

async function main(argv) {
  const args = argv.slice(2);
  const first = args[0];

  if (!first || first === "--help" || first === "-h") {
    process.stdout.write(USAGE);
    return;
  }
  if (first === "--version" || first === "-v") {
    process.stdout.write(`${version()}\n`);
    return;
  }

  const handler = dispatch[first];
  if (!handler) {
    process.stderr.write(`unknown command: ${first}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  await handler(args.slice(1));
}

main(process.argv).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
