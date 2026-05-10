import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initCommand } from "../src/commands/init.js";
import { pauseCommand } from "../src/commands/pause.js";
import { resumeCommand } from "../src/commands/resume.js";
import { uninstallCommand } from "../src/commands/uninstall.js";
import { loadConfig } from "../src/core/config.js";
import { readJsonFile } from "../src/core/file-utils.js";

let previousCwd: string;

async function tempGitRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learning-moments-command-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  await fs.writeFile(path.join(root, "README.md"), "test\n");
  execFileSync("git", ["add", "README.md"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  return root;
}

beforeEach(() => {
  previousCwd = process.cwd();
});

afterEach(() => {
  process.chdir(previousCwd);
});

describe("initCommand", () => {
  it("creates local project files and installs hooks idempotently", async () => {
    const root = await tempGitRepo();
    process.chdir(root);

    await initCommand({ observeOnly: true });
    await initCommand({ observeOnly: true });

    const config = await loadConfig(root);
    expect(config.mode).toBe("observe_only");

    const settings = await readJsonFile(path.join(root, ".claude", "settings.local.json")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.hooks.PostToolBatch).toHaveLength(1);
    expect(settings.hooks.PostToolBatch[0]?.hooks).toHaveLength(1);

    const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(gitignore.match(/\.learning-moments\//g)).toHaveLength(1);
    await expect(fs.stat(path.join(root, ".claude", "commands", "learning-moments", "status.md"))).resolves.toBeTruthy();
  });
});

describe("uninstallCommand", () => {
  it("removes hooks and slash commands without deleting data", async () => {
    const root = await tempGitRepo();
    process.chdir(root);

    await initCommand({});
    await uninstallCommand();

    const settings = await readJsonFile(path.join(root, ".claude", "settings.local.json")) as {
      hooks: Record<string, unknown>;
    };
    expect(settings.hooks.PostToolBatch).toBeUndefined();
    await expect(fs.stat(path.join(root, ".learning-moments", "config.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, ".claude", "commands", "learning-moments"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});

describe("pause and resume", () => {
  it("updates project pause state", async () => {
    const root = await tempGitRepo();
    process.chdir(root);

    await initCommand({});
    await pauseCommand({ project: true });
    await expect(loadConfig(root)).resolves.toMatchObject({
      paused: { project: true }
    });

    await resumeCommand({ project: true });
    await expect(loadConfig(root)).resolves.toMatchObject({
      paused: { project: false }
    });
  });
});
