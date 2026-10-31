import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, parseConfig, writeConfig } from "../src/core/config.js";
import { changedSinceBaseline, contextForFiles, dirtyFiles, gitHashObjects, workspaceContext } from "../src/core/git.js";
import { createId, shortId } from "../src/core/ids.js";
import { attemptClaudeCall, ClaudeCallError } from "../src/core/claude-call.js";
import {
  execFailureReason,
  nestedClaudeArgs,
  nestedClaudeEnv,
  runClaudeStructured,
  settingsArgument
} from "../src/core/claude.js";
import { LockTimeoutError, withProjectLock } from "../src/core/lock.js";
import {
  appendEvent,
  invalidateMigrationCache,
  readControl,
  readEvents,
  readLedger,
  readTelemetry
} from "../src/core/log.js";
import {
  configPath,
  controlPath,
  dataDir,
  ledgerPath,
  locksDir,
  logPath,
  migrationCompletePath,
  noHooksSettingsPath,
  telemetryPath
} from "../src/core/paths.js";
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
    expect(contextForFiles(root, ["tracked.txt"], 4000).text).toContain("+two");

    await fs.writeFile(path.join(root, "new-only.txt"), "brand new\n");
    expect(contextForFiles(root, ["new-only.txt"], 4000).text).toContain("brand new");

    await fs.writeFile(path.join(root, "new-mixed.txt"), "also brand new\n");
    const mixed = contextForFiles(root, ["tracked.txt", "new-mixed.txt"], 4000).text;
    expect(mixed).toContain("+two");
    expect(mixed).toContain("also brand new");
  });

  it("builds context in a repository with no commits yet", async () => {
    const root = await tempDir();
    git(["init", "-b", "main"], root);
    await fs.writeFile(path.join(root, "staged.js"), "export const staged = 1;\n");
    git(["add", "staged.js"], root);
    await fs.writeFile(path.join(root, "untracked.js"), "export const loose = 2;\n");

    const context = contextForFiles(root, ["staged.js", "untracked.js"], 4000).text;
    expect(context).toContain("export const staged = 1;");
    expect(context).toContain("export const loose = 2;");
  });
});

describe("context safety", () => {
  it("does not follow untracked symlinks when building hashes or model context", async () => {
    const root = await tempDir();
    git(["init", "-b", "main"], root);
    await fs.writeFile(path.join(root, "README.md"), "test\n");
    git(["add", "README.md"], root);
    git(["commit", "-m", "initial"], root);
    const outside = await tempDir();
    const secret = "outside-project-secret-value";
    const target = path.join(outside, "secret.txt");
    await fs.writeFile(target, secret);
    await fs.symlink(target, path.join(root, "linked.txt"));

    expect(gitHashObjects(root, ["linked.txt"])).toEqual({ "linked.txt": "nonfile:symlink" });
    expect(contextForFiles(root, ["linked.txt"], 4000).text).not.toContain(secret);
  });

  it("treats candidate filenames as literal paths, not pathspec patterns", async () => {
    const root = await tempDir();
    git(["init", "-b", "main"], root);
    await fs.writeFile(path.join(root, "*"), "star\n");
    await fs.writeFile(path.join(root, "private-data.txt"), "before\n");
    git(["add", "*", "private-data.txt"], root);
    git(["commit", "-m", "initial"], root);
    await fs.writeFile(path.join(root, "*"), "star changed\n");
    await fs.writeFile(path.join(root, "private-data.txt"), "excluded-canary\n");

    const context = contextForFiles(root, ["*"], 4000).text;
    expect(context).toContain("+star changed");
    expect(context).not.toContain("excluded-canary");
  });

  it("keeps working when the environment enables another pathspec mode", async () => {
    const root = await tempDir();
    git(["init", "-b", "main"], root);
    await fs.writeFile(path.join(root, "app.js"), "one\n");
    git(["add", "app.js"], root);
    git(["commit", "-m", "initial"], root);
    await fs.writeFile(path.join(root, "app.js"), "two\n");
    process.env.GIT_ICASE_PATHSPECS = "1";
    try {
      expect(contextForFiles(root, ["app.js"], 4000).text).toContain("+two");
    } finally {
      delete process.env.GIT_ICASE_PATHSPECS;
    }
  });

  it("does not read the old content of a file replaced by a symlink", async () => {
    const root = await tempDir();
    git(["init", "-b", "main"], root);
    await fs.writeFile(path.join(root, "notes.txt"), "committed-secret-notes\n");
    git(["add", "notes.txt"], root);
    git(["commit", "-m", "initial"], root);
    await fs.rm(path.join(root, "notes.txt"));
    await fs.symlink("/etc/hosts", path.join(root, "notes.txt"));

    const context = contextForFiles(root, ["notes.txt"], 4000);
    expect(context.text).not.toContain("committed-secret-notes");
    expect(context.text).not.toContain("localhost");
  });

  it("falls back to the base tree when a version already seen was pruned", async () => {
    const root = await tempDir();
    git(["init", "-b", "main"], root);
    await fs.writeFile(path.join(root, "app.js"), "one\n");
    git(["add", "app.js"], root);
    git(["commit", "-m", "initial"], root);
    await fs.writeFile(path.join(root, "app.js"), "one\ntwo\n");
    const seen = gitHashObjects(root, ["app.js"], { write: true })["app.js"];
    git(["prune", "--expire=now"], root);
    await fs.writeFile(path.join(root, "app.js"), "one\ntwo\nthree\n");

    const context = contextForFiles(root, ["app.js"], 4000, { since: { "app.js": seen } }).text;
    expect(context).toContain("+two");
    expect(context).toContain("+three");
  });

  it("does not read through a directory replaced by a symlink", async () => {
    const root = await tempDir();
    git(["init", "-b", "main"], root);
    await fs.mkdir(path.join(root, "sub"));
    await fs.writeFile(path.join(root, "sub", "file.js"), "export const inside = 1;\n");
    git(["add", "sub/file.js"], root);
    git(["commit", "-m", "initial"], root);
    const outside = await tempDir();
    await fs.writeFile(path.join(outside, "file.js"), "export const outsideFile = 2;\n");
    await fs.rm(path.join(root, "sub"), { recursive: true });
    await fs.symlink(outside, path.join(root, "sub"));

    expect(gitHashObjects(root, ["sub/file.js"])).toEqual({ "sub/file.js": "nonfile:symlinked-parent" });
    expect(contextForFiles(root, ["sub/file.js"], 4000).text).not.toContain("outsideFile");
  });

  it("does not read through a directory symlinked to an excluded directory in the repository", async () => {
    const root = await tempDir();
    git(["init", "-b", "main"], root);
    await fs.mkdir(path.join(root, "guide"));
    await fs.writeFile(path.join(root, "guide", "config"), "plain\n");
    git(["add", "guide/config"], root);
    git(["commit", "-m", "initial"], root);
    await fs.mkdir(path.join(root, ".ssh"));
    await fs.writeFile(path.join(root, ".ssh", "config"), "IdentityFile secret-key-path\n");
    await fs.rm(path.join(root, "guide"), { recursive: true });
    await fs.symlink(path.join(root, ".ssh"), path.join(root, "guide"));

    expect(contextForFiles(root, ["guide/config"], 4000).text).not.toContain("secret-key-path");
  });

  it("hashes a filename that looks C-quoted as the literal file", async () => {
    const root = await tempDir();
    git(["init", "-b", "main"], root);
    await fs.writeFile(path.join(root, "README.md"), "test\n");
    git(["add", "README.md"], root);
    git(["commit", "-m", "initial"], root);
    const outside = path.join(path.dirname(root), `outside-${path.basename(root)}.txt`);
    await fs.writeFile(outside, "outside-marker\n");
    const quoted = `"..\\057${path.basename(outside)}"`;
    await fs.writeFile(path.join(root, quoted), "literal-content\n");

    const context = contextForFiles(root, [quoted], 4000).text;
    expect(context).toContain("literal-content");
    expect(context).not.toContain("outside-marker");
  });

  it("shows a change to only the executable bit", async () => {
    const root = await tempDir();
    git(["init", "-b", "main"], root);
    await fs.writeFile(path.join(root, "run.sh"), "echo hi\n");
    git(["add", "run.sh"], root);
    git(["commit", "-m", "initial"], root);
    await fs.chmod(path.join(root, "run.sh"), 0o755);

    const context = contextForFiles(root, ["run.sh"], 4000).text;
    expect(context).toContain("old mode 100644");
    expect(context).toContain("new mode 100755");
  });

  it("redacts a private key before the context budget can truncate it", async () => {
    const root = await tempDir();
    git(["init", "-b", "main"], root);
    await fs.writeFile(path.join(root, "README.md"), "test\n");
    git(["add", "README.md"], root);
    git(["commit", "-m", "initial"], root);
    const body = "MIIEsecretkeymaterial".repeat(40);
    const key = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
    await fs.writeFile(path.join(root, "fixture.txt"), key);

    // The budget ends inside the key body, before its END marker.
    const context = contextForFiles(root, ["fixture.txt"], 300);
    expect(context.text).not.toContain("MIIEsecretkeymaterial");
    expect(context.findings.map((finding) => finding.type)).toContain("PEM_PRIVATE_KEY");
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

  it("defaults model-call effort when an older config omits it", () => {
    const { classifier_effort, grading_effort, ...olderClaude } = defaultConfig.claude;
    const parsed = parseConfig({ ...defaultConfig, claude: olderClaude });
    expect(parsed.claude.classifier_effort).toBe(defaultConfig.claude.classifier_effort);
    expect(parsed.claude.grading_effort).toBe(defaultConfig.claude.grading_effort);
  });

  it("rejects an unknown effort level", () => {
    const bad = { ...defaultConfig, claude: { ...defaultConfig.claude, classifier_effort: "turbo" } };
    expect(() => parseConfig(bad)).toThrow(/classifier_effort/);
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

  it("rejects unknown top-level keys", () => {
    const bad = { ...defaultConfig, confidence: { enabled: true } };
    expect(() => parseConfig(bad)).toThrow(/unknown key.*confidence/);
  });

  it("rejects unknown nested keys", () => {
    const bad = {
      ...defaultConfig,
      ignore: { ...defaultConfig.ignore, generated_markers: ["@generated"] }
    };
    expect(() => parseConfig(bad)).toThrow(/ignore.*unknown key.*generated_markers/);
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

  it("rejects events with an unknown type", async () => {
    const root = await tempDir();
    await fs.mkdir(dataDir(root), { recursive: true });
    await expect(appendEvent(root, { type: "not_a_real_event", cwd: root })).rejects.toThrow(
      /Unknown event type/
    );
  });

  it("writes everything to moments.jsonl when no migration marker exists", async () => {
    const root = await tempDir();
    await fs.mkdir(dataDir(root), { recursive: true });
    invalidateMigrationCache();
    await appendEvent(root, { type: "moment_created", cwd: root });
    await appendEvent(root, { type: "classifier_called", cwd: root });
    await appendEvent(root, { type: "hook_completed", cwd: root });

    const legacy = (await fs.readFile(logPath(root), "utf8")).trim().split("\n");
    expect(legacy).toHaveLength(3);
    await expect(fs.access(ledgerPath(root))).rejects.toThrow();
    await expect(fs.access(controlPath(root))).rejects.toThrow();
  });

  it("routes events by class once the migration marker is present", async () => {
    const root = await tempDir();
    await fs.mkdir(dataDir(root), { recursive: true });
    invalidateMigrationCache();
    await fs.writeFile(migrationCompletePath(root), "{}");

    await appendEvent(root, { type: "moment_created", cwd: root });
    await appendEvent(root, { type: "classifier_called", cwd: root });
    await appendEvent(root, { type: "hook_completed", cwd: root });

    const ledger = (await fs.readFile(ledgerPath(root), "utf8")).trim().split("\n");
    const control = (await fs.readFile(controlPath(root), "utf8")).trim().split("\n");
    const telemetry = (await fs.readFile(telemetryPath(root), "utf8")).trim().split("\n");
    expect(ledger).toHaveLength(1);
    expect(control).toHaveLength(1);
    expect(telemetry).toHaveLength(1);
    expect(JSON.parse(ledger[0]).type).toBe("moment_created");
    expect(JSON.parse(control[0]).type).toBe("classifier_called");
    expect(JSON.parse(telemetry[0]).type).toBe("hook_completed");
  });

  it("readEvents merges the three class files when migrated", async () => {
    const root = await tempDir();
    await fs.mkdir(dataDir(root), { recursive: true });
    invalidateMigrationCache();
    await fs.writeFile(migrationCompletePath(root), "{}");

    await appendEvent(root, { type: "moment_created", cwd: root });
    await appendEvent(root, { type: "classifier_called", cwd: root });
    await appendEvent(root, { type: "hook_completed", cwd: root });

    const events = await readEvents(root);
    expect(events.map((e) => e.type).sort()).toEqual(
      ["classifier_called", "hook_completed", "moment_created"].sort()
    );
  });
});

describe("per-class read helpers", () => {
  it("pre-migration: filters the unified log by class", async () => {
    const root = await tempDir();
    await fs.mkdir(dataDir(root), { recursive: true });
    invalidateMigrationCache();
    await appendEvent(root, { type: "moment_created", cwd: root });
    await appendEvent(root, { type: "classifier_called", cwd: root });
    await appendEvent(root, { type: "hook_completed", cwd: root });

    expect((await readLedger(root)).map((e) => e.type)).toEqual(["moment_created"]);
    expect((await readControl(root)).map((e) => e.type)).toEqual(["classifier_called"]);
    expect((await readTelemetry(root)).map((e) => e.type)).toEqual(["hook_completed"]);
  });

  it("post-migration: reads only the per-class file", async () => {
    const root = await tempDir();
    await fs.mkdir(dataDir(root), { recursive: true });
    invalidateMigrationCache();
    await fs.writeFile(migrationCompletePath(root), "{}");
    await appendEvent(root, { type: "moment_created", cwd: root });
    await appendEvent(root, { type: "classifier_called", cwd: root });
    await appendEvent(root, { type: "hook_completed", cwd: root });

    expect((await readLedger(root)).map((e) => e.type)).toEqual(["moment_created"]);
    expect((await readControl(root)).map((e) => e.type)).toEqual(["classifier_called"]);
    expect((await readTelemetry(root)).map((e) => e.type)).toEqual(["hook_completed"]);

    // Cross-check: a stray foreign event in another class file is not
    // returned. Append a telemetry-classed event directly to the ledger
    // file and verify readLedger surfaces it but readTelemetry does not.
    // (We do not validate event-class consistency at read time — the
    // registry guards the write path only.)
    await fs.appendFile(ledgerPath(root), `${JSON.stringify({ id: "x", type: "hook_completed", timestamp: new Date().toISOString() })}\n`);
    expect((await readLedger(root)).map((e) => e.type)).toContain("hook_completed");
    expect((await readTelemetry(root)).map((e) => e.type)).toEqual(["hook_completed"]);
  });
});

describe("log migration", () => {
  it("partitions a unified moments.jsonl by retention class", async () => {
    const { migrateLegacyLog } = await import("../src/core/migrate.js");
    const root = await tempDir();
    await fs.mkdir(dataDir(root), { recursive: true });
    invalidateMigrationCache();
    await appendEvent(root, { type: "moment_created", cwd: root });
    await appendEvent(root, { type: "classifier_called", cwd: root });
    await appendEvent(root, { type: "hook_completed", cwd: root });
    await appendEvent(root, { type: "answer_received", cwd: root });

    const result = await migrateLegacyLog(root);
    expect(result).toMatchObject({ migrated: true, ledger: 2, control: 1, telemetry: 1 });

    await expect(fs.access(migrationCompletePath(root))).resolves.toBeUndefined();
    const ledger = (await fs.readFile(ledgerPath(root), "utf8")).trim().split("\n").map((l) => JSON.parse(l).type);
    const control = (await fs.readFile(controlPath(root), "utf8")).trim().split("\n").map((l) => JSON.parse(l).type);
    const telemetry = (await fs.readFile(telemetryPath(root), "utf8")).trim().split("\n").map((l) => JSON.parse(l).type);
    expect(ledger.sort()).toEqual(["answer_received", "moment_created"]);
    expect(control).toEqual(["classifier_called"]);
    expect(telemetry).toEqual(["hook_completed"]);

    // No staging debris left behind.
    await expect(fs.access(`${ledgerPath(root)}.staging`)).rejects.toThrow();
    await expect(fs.access(`${controlPath(root)}.staging`)).rejects.toThrow();
    await expect(fs.access(`${telemetryPath(root)}.staging`)).rejects.toThrow();
  });

  it("is idempotent when run twice", async () => {
    const { migrateLegacyLog } = await import("../src/core/migrate.js");
    const root = await tempDir();
    await fs.mkdir(dataDir(root), { recursive: true });
    invalidateMigrationCache();
    await appendEvent(root, { type: "moment_created", cwd: root });

    const first = await migrateLegacyLog(root);
    const second = await migrateLegacyLog(root);
    expect(first.migrated).toBe(true);
    expect(second.migrated).toBe(false);

    const ledger = (await fs.readFile(ledgerPath(root), "utf8")).trim().split("\n");
    expect(ledger).toHaveLength(1);
  });

  it("writes the marker even when no legacy log exists", async () => {
    const { migrateLegacyLog } = await import("../src/core/migrate.js");
    const root = await tempDir();
    await fs.mkdir(dataDir(root), { recursive: true });
    invalidateMigrationCache();

    const result = await migrateLegacyLog(root);
    expect(result).toEqual({ migrated: true, ledger: 0, control: 0, telemetry: 0 });
    await expect(fs.access(migrationCompletePath(root))).resolves.toBeUndefined();
  });

  it("cleans up stale staging files from a prior aborted run", async () => {
    const { migrateLegacyLog } = await import("../src/core/migrate.js");
    const root = await tempDir();
    await fs.mkdir(dataDir(root), { recursive: true });
    invalidateMigrationCache();
    await appendEvent(root, { type: "moment_created", cwd: root });
    await fs.writeFile(`${ledgerPath(root)}.staging`, "stale junk that should be discarded\n");

    const result = await migrateLegacyLog(root);
    expect(result.ledger).toBe(1);
    const ledger = (await fs.readFile(ledgerPath(root), "utf8")).trim().split("\n").map((l) => JSON.parse(l).type);
    expect(ledger).toEqual(["moment_created"]);
  });

  it("after migration, appendEvent routes by class without an explicit marker write", async () => {
    const { migrateLegacyLog } = await import("../src/core/migrate.js");
    const root = await tempDir();
    await fs.mkdir(dataDir(root), { recursive: true });
    invalidateMigrationCache();
    await migrateLegacyLog(root);
    await appendEvent(root, { type: "moment_created", cwd: root });
    await appendEvent(root, { type: "hook_completed", cwd: root });

    const ledger = (await fs.readFile(ledgerPath(root), "utf8")).trim().split("\n").map((l) => JSON.parse(l).type);
    const telemetry = (await fs.readFile(telemetryPath(root), "utf8")).trim().split("\n").map((l) => JSON.parse(l).type);
    expect(ledger).toEqual(["moment_created"]);
    expect(telemetry).toEqual(["hook_completed"]);
  });
});

describe("event registry", () => {
  it("covers every event type literal that appears in src/", async () => {
    const srcRoot = path.join(__dirname, "..", "src");
    const literals = new Set();
    async function walk(dir) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".js")) {
          const text = await fs.readFile(full, "utf8");
          for (const match of text.matchAll(/type:\s*"([a-z_]+)"/g)) {
            literals.add(match[1]);
          }
          for (const match of text.matchAll(/type:\s*[A-Za-z_]+\s*\?\s*"([a-z_]+)"\s*:\s*"([a-z_]+)"/g)) {
            literals.add(match[1]);
            literals.add(match[2]);
          }
        }
      }
    }
    await walk(srcRoot);
    // Drop validate.js noise (type:"string", etc) — those aren't event types.
    const validatorTypes = new Set(["string", "integer", "number", "boolean", "array", "object", "command", "predict"]);
    const eventLiterals = [...literals].filter((t) => !validatorTypes.has(t));

    const { EVENT_CLASSES } = await import("../src/core/event-registry.js");
    const missing = eventLiterals.filter((t) => !Object.prototype.hasOwnProperty.call(EVENT_CLASSES, t));
    expect(missing).toEqual([]);
  });

  it("classifies every registered type as ledger, control, or telemetry", async () => {
    const { EVENT_CLASSES } = await import("../src/core/event-registry.js");
    const valid = new Set(["ledger", "control", "telemetry"]);
    for (const [type, klass] of Object.entries(EVENT_CLASSES)) {
      expect(valid.has(klass), `${type} → ${klass}`).toBe(true);
    }
  });
});

describe("redaction", () => {
  it("redacts a private key whose END marker is missing", () => {
    const result = redactSecrets("+-----BEGIN RSA PRIVATE KEY-----\n+MIIEowIBAAKCAQEAsecret");
    expect(result.text).not.toContain("MIIEowIBAAKCAQEAsecret");
    expect(result.findings[0]?.type).toBe("PEM_PRIVATE_KEY");
  });

  it("redacts npm, project-scoped OpenAI, and connection-string credentials", () => {
    const text = [
      `//registry.npmjs.org/:_authToken=npm_${"a".repeat(36)}`,
      "//registry.example.com/:_authToken=abcdef123456",
      `OPENAI_KEY_VALUE sk-proj-${"Ab_cD-".repeat(8)}`,
      "postgres://app:s3cretpass@db.internal:5432/app"
    ].join("\n");
    const result = redactSecrets(text);
    expect(result.text).not.toMatch(/npm_a{36}|abcdef123456|sk-proj-|s3cretpass/);
    expect(result.text).toContain("postgres://app:[REDACTED_URL_CREDENTIALS");
    expect(result.text).not.toMatch(/\[REDACTED_[A-Z_]+ hash=[0-9a-f]+ len=\d+\] hash=/);
  });

  it("leaves ordinary code that mentions tokens alone", () => {
    const text = "const token = getToken(); // login flow";
    expect(redactSecrets(text).text).toBe(text);
  });

  it("redacts common secrets with typed placeholders", () => {
    const result = redactSecrets("ANTHROPIC_API_KEY=sk-ant-abc1234567890abcdefghi");
    expect(result.text).toContain("[REDACTED_ANTHROPIC_KEY");
    expect(result.text).toContain("hash=");
    expect(result.findings[0]?.type).toBe("ANTHROPIC_KEY");
  });
});

describe("nested claude -p isolation", () => {
  const request = (overrides = {}) => ({
    projectRoot: "/nonexistent-project",
    config: defaultConfig,
    prompt: "user content",
    system: "selector policy",
    schema: { type: "object" },
    model: "opus",
    effort: "low",
    ...overrides
  });

  it("disables MCP servers and tools, not just built-in tools", async () => {
    const args = await nestedClaudeArgs(request());
    expect(args).toContain("--strict-mcp-config");
    const deny = args.indexOf("--disallowedTools");
    expect(args[deny + 1]).toBe("mcp__*");
    const tools = args.indexOf("--tools");
    expect(args[tools + 1]).toBe("");
  });

  it("passes the policy as the system prompt and the content as the prompt", async () => {
    const args = await nestedClaudeArgs(request());
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("selector policy");
    expect(args[args.indexOf("-p") + 1]).toBe("user content");
  });

  it("sets an explicit effort unless configured to inherit the user's", async () => {
    const explicit = await nestedClaudeArgs(request({ effort: "medium" }));
    expect(explicit[explicit.indexOf("--effort") + 1]).toBe("medium");
    const inherited = await nestedClaudeArgs(request({ effort: "default" }));
    expect(inherited).not.toContain("--effort");
  });

  it("keeps CLAUDE.md files and auto memory out of nested calls", () => {
    const env = nestedClaudeEnv({ PATH: "/bin" });
    expect(env).toMatchObject({
      PATH: "/bin",
      LEARNING_MOMENTS_INTERNAL: "1",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1"
    });
  });

  it("maps execFile failures to bounded reasons", () => {
    expect(execFailureReason({ code: "ENOENT" })).toBe("claude_not_found");
    expect(execFailureReason({ killed: true, signal: "SIGTERM" })).toBe("timeout");
    expect(execFailureReason({ code: 1, stdout: "Claude AI usage limit reached" })).toBe("rate_limited");
    expect(execFailureReason({ code: 1, stderr: "Not logged in. Please run /login" })).toBe("auth");
    expect(execFailureReason({ code: 2, stderr: "something else" })).toBe("exit_nonzero");
  });

  it("returns a failure category instead of throwing for call failures", async () => {
    const failed = await attemptClaudeCall(
      async () => {
        throw new ClaudeCallError("timeout", "slow", { wall_duration_ms: 45000 });
      },
      (output) => output
    );
    expect(failed).toEqual({ ok: false, reason: "timeout", metrics: { wall_duration_ms: 45000 } });

    const invalid = await attemptClaudeCall(
      async () => ({ output: { nope: true }, metrics: { total_cost_usd: 0.02 } }),
      () => {
        throw new Error("schema mismatch");
      }
    );
    expect(invalid).toEqual({ ok: false, reason: "invalid_output", metrics: { total_cost_usd: 0.02 } });
  });

  describe("against a stand-in claude executable", () => {
    let previousPath;
    let envelope;

    beforeEach(async () => {
      const bin = await tempDir();
      envelope = path.join(bin, "envelope.json");
      // Prints the envelope file and exits with the code in its name.
      await fs.writeFile(
        path.join(bin, "claude"),
        `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst [file, code] = fs.readFileSync(${JSON.stringify(envelope + ".target")}, "utf8").split("\\n");\nprocess.stdout.write(fs.readFileSync(file, "utf8"));\nprocess.exit(Number(code));\n`,
        { mode: 0o755 }
      );
      previousPath = process.env.PATH;
      process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
      delete process.env.LEARNING_MOMENTS_DISABLE_CLAUDE;
    });

    afterEach(() => {
      process.env.PATH = previousPath;
      process.env.LEARNING_MOMENTS_DISABLE_CLAUDE = "1";
    });

    async function respond(body, exitCode) {
      await fs.writeFile(envelope, JSON.stringify(body));
      await fs.writeFile(`${envelope}.target`, `${envelope}\n${exitCode}`);
    }

    const call = () =>
      runClaudeStructured({
        projectRoot: os.tmpdir(),
        config: defaultConfig,
        prompt: "content",
        system: "policy",
        schema: { type: "object" },
        model: "opus",
        effort: "low",
        timeoutSeconds: 20
      });

    it("keeps billed usage when the CLI exits nonzero after printing a result", async () => {
      await respond({ type: "result", is_error: true, result: "API Error: 500", total_cost_usd: 0.00014, usage: { output_tokens: 7 } }, 1);
      const error = await call().catch((caught) => caught);
      expect(error).toBeInstanceOf(ClaudeCallError);
      expect(error.reason).toBe("exit_nonzero");
      expect(error.metrics.total_cost_usd).toBe(0.00014);
      expect(error.metrics.output_tokens).toBe(7);
    });

    it("reports plain-text results without structured output as invalid output", async () => {
      await respond({ type: "result", result: "I cannot comply.", total_cost_usd: 0.002 }, 0);
      const error = await call().catch((caught) => caught);
      expect(error).toBeInstanceOf(ClaudeCallError);
      expect(error.reason).toBe("invalid_output");
      expect(error.metrics.total_cost_usd).toBe(0.002);
    });

    it("returns structured output and metrics from a successful call", async () => {
      await respond({ type: "result", structured_output: { ok: true }, total_cost_usd: 0.01 }, 0);
      await expect(call()).resolves.toMatchObject({ output: { ok: true }, metrics: { total_cost_usd: 0.01 } });
    });
  });

  it("lets programming errors propagate so they surface as hook errors", async () => {
    await expect(
      attemptClaudeCall(
        async () => {
          throw new TypeError("bug");
        },
        (output) => output
      )
    ).rejects.toThrow("bug");
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

describe("git-native hashing and workspace context", () => {
  it("gitHashObjects hashes existing files and returns null for missing ones", async () => {
    const root = await tempDir();
    git(["init", "-b", "main"], root);
    await fs.writeFile(path.join(root, "hello.txt"), "hello\n");
    const out = gitHashObjects(root, ["hello.txt", "does-not-exist.txt"]);
    // Git blob SHA-1 of "hello\n" is the well-known constant ce013625...
    expect(out["hello.txt"]).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(out["does-not-exist.txt"]).toBeNull();
  });

  it("gitHashObjects returns an empty map for an empty input list", async () => {
    const root = await tempDir();
    git(["init", "-b", "main"], root);
    expect(gitHashObjects(root, [])).toEqual({});
  });

  it("gitHashObjects uses a (size, mtime) metadata fingerprint for files over 1 MB", async () => {
    const root = await tempDir();
    git(["init", "-b", "main"], root);
    const big = path.join(root, "big.bin");
    // 2 MB — comfortably over MAX_HASH_BYTES (1 MB).
    await fs.writeFile(big, Buffer.alloc(2 * 1024 * 1024, 0x41));
    const out = gitHashObjects(root, ["big.bin"]);
    expect(out["big.bin"]).toMatch(/^meta:\d+:\d+$/);
    expect(out["big.bin"]).not.toMatch(/^[0-9a-f]{40}$/);
  });

  it("gitHashObjects's metadata fingerprint changes when a large file is rewritten", async () => {
    const root = await tempDir();
    git(["init", "-b", "main"], root);
    const big = path.join(root, "big.bin");
    await fs.writeFile(big, Buffer.alloc(2 * 1024 * 1024, 0x41));
    const before = gitHashObjects(root, ["big.bin"])["big.bin"];
    // sleep 10ms so the mtime is guaranteed to advance even on a filesystem
    // with coarse mtime resolution.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fs.writeFile(big, Buffer.alloc(2 * 1024 * 1024, 0x42));
    const after = gitHashObjects(root, ["big.bin"])["big.bin"];
    expect(after).not.toBe(before);
  });

  it("workspaceContext with config filters out ignored paths before hashing", async () => {
    const root = await tempDir();
    git(["init", "-b", "main"], root);
    await fs.writeFile(path.join(root, "tracked.txt"), "tracked\n");
    git(["add", "tracked.txt"], root);
    git(["commit", "-m", "initial"], root);

    await fs.writeFile(path.join(root, "tracked.txt"), "modified\n");
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(path.join(root, "dist", "bundle.js"), "// build artifact\n");

    const config = {
      ignore: { paths: ["dist/**"], extensions: [] }
    };
    const ctx = workspaceContext(root, config);
    expect(ctx.candidates).toContain("tracked.txt");
    expect(ctx.candidates).not.toContain("dist/bundle.js");
    const baseline = ctx.toBaseline();
    expect(baseline.hashes["dist/bundle.js"]).toBeUndefined();
    expect(baseline.hashes["tracked.txt"]).toMatch(/^[0-9a-f]{40}$/);
  });

  it("workspaceContext hashes lazily — content changes between build and toBaseline are reflected", async () => {
    const root = await tempDir();
    git(["init", "-b", "main"], root);
    await fs.writeFile(path.join(root, "a.txt"), "first\n");
    const ctx = workspaceContext(root);
    const firstHash = gitHashObjects(root, ["a.txt"])["a.txt"];
    // Now overwrite the file before materializing the baseline.
    await fs.writeFile(path.join(root, "a.txt"), "second\n");
    const baseline = ctx.toBaseline();
    const secondHash = gitHashObjects(root, ["a.txt"])["a.txt"];
    expect(firstHash).not.toBe(secondHash);
    expect(baseline.hashes["a.txt"]).toBe(secondHash);
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
    await fs.mkdir(dataDir(root));
    let ran = false;
    await withProjectLock(root, "regression", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    await expect(fs.stat(path.join(locksDir(root), "regression.lock"))).rejects.toThrow();
  });

  it("does not create the data directory of an uninitialized project", async () => {
    const root = await tempDir();
    await expect(withProjectLock(root, "regression", async () => undefined)).rejects.toThrow(/ENOENT/);
    await expect(fs.access(dataDir(root))).rejects.toThrow();
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

describe("changedSinceBaseline", () => {
  it("distinguishes changes since a baseline using git-native hashes", async () => {
    const root = await tempDir();
    git(["init", "-b", "main"], root);
    await fs.writeFile(path.join(root, "tracked.txt"), "one\n");
    git(["add", "tracked.txt"], root);
    git(["commit", "-m", "initial"], root);

    await fs.writeFile(path.join(root, "preexisting.txt"), "dirty\n");
    const baseline = workspaceContext(root).toBaseline();

    await fs.writeFile(path.join(root, "tracked.txt"), "two\n");
    await fs.writeFile(path.join(root, "new.txt"), "new\n");
    const current = workspaceContext(root).toBaseline();

    expect(changedSinceBaseline(baseline, current)).toEqual(["new.txt", "tracked.txt"]);
  });
});

describe("dirtyFiles", () => {
  it("records the new path for a staged rename, not the old one", async () => {
    const root = await tempDir();
    git(["init", "-b", "main"], root);
    await fs.writeFile(path.join(root, "original.txt"), "content\n");
    git(["add", "original.txt"], root);
    git(["commit", "-m", "initial"], root);
    git(["mv", "original.txt", "renamed.txt"], root);

    const dirty = dirtyFiles(root);
    expect(dirty).toContain("renamed.txt");
    expect(dirty).not.toContain("original.txt");
  });

  it("expands new directories into their individual untracked files", async () => {
    const root = await tempDir();
    git(["init", "-b", "main"], root);
    await fs.writeFile(path.join(root, "seed.txt"), "seed\n");
    git(["add", "seed.txt"], root);
    git(["commit", "-m", "initial"], root);

    await fs.mkdir(path.join(root, "newdir"), { recursive: true });
    await fs.writeFile(path.join(root, "newdir", "a.txt"), "a\n");
    await fs.writeFile(path.join(root, "newdir", "b.txt"), "b\n");

    const dirty = dirtyFiles(root);
    // Without --untracked-files=all this would just be ["newdir/"].
    expect(dirty).toContain("newdir/a.txt");
    expect(dirty).toContain("newdir/b.txt");
    expect(dirty).not.toContain("newdir/");
  });
});

describe("event-registry routing for session baselines", () => {
  it("routes session_baseline_created to the control file, not the ledger", async () => {
    const root = await tempDir();
    git(["init", "-b", "main"], root);
    invalidateMigrationCache();
    // Mark migration complete so appendEvent uses the class-routed paths.
    await fs.mkdir(dataDir(root), { recursive: true });
    await fs.writeFile(migrationCompletePath(root), "{}\n");

    await appendEvent(root, {
      type: "session_baseline_created",
      session_id: "s1",
      snapshot: { root, head: null, branch: null, candidates: [], hashes: {} }
    });

    const ledger = await readLedger(root);
    const control = await readControl(root);
    expect(ledger.find((e) => e.type === "session_baseline_created")).toBeUndefined();
    expect(control.find((e) => e.type === "session_baseline_created")).toBeDefined();
  });
});

describe("runInBackground", () => {
  it("resolves with the error instead of crashing when the process cannot start", async () => {
    const { runInBackground } = await import("../src/core/background.js");
    const previous = process.execPath;
    Object.defineProperty(process, "execPath", { value: "/nonexistent/node", configurable: true });
    try {
      const error = await runInBackground(["--version"]);
      expect(error?.code).toBe("ENOENT");
    } finally {
      Object.defineProperty(process, "execPath", { value: previous, configurable: true });
    }
  });

  it("resolves with null once the process has started", async () => {
    const { runInBackground } = await import("../src/core/background.js");
    await expect(runInBackground(["--version"])).resolves.toBeNull();
  });
});
