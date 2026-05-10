import fs from "node:fs/promises";
import path from "node:path";
import { pathExists, readJsonFile, writeJsonFile } from "./file-utils.js";
import { utcStamp } from "./ids.js";

type JsonObject = Record<string, unknown>;

interface HookCommand {
  type: "command";
  command: string;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

const hookSpecs: Array<{ event: string; matcher?: string; command: string }> = [
  {
    event: "PostToolUse",
    matcher: "Edit|Write",
    command: "learning-moments hook post-tool-use"
  },
  {
    event: "PostToolBatch",
    command: "learning-moments hook post-tool-batch"
  },
  {
    event: "UserPromptSubmit",
    command: "learning-moments hook user-prompt-submit"
  },
  {
    event: "UserPromptExpansion",
    command: "learning-moments hook user-prompt-expansion"
  },
  {
    event: "Stop",
    command: "learning-moments hook stop"
  },
  {
    event: "SessionStart",
    command: "learning-moments hook session-start"
  }
];

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hookGroupHasCommand(group: HookGroup, command: string): boolean {
  return group.hooks.some((hook) => hook.type === "command" && hook.command === command);
}

export function settingsPath(projectRoot: string, shared: boolean): string {
  return path.join(projectRoot, ".claude", shared ? "settings.json" : "settings.local.json");
}

export async function installHooks(projectRoot: string, shared: boolean): Promise<string> {
  const target = settingsPath(projectRoot, shared);
  await fs.mkdir(path.dirname(target), { recursive: true });

  let settings: JsonObject = {};
  if (await pathExists(target)) {
    await fs.copyFile(target, `${target}.bak.${utcStamp()}`);
    const parsed = await readJsonFile(target);
    settings = isObject(parsed) ? parsed : {};
  }

  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  for (const spec of hookSpecs) {
    const groups = Array.isArray(hooks[spec.event]) ? (hooks[spec.event] as HookGroup[]) : [];
    const existing = groups.find((group) => (group.matcher ?? "") === (spec.matcher ?? ""));
    if (existing) {
      if (!hookGroupHasCommand(existing, spec.command)) {
        existing.hooks.push({ type: "command", command: spec.command });
      }
    } else {
      groups.push({
        ...(spec.matcher ? { matcher: spec.matcher } : {}),
        hooks: [{ type: "command", command: spec.command }]
      });
    }
    hooks[spec.event] = groups;
  }

  settings.hooks = hooks;
  await writeJsonFile(target, settings);
  return target;
}

export async function uninstallHooks(projectRoot: string, shared: boolean): Promise<string | null> {
  const target = settingsPath(projectRoot, shared);
  if (!(await pathExists(target))) {
    return null;
  }

  await fs.copyFile(target, `${target}.bak.${utcStamp()}`);
  const parsed = await readJsonFile(target);
  const settings = isObject(parsed) ? parsed : {};
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  const commands = new Set(hookSpecs.map((spec) => spec.command));

  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) {
      continue;
    }
    const nextGroups = value
      .map((group) => {
        if (!isObject(group) || !Array.isArray(group.hooks)) {
          return group;
        }
        return {
          ...group,
          hooks: group.hooks.filter((hook) => !isObject(hook) || !commands.has(String(hook.command)))
        };
      })
      .filter((group) => !isObject(group) || !Array.isArray(group.hooks) || group.hooks.length > 0);

    if (nextGroups.length > 0) {
      hooks[event] = nextGroups;
    } else {
      delete hooks[event];
    }
  }

  settings.hooks = hooks;
  await writeJsonFile(target, settings);
  return target;
}
