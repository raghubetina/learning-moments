import fs from "node:fs/promises";
import path from "node:path";
import { pathExists, readJsonFile, writeJsonFile } from "./file-utils.js";
import { utcStamp } from "./ids.js";
import { cliPath } from "./path-self.js";

const hookSpecs = [
  { event: "PostToolUse", matcher: "Edit|Write", action: "post-tool-use" },
  { event: "PostToolBatch", action: "post-tool-batch" },
  { event: "UserPromptSubmit", action: "user-prompt-submit" },
  { event: "UserPromptExpansion", action: "user-prompt-expansion" },
  { event: "Stop", action: "stop" },
  { event: "SessionStart", action: "session-start" }
];

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeHookEntry(action) {
  return {
    type: "command",
    command: "node",
    args: [cliPath(), "hook", action]
  };
}

function isOurHookEntry(entry) {
  if (!isObject(entry) || entry.type !== "command") return false;

  if (entry.command === "node" && Array.isArray(entry.args)) {
    const [cli, sub, action] = entry.args;
    return (
      typeof cli === "string" &&
      cli.endsWith(path.join("src", "cli.js")) &&
      sub === "hook" &&
      typeof action === "string" &&
      hookSpecs.some((spec) => spec.action === action)
    );
  }

  if (typeof entry.command === "string") {
    return hookSpecs.some(
      (spec) => entry.command === `learning-moments hook ${spec.action}`
    );
  }

  return false;
}

export function settingsPath(projectRoot, shared) {
  return path.join(projectRoot, ".claude", shared ? "settings.json" : "settings.local.json");
}

export async function installHooks(projectRoot, shared) {
  const target = settingsPath(projectRoot, shared);
  await fs.mkdir(path.dirname(target), { recursive: true });

  let settings = {};
  if (await pathExists(target)) {
    await fs.copyFile(target, `${target}.bak.${utcStamp()}`);
    const parsed = await readJsonFile(target);
    settings = isObject(parsed) ? parsed : {};
  }

  const hooks = isObject(settings.hooks) ? settings.hooks : {};

  for (const spec of hookSpecs) {
    const groups = Array.isArray(hooks[spec.event]) ? hooks[spec.event] : [];
    const cleanedGroups = groups.map((group) => {
      if (!isObject(group) || !Array.isArray(group.hooks)) return group;
      return {
        ...group,
        hooks: group.hooks.filter((entry) => !isOurHookEntry(entry))
      };
    });

    const matcherKey = spec.matcher ?? "";
    let group = cleanedGroups.find((g) => isObject(g) && (g.matcher ?? "") === matcherKey);
    if (!group) {
      group = spec.matcher ? { matcher: spec.matcher, hooks: [] } : { hooks: [] };
      cleanedGroups.push(group);
    }
    group.hooks.push(makeHookEntry(spec.action));

    hooks[spec.event] = cleanedGroups.filter(
      (group) => !isObject(group) || !Array.isArray(group.hooks) || group.hooks.length > 0
    );
  }

  settings.hooks = hooks;
  await writeJsonFile(target, settings);
  return target;
}

export async function uninstallHooks(projectRoot, shared) {
  const target = settingsPath(projectRoot, shared);
  if (!(await pathExists(target))) {
    return null;
  }

  await fs.copyFile(target, `${target}.bak.${utcStamp()}`);
  const parsed = await readJsonFile(target);
  const settings = isObject(parsed) ? parsed : {};
  const hooks = isObject(settings.hooks) ? settings.hooks : {};

  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    const nextGroups = value
      .map((group) => {
        if (!isObject(group) || !Array.isArray(group.hooks)) return group;
        return {
          ...group,
          hooks: group.hooks.filter((entry) => !isOurHookEntry(entry))
        };
      })
      .filter(
        (group) => !isObject(group) || !Array.isArray(group.hooks) || group.hooks.length > 0
      );

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
