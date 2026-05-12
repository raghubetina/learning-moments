import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, parseConfig, writeConfig } from "../src/core/config.js";
import { changedSinceBaseline, contextForFiles, snapshot } from "../src/core/git.js";
import { createId, shortId } from "../src/core/ids.js";
import { settingsArgument } from "../src/core/claude.js";
import { LockTimeoutError, withProjectLock } from "../src/core/lock.js";
import { appendEvent, readEvents } from "../src/core/log.js";
import { configPath, dataDir, locksDir, noHooksSettingsPath } from "../src/core/paths.js";
import { redactSecrets } from "../src/core/redaction.js";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "learning-moments-test-"));
}

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
  if (args[0] === "init") {
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "test"], { cwd, stdio: "ignore" });
  }
}

describe("ids", () => {
  it("creates readable namespaced IDs and short IDs", () => {
    const id = createId("moment", new Date("2026-05-10T12:34:56Z"));
    expect(id).toMatch(/^lm_moment_20260510_123456_[0-9a-f]{4}$/);
    expect(shortId(id)).toMatch(/^lm_[0-9a-f]{4}$/);
  });

  it("includes staged changes and untracked file contents in candidate context", async () => {
    const root = await tempDir();
    git(["init", "-b", "main"], root);
    await fs.writeFile(path.join(root, "tracked.txt"), "one\n");
    git(["add", "tracked.txt"], root);
    git(["commit", "-m", "initial"], root);

    await fs.writeFile(path.join(root, "tracked.txt"), "two\n");
    git(["add", "tracked.txt"], root);
    expect(contextForFiles(root, ["tracked.txt"], 4000)).toContain("+two");

    await fs.writeFile(path.join(root, "new-only.txt"), "brand new\n");
    expect(contextForFiles(root, ["new-only.txt"], 4000)).toContain("brand new");

    await fs.writeFile(path.join(root, "new-mixed.txt"), "also brand new\n");
    const mixed = contextForFiles(root, ["tracked.txt", "new-mixed.txt"], 4000);
    expect(mixed).toContain("+two");
    expect(mixed).toContain("also brand new");
  });
});

describe("config", () => {
  it("round-trips the default config", async () => {
    const root = await tempDir();
    await fs.mkdir(dataDir(root), { recursive: true });
    await writeConfig(root, defaultConfig);
    await expect(fs.stat(configPath(root))).resolves.toBeTruthy();
    await expect(loadConfig(root)).resolves.toEqual(defaultConfig);
  });

  it("rejects negative frequency limits", () => {
    const bad = {
      ...defaultConfig,
      frequency: { ...defaultConfig.frequency, immediate_prompts_per_hour: -1 }
    };
    expect(() => parseConfig(bad)).toThrow(/immediate_prompts_per_hour/);
  });

  it("rejects negative context limits", () => {
    const bad = {
      ...defaultConfig,
      context_limits: { ...defaultConfig.context_limits, max_diff_chars: -10 }
    };
    expect(() => parseConfig(bad)).toThrow(/max_diff_chars/);
  });

  it("rejects zero or negative Claude call timeouts", () => {
    const zero = {
      ...defaultConfig,
      claude: { ...defaultConfig.claude, classifier_timeout_seconds: 0 }
    };
    expect(() => parseConfig(zero)).toThrow(/classifier_timeout_seconds/);

    const negative = {
      ...defaultConfig,
      claude: { ...defaultConfig.claude, grader_timeout_seconds: -5 }
    };
    expect(() => parseConfig(negative)).toThrow(/grader_timeout_seconds/);
  });

  it("rejects ignore.paths patterns using unsupported glob syntax", () => {
    const cases = [
      { pattern: "src/{a,b}/**", feature: /brace expansion/ },
      { pattern: "src/[abc]/foo", feature: /character class/ },
      { pattern: "src/?(foo).js", feature: /extglob/ },
      { pattern: "src/?/foo.js", feature: /single-character wildcard/ }
    ];
    for (const { pattern, feature } of cases) {
      const bad = {
        ...defaultConfig,
        ignore: { ...defaultConfig.ignore, paths: [pattern] }
      };
      expect(() => parseConfig(bad), `pattern ${pattern} should be rejected`).toThrow(feature);
    }
  });
});

describe("log", () => {
  it("appends and reads JSONL events", async () => {
    const root = await tempDir();
    await fs.mkdir(dataDir(root), { recursive: true });
    const event = await appendEvent(root, { type: "hook_error", cwd: root });
    expect(event.id).toMatch(/^lm_event_/);

    const events = await readEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("hook_error");
  });
});

describe("redaction", () => {
  it("redacts common secrets with typed placeholders", () => {
    const result = redactSecrets("ANTHROPIC_API_KEY=sk-ant-abc1234567890abcdefghi");
    expect(result.text).toContain("[REDACTED_ANTHROPIC_KEY");
    expect(result.text).toContain("hash=");
    expect(result.findings[0]?.type).toBe("ANTHROPIC_KEY");
  });
});

describe("settingsArgument (no-hooks settings file)", () => {
  async function writeSettings(root, contents) {
    await fs.mkdir(dataDir(root), { recursive: true });
    await fs.writeFile(noHooksSettingsPath(root), contents);
  }

  const INLINE = JSON.stringify({ disableAllHooks: true });

  it("returns the file path when the file contains disableAllHooks: true", async () => {
    const root = await tempDir();
    await writeSettings(root, JSON.stringify({ disableAllHooks: true }));
    expect(await settingsArgument(root)).toBe(noHooksSettingsPath(root));
  });

  it("falls back to inline JSON when the file is missing", async () => {
    const root = await tempDir();
    expect(await settingsArgument(root)).toBe(INLINE);
  });

  it("falls back to inline JSON when the file is unparseable", async () => {
    const root = await tempDir();
    await writeSettings(root, "{ not valid json");
    expect(await settingsArgument(root)).toBe(INLINE);
  });

  it("falls back to inline JSON when disableAllHooks is false", async () => {
    const root = await tempDir();
    await writeSettings(root, JSON.stringify({ disableAllHooks: false }));
    expect(await settingsArgument(root)).toBe(INLINE);
  });

  it("falls back to inline JSON when the disableAllHooks field is missing", async () => {
    const root = await tempDir();
    await writeSettings(root, JSON.stringify({ hooks: {} }));
    expect(await settingsArgument(root)).toBe(INLINE);
  });
});

describe("locks", () => {
  async function plantStaleLock(root, lockName, holder) {
    const lockRoot = locksDir(root);
    await fs.mkdir(lockRoot, { recursive: true });
    const lockPath = path.join(lockRoot, `${lockName}.lock`);
    await fs.mkdir(lockPath);
    if (holder) {
      await fs.writeFile(path.join(lockPath, "holder.json"), `${JSON.stringify(holder)}\n`);
    }
    return lockPath;
  }

  it("acquires and releases a lock end-to-end", async () => {
    const root = await tempDir();
    let ran = false;
    await withProjectLock(root, "regression", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    await expect(fs.stat(path.join(locksDir(root), "regression.lock"))).rejects.toThrow();
  });

  it("reclaims a lock whose recorded PID is no longer alive", async () => {
    const root = await tempDir();
    // PID 2 ** 22 is well above any normal pid_max; not in use on a CI runner.
    await plantStaleLock(root, "deadpid", { pid: 2 ** 22, acquiredAt: Date.now(), lockName: "deadpid" });
    let ran = false;
    await withProjectLock(root, "deadpid", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("reclaims a lock that exceeds the age threshold even if the PID is alive", async () => {
    const root = await tempDir();
    // Current process is alive, but acquired more than 5 minutes ago.
    const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
    await plantStaleLock(root, "ancient", { pid: process.pid, acquiredAt: sixMinutesAgo, lockName: "ancient" });
    let ran = false;
    await withProjectLock(root, "ancient", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("does not reclaim a fresh lock held by a live process", async () => {
    const root = await tempDir();
    await plantStaleLock(root, "live", { pid: process.pid, acquiredAt: Date.now(), lockName: "live" });
    await expect(
      withProjectLock(root, "live", async () => {}, 200)
    ).rejects.toBeInstanceOf(LockTimeoutError);
  });
});

describe("git snapshots", () => {
  it("distinguishes changes since a baseline", async () => {
    const root = await tempDir();
    git(["init", "-b", "main"], root);
    await fs.writeFile(path.join(root, "tracked.txt"), "one\n");
    git(["add", "tracked.txt"], root);
    git(["commit", "-m", "initial"], root);

    await fs.writeFile(path.join(root, "preexisting.txt"), "dirty\n");
    const baseline = snapshot(root);

    await fs.writeFile(path.join(root, "tracked.txt"), "two\n");
    await fs.writeFile(path.join(root, "new.txt"), "new\n");
    const current = snapshot(root);

    expect(changedSinceBaseline(baseline, current)).toEqual(["new.txt", "tracked.txt"]);
  });
});
