import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteDataCommand } from "../src/commands/delete-data.js";
import { initCommand } from "../src/commands/init.js";
import { metricsCommand } from "../src/commands/metrics.js";
import { pauseCommand } from "../src/commands/pause.js";
import { resumeCommand } from "../src/commands/resume.js";
import { uninstallCommand } from "../src/commands/uninstall.js";
import { loadConfig } from "../src/core/config.js";
import { readJsonFile } from "../src/core/file-utils.js";
import { appendEvent, readLedger, readTelemetry } from "../src/core/log.js";
import { controlPath, ledgerPath, migrationCompletePath, telemetryPath } from "../src/core/paths.js";

let previousCwd;

async function tempGitRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learning-moments-command-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "test"], { cwd: root, stdio: "ignore" });
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

    const settings = await readJsonFile(path.join(root, ".claude", "settings.local.json"));
    expect(settings.hooks.PostToolBatch).toHaveLength(1);
    expect(settings.hooks.PostToolBatch[0]?.hooks).toHaveLength(1);

    const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(gitignore.match(/\.learning-moments\//g)).toHaveLength(1);
    await expect(
      fs.stat(path.join(root, ".claude", "commands", "learning-moments", "status.md"))
    ).resolves.toBeTruthy();
  });

  it("backs up an unparseable existing config and writes the default", async () => {
    const root = await tempGitRepo();
    process.chdir(root);

    // Hand-plant a pre-0.3.0-shaped config: includes fields that are no
    // longer accepted by the strict parser (confidence, generated_markers).
    await fs.mkdir(path.join(root, ".learning-moments"), { recursive: true });
    const legacyConfig = {
      schema_version: 1,
      tool_version: "0.1.0",
      enabled: true,
      paused: { project: false, sessions: {} },
      frequency: {
        immediate_prompts_per_hour: 1,
        minimum_minutes_between_immediate_prompts: 20,
        session_start_recall_limit: 2,
        classifier_calls_per_hour: 10
      },
      mode: "active",
      context_storage: "excerpts",
      context_limits: {
        max_diff_chars: 12000,
        max_paths: 20,
        max_file_excerpt_chars: 8000
      },
      ignore: {
        paths: ["dist/**"],
        extensions: [".lock"],
        generated_markers: ["@generated"]
      },
      confidence: { enabled: true, ask_when_useful: true },
      claude: {
        enabled: true,
        classifier_model: "opus",
        grading_model: "opus",
        classifier_timeout_seconds: 45,
        grader_timeout_seconds: 45,
        use_bare_when_compatible: false
      }
    };
    await fs.writeFile(
      path.join(root, ".learning-moments", "config.json"),
      `${JSON.stringify(legacyConfig, null, 2)}\n`
    );

    // Suppress init's console.log output during the test.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await initCommand({});
    } finally {
      log.mockRestore();
    }

    // The bad config should now live at config.json.bak; the new
    // config.json should pass strict parse and contain no removed fields.
    await expect(
      fs.stat(path.join(root, ".learning-moments", "config.json.bak"))
    ).resolves.toBeTruthy();
    const fresh = await loadConfig(root);
    expect(fresh).not.toHaveProperty("confidence");
    expect(fresh.ignore).not.toHaveProperty("generated_markers");
    expect(fresh.context_limits).not.toHaveProperty("max_file_excerpt_chars");
  });

  it("leaves a valid existing config alone on rerun", async () => {
    const root = await tempGitRepo();
    process.chdir(root);

    await initCommand({});
    const before = await fs.readFile(
      path.join(root, ".learning-moments", "config.json"),
      "utf8"
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await initCommand({});
    } finally {
      log.mockRestore();
    }

    const after = await fs.readFile(
      path.join(root, ".learning-moments", "config.json"),
      "utf8"
    );
    expect(after).toBe(before);
    await expect(
      fs.stat(path.join(root, ".learning-moments", "config.json.bak"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("uninstallCommand", () => {
  it("removes hooks and slash commands without deleting data", async () => {
    const root = await tempGitRepo();
    process.chdir(root);

    await initCommand({});
    await uninstallCommand();

    const settings = await readJsonFile(path.join(root, ".claude", "settings.local.json"));
    expect(settings.hooks.PostToolBatch).toBeUndefined();
    await expect(fs.stat(path.join(root, ".learning-moments", "config.json"))).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(root, ".claude", "commands", "learning-moments"))
    ).rejects.toMatchObject({ code: "ENOENT" });
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

describe("metricsCommand", () => {
  it("summarizes hook and Claude call metrics as JSON", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    await appendEvent(root, {
      type: "hook_completed",
      hook_event_name: "PostToolBatch",
      duration_ms: 12,
      outcome: "classifier_declined",
      cwd: root
    });
    await appendEvent(root, {
      type: "classifier_called",
      cwd: root
    });
    await appendEvent(root, {
      type: "classifier_completed",
      cwd: root,
      metrics: {
        wall_duration_ms: 1500,
        total_cost_usd: 0.02,
        input_tokens: 100,
        output_tokens: 10
      }
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await metricsCommand({ json: true, since: "24h" });
      const summary = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(summary.hooks.total).toBe(1);
      expect(summary.classifier.calls).toBe(1);
      expect(summary.classifier.completed).toBe(1);
      expect(summary.classifier.total_cost_usd).toBe(0.02);
    } finally {
      log.mockRestore();
    }
  });
});

describe("deleteDataCommand --logs-only", () => {
  it("truncates telemetry without touching ledger or control after migration", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    await appendEvent(root, { type: "moment_created", cwd: root });
    await appendEvent(root, { type: "classifier_called", cwd: root });
    await appendEvent(root, { type: "hook_completed", cwd: root, outcome: "classifier_declined" });
    await appendEvent(root, {
      type: "classifier_completed",
      cwd: root,
      metrics: { total_cost_usd: 0.07 }
    });

    expect((await readTelemetry(root)).length).toBeGreaterThan(0);
    await deleteDataCommand({ logsOnly: true });

    // Telemetry is gone.
    expect(await readTelemetry(root)).toEqual([]);
    // Ledger survives — both moment_created and classifier_completed are here.
    const ledger = (await readLedger(root)).map((e) => e.type);
    expect(ledger).toContain("moment_created");
    expect(ledger).toContain("classifier_completed");
    // Control survives.
    const control = await fs.readFile(controlPath(root), "utf8");
    expect(control).toContain("classifier_called");
  });

  it("preserves cost data after --logs-only (metrics still report cost)", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    await appendEvent(root, {
      type: "classifier_completed",
      cwd: root,
      metrics: { wall_duration_ms: 1000, total_cost_usd: 0.05, input_tokens: 200, output_tokens: 20 }
    });
    await appendEvent(root, {
      type: "hook_completed",
      hook_event_name: "PostToolBatch",
      duration_ms: 12,
      outcome: "moment_injected",
      cwd: root
    });

    await deleteDataCommand({ logsOnly: true });

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await metricsCommand({ json: true, since: "24h" });
      const summary = JSON.parse(String(log.mock.calls[0]?.[0]));
      // Cost intact; hook count zero (telemetry got truncated).
      expect(summary.classifier.total_cost_usd).toBe(0.05);
      expect(summary.hooks.total).toBe(0);
    } finally {
      log.mockRestore();
    }
  });

  it("refuses --logs-only before migration", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await fs.mkdir(path.join(root, ".learning-moments"), { recursive: true });
    // No migration marker — should refuse.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const originalExitCode = process.exitCode;
      await deleteDataCommand({ logsOnly: true });
      expect(process.exitCode).toBe(1);
      expect(errSpy.mock.calls.flat().join(" ")).toMatch(/requires the log split to be active/);
      process.exitCode = originalExitCode;
    } finally {
      errSpy.mockRestore();
    }
  });

  it("--all (default) wipes the whole directory", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    await deleteDataCommand();
    await expect(fs.access(path.join(root, ".learning-moments"))).rejects.toThrow();
  });
});

describe("control log pruning at SessionStart", () => {
  it("drops control entries older than 1h, keeps recent ones", async () => {
    const { sessionStartHook } = await import("../src/commands/hooks/session-start.js");
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});

    const now = Date.now();
    const stale = JSON.stringify({
      id: "lm_event_stale",
      type: "classifier_called",
      timestamp: new Date(now - 2 * 60 * 60 * 1000).toISOString()
    });
    const fresh = JSON.stringify({
      id: "lm_event_fresh",
      type: "classifier_called",
      timestamp: new Date(now - 5 * 60 * 1000).toISOString()
    });
    await fs.writeFile(controlPath(root), `${stale}\n${fresh}\n`);

    await sessionStartHook({
      session_id: "s1",
      transcript_path: path.join(root, "transcript.jsonl"),
      cwd: root,
      hook_event_name: "SessionStart",
      source: "startup"
    });

    const remaining = (await fs.readFile(controlPath(root), "utf8"))
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    const ids = remaining.map((e) => e.id);
    expect(ids).toContain("lm_event_fresh");
    expect(ids).not.toContain("lm_event_stale");
  });

  it("keeps session_baseline_created rows for 24h, drops them after", async () => {
    const { sessionStartHook } = await import("../src/commands/hooks/session-start.js");
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});

    const now = Date.now();
    const recentBaseline = JSON.stringify({
      id: "lm_event_baseline_recent",
      type: "session_baseline_created",
      session_id: "s_recent",
      timestamp: new Date(now - 6 * 60 * 60 * 1000).toISOString()
    });
    const ancientBaseline = JSON.stringify({
      id: "lm_event_baseline_ancient",
      type: "session_baseline_created",
      session_id: "s_ancient",
      timestamp: new Date(now - 36 * 60 * 60 * 1000).toISOString()
    });
    await fs.writeFile(controlPath(root), `${recentBaseline}\n${ancientBaseline}\n`);

    await sessionStartHook({
      session_id: "s_new",
      transcript_path: path.join(root, "transcript.jsonl"),
      cwd: root,
      hook_event_name: "SessionStart",
      source: "startup"
    });

    const remaining = (await fs.readFile(controlPath(root), "utf8"))
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    const ids = remaining.map((e) => e.id);
    // 6h old → inside the 24h baseline window
    expect(ids).toContain("lm_event_baseline_recent");
    // 36h old → past the 24h baseline window
    expect(ids).not.toContain("lm_event_baseline_ancient");
  });

});
