import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/claude.js", () => ({
  runClaudeStructured: vi.fn()
}));

import { initCommand } from "../src/commands/init.js";
import { postToolBatchHook } from "../src/commands/hooks/post-tool-batch.js";
import { postToolUseHook } from "../src/commands/hooks/post-tool-use.js";
import { sessionStartHook } from "../src/commands/hooks/session-start.js";
import { stopHook } from "../src/commands/hooks/stop.js";
import { userPromptSubmitHook } from "../src/commands/hooks/user-prompt-submit.js";
import { ClaudeCallError } from "../src/core/claude-call.js";
import { runClaudeStructured } from "../src/core/claude.js";
import { loadConfig, writeConfig } from "../src/core/config.js";
import { runHook } from "../src/core/hook-runner.js";
import { appendEvent, readEvents } from "../src/core/log.js";
import { classifyReply } from "../src/core/reply.js";

let previousCwd;

const testMetrics = {
  wall_duration_ms: 1200,
  duration_ms: 1000,
  duration_api_ms: 900,
  total_cost_usd: 0.01,
  input_tokens: 100,
  output_tokens: 20,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  num_turns: 1,
  requested_model: "opus"
};

// Questions are chosen after a tool batch and asked when the turn ends.
async function batchThenStop(input) {
  const batch = await postToolBatchHook({ ...input, hook_event_name: "PostToolBatch", tool_calls: [] });
  expect(batch).toBeNull();
  return stopHook({ ...input, hook_event_name: "Stop", last_assistant_message: "Done." });
}

async function tempGitRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learning-moments-hook-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "test"], { cwd: root, stdio: "ignore" });
  await fs.writeFile(path.join(root, "README.md"), "before\n");
  execFileSync("git", ["add", "README.md"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  return root;
}

let previousProjectDir;

beforeEach(() => {
  previousCwd = process.cwd();
  // Hooks prefer CLAUDE_PROJECT_DIR; a value inherited from a Claude Code
  // session running the tests must not point them at a real project.
  previousProjectDir = process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  vi.mocked(runClaudeStructured).mockReset();
});

afterEach(() => {
  process.chdir(previousCwd);
  if (previousProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = previousProjectDir;
});

const eligibleClassification = {
  eligible: true,
  timing: "ask_now",
  delivery: "active",
  moment_type: "predict",
  learning_value: 3,
  flow_cost: 1,
  question: "What does the change do?",
  expected_answer_outline: "It changes the file.",
  reason: "A specific change worth a question.",
  recall: { schedule: false, prompt_seed: "", delay: "next_session" },
  storage: { summary: "A change.", tags: [] }
};

function hookInput(root, extra = {}) {
  return {
    session_id: "session-1",
    transcript_path: path.join(root, "transcript.jsonl"),
    cwd: root,
    permission_mode: "default",
    ...extra
  };
}

describe("hook scoping", () => {
  it("never creates data in a repository where init has not run", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await postToolUseHook(hookInput(root, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(root, "README.md") } }));
    await stopHook(hookInput(root, { hook_event_name: "Stop" }));
    await sessionStartHook(hookInput(root, { hook_event_name: "SessionStart", source: "startup" }));
    await runHook("stop", async () => {
      throw new Error("failure in an uninitialized repository");
    });
    process.exitCode = 0;
    await expect(fs.access(path.join(root, ".learning-moments"))).rejects.toThrow();
  });

  it("reads changes from a linked worktree and records them in the main checkout", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    const worktree = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "learning-moments-wt-")), "wt");
    execFileSync("git", ["worktree", "add", "-q", "-b", "feature", worktree], { cwd: root });
    const realWorktree = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: worktree, encoding: "utf8" }).trim();
    vi.mocked(runClaudeStructured).mockResolvedValueOnce({ output: eligibleClassification, metrics: testMetrics });

    await sessionStartHook(hookInput(worktree, { hook_event_name: "SessionStart", source: "startup" }));
    await fs.writeFile(path.join(worktree, "README.md"), "changed in the worktree\n");
    const output = await batchThenStop(hookInput(worktree));

    expect(output?.hookSpecificOutput.additionalContext).toContain("What does the change do?");
    expect(vi.mocked(runClaudeStructured).mock.calls[0][0].prompt).toContain("+changed in the worktree");
    const events = await readEvents(root);
    expect(events.find((event) => event.type === "session_baseline_created")?.snapshot.root).toBe(realWorktree);
    await expect(fs.access(path.join(worktree, ".learning-moments"))).rejects.toThrow();
  });

  it("keeps reading the session's project when Claude cds into another repository", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    const clone = await tempGitRepo();
    process.env.CLAUDE_PROJECT_DIR = root;
    vi.mocked(runClaudeStructured).mockResolvedValueOnce({ output: eligibleClassification, metrics: testMetrics });

    await sessionStartHook(hookInput(root, { hook_event_name: "SessionStart", source: "startup" }));
    await fs.writeFile(path.join(clone, "README.md"), "edited in the clone\n");
    await fs.writeFile(path.join(root, "README.md"), "edited in the project\n");
    await postToolBatchHook(hookInput(clone, { hook_event_name: "PostToolBatch", tool_calls: [] }));

    const prompt = vi.mocked(runClaudeStructured).mock.calls[0][0].prompt;
    expect(prompt).toContain("+edited in the project");
    expect(prompt).not.toContain("edited in the clone");
    await expect(fs.access(path.join(clone, ".learning-moments"))).rejects.toThrow();
  });

  it("keeps the main checkout when a worktree session's cwd moves elsewhere", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    const worktree = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "learning-moments-wt-")), "wt");
    execFileSync("git", ["worktree", "add", "-q", "-b", "feature", worktree], { cwd: root });
    const elsewhere = await tempGitRepo();
    process.env.CLAUDE_PROJECT_DIR = worktree;
    const realRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim();
    const realWorktree = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: worktree, encoding: "utf8" }).trim();

    const { resolveProject } = await import("../src/core/project.js");
    await expect(resolveProject(elsewhere)).resolves.toEqual({ dataRoot: realRoot, workRoot: realWorktree });
    await expect(resolveProject(os.tmpdir())).resolves.toEqual({ dataRoot: realRoot, workRoot: realWorktree });
    await expect(resolveProject(worktree)).resolves.toEqual({ dataRoot: realRoot, workRoot: realWorktree });
  });

  it("ignores tool batches that run inside a subagent", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    await sessionStartHook(hookInput(root, { hook_event_name: "SessionStart", source: "startup" }));
    await fs.writeFile(path.join(root, "README.md"), "after\n");

    const output = await postToolBatchHook(
      hookInput(root, { hook_event_name: "PostToolBatch", tool_calls: [], agent_id: "agent-abc123" })
    );
    expect(output).toBeNull();
    expect(runClaudeStructured).not.toHaveBeenCalled();
  });

  it("keeps the session baseline when SessionStart fires again after compaction", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    vi.mocked(runClaudeStructured).mockResolvedValueOnce({ output: eligibleClassification, metrics: testMetrics });

    await sessionStartHook(hookInput(root, { hook_event_name: "SessionStart", source: "startup" }));
    await fs.writeFile(path.join(root, "README.md"), "edited before compaction\n");
    await sessionStartHook(hookInput(root, { hook_event_name: "SessionStart", source: "compact" }));
    await postToolBatchHook(hookInput(root, { hook_event_name: "PostToolBatch", tool_calls: [] }));

    const baselines = (await readEvents(root)).filter((event) => event.type === "session_baseline_created");
    expect(baselines).toHaveLength(1);
    expect(vi.mocked(runClaudeStructured).mock.calls[0][0].prompt).toContain("+edited before compaction");
  });

  it("keeps working after an interrupted append leaves a damaged log line", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    await sessionStartHook(hookInput(root, { hook_event_name: "SessionStart", source: "startup" }));
    const control = path.join(root, ".learning-moments", "control.jsonl");
    await fs.appendFile(control, '{"id":"lm_event_partial","type":"session_basel');

    await stopHook(hookInput(root, { hook_event_name: "Stop", last_assistant_message: "done" }));
    await sessionStartHook(hookInput(root, { hook_event_name: "SessionStart", source: "startup", session_id: "session-2" }));

    // The damaged bytes stay on their own line for inspection, and the
    // next record starts on a fresh line instead of merging into them.
    const lines = (await fs.readFile(control, "utf8")).split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('{"id":"lm_event_partial","type":"session_basel');
    const events = await readEvents(root);
    expect(events.filter((event) => event.type === "session_baseline_created")).toHaveLength(2);
  });
});

describe("hook flow", () => {
  it("injects a question first and injects the rubric only after the user answers", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    vi.mocked(runClaudeStructured)
      .mockResolvedValueOnce({
        output: {
          eligible: true,
          timing: "ask_now",
          delivery: "active",
          moment_type: "predict",
          learning_value: 3,
          flow_cost: 1,
          question: "What changed in README.md, and how would you verify your understanding?",
          expected_answer_outline:
            "A strong answer names the README claim and proposes a concrete docs verification.",
          reason: "The documentation claim changed and is suitable for a brief understanding check.",
          recall: {
            schedule: true,
            prompt_seed: "What changed in README.md?",
            delay: "next_session"
          },
          storage: {
            summary: "README documentation claim changed.",
            tags: ["documentation", "verification"]
          }
        },
        metrics: testMetrics
      })
      .mockResolvedValueOnce({
        output: {
          grade: 3,
          label: "correct",
          feedback: "Correct: you identified the README claim and named a concrete verification.",
          reason: "The answer matched the expected outline.",
          confidence: 0.92
        },
        metrics: testMetrics
      });

    const common = {
      session_id: "session-1",
      transcript_path: path.join(root, "transcript.jsonl"),
      cwd: root,
      permission_mode: "default"
    };

    await sessionStartHook({
      ...common,
      hook_event_name: "SessionStart",
      source: "startup"
    });

    await fs.writeFile(path.join(root, "README.md"), "after\n");
    const askOutput = await batchThenStop(common);

    expect(askOutput?.hookSpecificOutput.additionalContext).toContain("Learning Moment `lm_");
    expect(askOutput?.hookSpecificOutput.additionalContext).not.toContain("Expected answer outline");

    const answerOutput = await userPromptSubmitHook({
      ...common,
      hook_event_name: "UserPromptSubmit",
      prompt: "The README claim changed, and I would verify the rendered docs or a docs test."
    });

    expect(answerOutput?.hookSpecificOutput.additionalContext).toContain("brief feedback");
    expect(answerOutput?.hookSpecificOutput.additionalContext).toContain("Correct:");
    expect(answerOutput?.hookSpecificOutput.additionalContext).toContain("The user just answered");

    const events = await readEvents(root);
    expect(events.map((event) => event.type)).toContain("session_baseline_created");
    expect(events.map((event) => event.type)).toContain("moment_created");
    expect(events.map((event) => event.type)).toContain("moment_injected");
    expect(events.map((event) => event.type)).toContain("answer_received");
    expect(events.map((event) => event.type)).toContain("classifier_completed");
    expect(events.map((event) => event.type)).toContain("grader_completed");
    expect(events.map((event) => event.type)).toContain("hook_completed");
    expect(events.map((event) => event.type)).toContain("grade_created");
    expect(runClaudeStructured).toHaveBeenCalledTimes(2);
  });

  it("fails open instead of asking a generic question when classification fails", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    vi.mocked(runClaudeStructured).mockRejectedValueOnce(
      new ClaudeCallError("timeout", "classifier unavailable", { wall_duration_ms: 45000 })
    );

    const common = {
      session_id: "session-1",
      transcript_path: path.join(root, "transcript.jsonl"),
      cwd: root,
      permission_mode: "default"
    };

    await sessionStartHook({
      ...common,
      hook_event_name: "SessionStart",
      source: "startup"
    });

    await fs.writeFile(path.join(root, "README.md"), "after\n");
    const askOutput = await postToolBatchHook({
      ...common,
      hook_event_name: "PostToolBatch",
      tool_calls: []
    });

    expect(askOutput).toBeNull();
    const events = await readEvents(root);
    const failure = events.find((event) => event.type === "classifier_failed_open");
    expect(failure?.failure_reason).toBe("timeout");
    expect(failure?.metrics).toEqual({ wall_duration_ms: 45000 });
    expect(events.map((event) => event.type)).not.toContain("moment_injected");
  });

  it("does not reclassify the same candidate fingerprint in one session", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    vi.mocked(runClaudeStructured).mockResolvedValueOnce({
      output: {
        eligible: false,
        timing: "ask_later",
        delivery: "discard",
        moment_type: "predict",
        learning_value: 0,
        flow_cost: 0,
        question: "",
        expected_answer_outline: "",
        reason: "Not worth interrupting.",
        recall: {
          schedule: false,
          prompt_seed: "",
          delay: "next_session"
        },
        storage: {
          summary: "Declined.",
          tags: []
        }
      },
      metrics: testMetrics
    });

    const common = {
      session_id: "session-1",
      transcript_path: path.join(root, "transcript.jsonl"),
      cwd: root,
      permission_mode: "default"
    };

    await sessionStartHook({
      ...common,
      hook_event_name: "SessionStart",
      source: "startup"
    });

    await fs.writeFile(path.join(root, "README.md"), "after\n");
    await postToolBatchHook({
      ...common,
      hook_event_name: "PostToolBatch",
      tool_calls: []
    });
    await postToolBatchHook({
      ...common,
      hook_event_name: "PostToolBatch",
      tool_calls: []
    });

    const events = await readEvents(root);
    expect(events.filter((event) => event.type === "classifier_called")).toHaveLength(1);
    expect(events.map((event) => event.type)).toContain("candidate_already_seen");
    expect(runClaudeStructured).toHaveBeenCalledTimes(1);
  });

  it("resets the baseline instead of classifying after branch or HEAD changes", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});

    const common = {
      session_id: "session-1",
      transcript_path: path.join(root, "transcript.jsonl"),
      cwd: root,
      permission_mode: "default"
    };

    await sessionStartHook({
      ...common,
      hook_event_name: "SessionStart",
      source: "startup"
    });

    await fs.writeFile(path.join(root, "other.txt"), "other\n");
    execFileSync("git", ["add", "other.txt"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "other"], { cwd: root, stdio: "ignore" });

    const output = await postToolBatchHook({
      ...common,
      hook_event_name: "PostToolBatch",
      tool_calls: []
    });

    expect(output).toBeNull();
    const events = await readEvents(root);
    expect(events.filter((event) => event.type === "session_baseline_created")).toHaveLength(2);
    expect(events.map((event) => event.type)).not.toContain("classifier_called");
  });

  it("session pause prevents SessionStart from taking a working-tree snapshot", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});

    const config = await loadConfig(root);
    config.paused.sessions["paused-session"] = true;
    await writeConfig(root, config);

    const common = {
      session_id: "paused-session",
      transcript_path: path.join(root, "transcript.jsonl"),
      cwd: root,
      permission_mode: "default"
    };

    await sessionStartHook({
      ...common,
      hook_event_name: "SessionStart",
      source: "startup"
    });

    const events = await readEvents(root);
    // No baseline event when paused — that's the whole point.
    expect(events.map((event) => event.type)).not.toContain("session_baseline_created");
    // The hook still emits hook_completed with the disabled_or_paused outcome
    // so the pause path is observable in metrics.
    const completed = events.find(
      (event) => event.type === "hook_completed" && event.hook_event_name === "SessionStart"
    );
    expect(completed?.outcome).toBe("disabled_or_paused");
  });

  it("session pause prevents PostToolBatch from calling the classifier", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});

    const config = await loadConfig(root);
    config.paused.sessions["paused-session"] = true;
    await writeConfig(root, config);

    const common = {
      session_id: "paused-session",
      transcript_path: path.join(root, "transcript.jsonl"),
      cwd: root,
      permission_mode: "default"
    };

    await sessionStartHook({
      ...common,
      hook_event_name: "SessionStart",
      source: "startup"
    });

    await fs.writeFile(path.join(root, "README.md"), "after\n");
    const output = await postToolBatchHook({
      ...common,
      hook_event_name: "PostToolBatch",
      tool_calls: []
    });

    expect(output).toBeNull();
    expect(runClaudeStructured).not.toHaveBeenCalled();
    const events = await readEvents(root);
    expect(events.map((event) => event.type)).not.toContain("classifier_called");
    expect(events.some((event) => event.outcome === "disabled_or_paused")).toBe(true);
  });

  it("session pause prevents UserPromptSubmit from grading a pending answer", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    vi.mocked(runClaudeStructured).mockResolvedValueOnce({
      output: {
        eligible: true,
        timing: "ask_now",
        delivery: "active",
        moment_type: "predict",
        learning_value: 3,
        flow_cost: 1,
        question: "What changed?",
        expected_answer_outline: "The README.",
        reason: "Useful.",
        recall: { schedule: false, prompt_seed: "", delay: "next_session" },
        storage: { summary: "x", tags: [] }
      },
      metrics: testMetrics
    });

    const common = {
      session_id: "session-1",
      transcript_path: path.join(root, "transcript.jsonl"),
      cwd: root,
      permission_mode: "default"
    };

    await sessionStartHook({ ...common, hook_event_name: "SessionStart", source: "startup" });
    await fs.writeFile(path.join(root, "README.md"), "after\n");
    await batchThenStop(common);

    const config = await loadConfig(root);
    config.paused.sessions["session-1"] = true;
    await writeConfig(root, config);

    vi.mocked(runClaudeStructured).mockClear();
    const answer = await userPromptSubmitHook({
      ...common,
      hook_event_name: "UserPromptSubmit",
      prompt: "The README changed."
    });

    expect(answer).toBeNull();
    expect(runClaudeStructured).not.toHaveBeenCalled();
    const events = await readEvents(root);
    expect(events.map((event) => event.type)).not.toContain("grade_created");
    expect(events.map((event) => event.type)).not.toContain("answer_received");
  });

  it("refilters changes against a baseline saved before a path was excluded", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    await sessionStartHook({ session_id: "session-1", cwd: root, hook_event_name: "SessionStart", source: "startup" });
    const real = (await readEvents(root)).find((event) => event.type === "session_baseline_created").snapshot;
    // The same baseline as an older version would have written it, still
    // treating these dirty paths as candidates.
    await appendEvent(root, {
      type: "session_baseline_created",
      session_id: "session-1",
      cwd: root,
      snapshot: {
        ...real,
        candidates: [...real.candidates, ".env", ".learning-moments/ledger.jsonl"],
        hashes: {
          ...real.hashes,
          ".env": "0000000000000000000000000000000000000000",
          ".learning-moments/ledger.jsonl": "1111111111111111111111111111111111111111"
        }
      }
    });
    await fs.writeFile(path.join(root, ".env"), "API_TOKEN=unchanged\n");

    const output = await postToolBatchHook({
      session_id: "session-1",
      cwd: root,
      hook_event_name: "PostToolBatch",
      tool_calls: []
    });
    expect(output).toBeNull();
    expect(runClaudeStructured).not.toHaveBeenCalled();
  });

  it("records a hook_error event and exits cleanly when a hook throws", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});

    const previousExitCode = process.exitCode;
    const previousDebug = process.env.LEARNING_MOMENTS_DEBUG;
    delete process.env.LEARNING_MOMENTS_DEBUG;
    try {
      await runHook("post-tool-use", async () => {
        throw new Error("synthetic failure for test");
      });
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      if (previousDebug === undefined) delete process.env.LEARNING_MOMENTS_DEBUG;
      else process.env.LEARNING_MOMENTS_DEBUG = previousDebug;
    }

    const events = await readEvents(root);
    const errorEvent = events.find((event) => event.type === "hook_error");
    expect(errorEvent).toBeTruthy();
    expect(errorEvent.hook_event_name).toBe("post-tool-use");
    expect(errorEvent.error_message).toContain("synthetic failure for test");
    expect(typeof errorEvent.duration_ms).toBe("number");
    expect(errorEvent.error_stack).toBeUndefined();
  });

  it("includes the stack in hook_error events when LEARNING_MOMENTS_DEBUG=1", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});

    const previousExitCode = process.exitCode;
    const previousDebug = process.env.LEARNING_MOMENTS_DEBUG;
    process.env.LEARNING_MOMENTS_DEBUG = "1";
    try {
      await runHook("post-tool-use", async () => {
        throw new Error("debug-mode failure");
      });
    } finally {
      process.exitCode = previousExitCode;
      if (previousDebug === undefined) delete process.env.LEARNING_MOMENTS_DEBUG;
      else process.env.LEARNING_MOMENTS_DEBUG = previousDebug;
    }

    const events = await readEvents(root);
    const errorEvent = events.find((event) => event.type === "hook_error");
    expect(errorEvent).toBeTruthy();
    expect(errorEvent.error_message).toBe("debug-mode failure");
    expect(typeof errorEvent.error_stack).toBe("string");
    expect(errorEvent.error_stack).toContain("debug-mode failure");
  });

  it("silences a moment when the classifier returns timing=ask_later", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    vi.mocked(runClaudeStructured).mockResolvedValueOnce({
      output: {
        eligible: true,
        timing: "ask_later",
        delivery: "active",
        moment_type: "predict",
        learning_value: 3,
        flow_cost: 1,
        question: "Worth asking eventually but not now.",
        expected_answer_outline: "An answer outline.",
        reason: "Useful but not interrupt-worthy right this second.",
        recall: { schedule: false, prompt_seed: "", delay: "next_session" },
        storage: { summary: "x", tags: [] }
      },
      metrics: testMetrics
    });

    const common = {
      session_id: "session-asklater",
      transcript_path: path.join(root, "transcript.jsonl"),
      cwd: root,
      permission_mode: "default"
    };

    await sessionStartHook({ ...common, hook_event_name: "SessionStart", source: "startup" });
    await fs.writeFile(path.join(root, "README.md"), "after\n");
    const output = await postToolBatchHook({
      ...common,
      hook_event_name: "PostToolBatch",
      tool_calls: []
    });

    expect(output).toBeNull();
    const events = await readEvents(root);
    const silenced = events.find((event) => event.type === "moment_silenced");
    expect(silenced).toBeTruthy();
    expect(silenced.reason).toBe("ask_later");
    expect(events.map((event) => event.type)).not.toContain("moment_injected");
  });

  it("redacts secrets in user answers before logging or grading", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    vi.mocked(runClaudeStructured)
      .mockResolvedValueOnce({
        output: {
          eligible: true,
          timing: "ask_now",
          delivery: "active",
          moment_type: "predict",
          learning_value: 3,
          flow_cost: 1,
          question: "What changed?",
          expected_answer_outline: "The README.",
          reason: "Useful.",
          recall: { schedule: false, prompt_seed: "", delay: "next_session" },
          storage: { summary: "x", tags: [] }
        },
        metrics: testMetrics
      })
      .mockResolvedValueOnce({
        output: {
          grade: 2,
          label: "partially_correct",
          feedback: "ok",
          reason: "Partial.",
          confidence: 0.8
        },
        metrics: testMetrics
      });

    const common = {
      session_id: "session-redact",
      transcript_path: path.join(root, "transcript.jsonl"),
      cwd: root,
      permission_mode: "default"
    };

    await sessionStartHook({ ...common, hook_event_name: "SessionStart", source: "startup" });
    await fs.writeFile(path.join(root, "README.md"), "after\n");
    await batchThenStop(common);

    const FAKE_KEY = "sk-ant-abc1234567890abcdefghi";
    await userPromptSubmitHook({
      ...common,
      hook_event_name: "UserPromptSubmit",
      prompt: `I added my key ${FAKE_KEY} to the README`
    });

    const events = await readEvents(root);
    const answer = events.find((event) => event.type === "answer_received");
    expect(answer).toBeTruthy();
    expect(answer.answer_text).not.toContain(FAKE_KEY);
    expect(answer.answer_text).toContain("[REDACTED_ANTHROPIC_KEY");
    expect(Array.isArray(answer.redaction_findings)).toBe(true);
    expect(answer.redaction_findings[0]?.type).toBe("ANTHROPIC_KEY");

    const graderCall = vi.mocked(runClaudeStructured).mock.calls[1];
    expect(graderCall[0].prompt).not.toContain(FAKE_KEY);
    expect(graderCall[0].prompt).toContain("[REDACTED_ANTHROPIC_KEY");
  });

  it("logs visible feedback observation separately from question observation", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    vi.mocked(runClaudeStructured)
      .mockResolvedValueOnce({
        output: {
          eligible: true,
          timing: "ask_now",
          delivery: "active",
          moment_type: "predict",
          learning_value: 3,
          flow_cost: 1,
          question: "What changed in README.md?",
          expected_answer_outline: "The README changed.",
          reason: "Useful documentation check.",
          recall: {
            schedule: false,
            prompt_seed: "",
            delay: "next_session"
          },
          storage: {
            summary: "README changed.",
            tags: ["docs"]
          }
        },
        metrics: testMetrics
      })
      .mockResolvedValueOnce({
        output: {
          grade: 2,
          label: "partially_correct",
          feedback: "Partially correct: you named the file but not the verification.",
          reason: "Incomplete verification.",
          confidence: 0.8
        },
        metrics: testMetrics
      });

    const common = {
      session_id: "session-1",
      transcript_path: path.join(root, "transcript.jsonl"),
      cwd: root,
      permission_mode: "default"
    };

    await sessionStartHook({
      ...common,
      hook_event_name: "SessionStart",
      source: "startup"
    });
    await fs.writeFile(path.join(root, "README.md"), "after\n");
    await batchThenStop(common);
    await userPromptSubmitHook({
      ...common,
      hook_event_name: "UserPromptSubmit",
      prompt: "README.md changed."
    });
    await stopHook({
      ...common,
      hook_event_name: "Stop",
      last_assistant_message: "Partially correct: you named the file but not the verification."
    });

    const events = await readEvents(root);
    expect(events.map((event) => event.type)).toContain("feedback_observed");
  });
});

async function injectMoment(root) {
  vi.mocked(runClaudeStructured).mockResolvedValueOnce({ output: eligibleClassification, metrics: testMetrics });
  await sessionStartHook(hookInput(root, { hook_event_name: "SessionStart", source: "startup" }));
  await fs.writeFile(path.join(root, "README.md"), `after ${Math.random()}\n`);
  const output = await batchThenStop(hookInput(root));
  expect(output?.hookSpecificOutput.additionalContext).toContain("What does the change do?");
}

const reply = (root, prompt) => userPromptSubmitHook(hookInput(root, { hook_event_name: "UserPromptSubmit", prompt }));

describe("classifyReply", () => {
  it.each([
    ["/learning-moments:pause", "pause"],
    ["/compact focus on tests", "command"],
    ["/dev/null is where the output goes", "answer"],
    ["<task-notification><task-id>abc</task-id>", "automatic"],
    ["skip", "skip"],
    ["Not now.", "skip"],
    ["pass the token through the job instead", "answer"],
    ["Proceed", "continue"],
    ["I'm not sure", "dont_know"],
    ["idk, maybe it retries?", "dont_know"],
    ["It reverts only on network errors, because fetch resolves on a 422", "answer"]
  ])("%s -> %s", (text, kind) => {
    expect(classifyReply(text)).toBe(kind);
  });
});

describe("answer capture", () => {
  it("treats the pause command as declining the question, without grading it", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    await injectMoment(root);

    expect(await reply(root, "/learning-moments:pause")).toBeNull();
    const events = await readEvents(root);
    expect(events.find((event) => event.type === "skip_recorded")?.skip_kind).toBe("pause");
    expect(events.map((event) => event.type)).not.toContain("answer_received");
    expect(runClaudeStructured).toHaveBeenCalledTimes(1);
  });

  it("leaves the question open across other commands and automatic prompts", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    await injectMoment(root);

    expect(await reply(root, "/compact")).toBeNull();
    expect(await reply(root, "<task-notification>agent finished</task-notification>")).toBeNull();
    vi.mocked(runClaudeStructured).mockResolvedValueOnce({
      output: { grade: 3, label: "correct", feedback: "Right.", reason: "Matches.", confidence: 0.9 },
      metrics: testMetrics
    });
    const output = await reply(root, "It changes the README text");
    expect(output?.hookSpecificOutput.additionalContext).toContain("Right.");
    const answers = (await readEvents(root)).filter((event) => event.type === "answer_received");
    expect(answers.map((event) => event.answer_text)).toEqual(["It changes the README text"]);
  });

  it("keeps a seen question open when a command's turn ends without its ID", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    await injectMoment(root);
    const stop = (message) => stopHook(hookInput(root, { hook_event_name: "Stop", last_assistant_message: message }));
    const shortId = (await readEvents(root)).find((event) => event.type === "moment_injected").short_id;

    await stop(`Learning Moment ${shortId}: What does the change do?`);
    expect(await reply(root, "/learning-moments:status")).toBeNull();
    await stop("Learning Moments is enabled.");
    vi.mocked(runClaudeStructured).mockResolvedValueOnce({
      output: { grade: 2, label: "partially_correct", feedback: "Close.", reason: "Partly.", confidence: 0.8 },
      metrics: testMetrics
    });
    expect((await reply(root, "It edits the README"))?.hookSpecificOutput.additionalContext).toContain("Close.");
    const events = await readEvents(root);
    expect(events.map((event) => event.type)).not.toContain("moment_injection_missed");
  });

  it("explains instead of grading when the developer says they don't know", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    await injectMoment(root);

    const output = await reply(root, "I'm not sure");
    expect(output?.hookSpecificOutput.additionalContext).toContain("It changes the file.");
    expect(runClaudeStructured).toHaveBeenCalledTimes(1);
    const grade = (await readEvents(root)).find((event) => event.type === "grade_created");
    expect(grade).toMatchObject({ label: "dont_know", source: "rule" });
  });

  it("records a skip when the developer just asks Claude to continue", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    await injectMoment(root);

    expect(await reply(root, "Proceed")).toBeNull();
    const events = await readEvents(root);
    expect(events.find((event) => event.type === "skip_recorded")?.skip_kind).toBe("continue");
    expect(events.map((event) => event.type)).not.toContain("grade_created");
  });

  it("gives no feedback when the grader finds the message was not an answer", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    await injectMoment(root);
    vi.mocked(runClaudeStructured).mockResolvedValueOnce({
      output: { grade: 0, label: "not_an_answer", feedback: "", reason: "A new instruction.", confidence: 0.9 },
      metrics: testMetrics
    });

    expect(await reply(root, "Now rename the helper and update its callers")).toBeNull();
    const events = await readEvents(root);
    expect(events.find((event) => event.type === "grade_created")?.label).toBe("not_an_answer");
    expect(events.map((event) => event.type)).not.toContain("feedback_injected");
  });

  it("stops treating messages as answers once a question is two hours old", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    await appendEvent(root, {
      type: "moment_injected",
      moment_id: "lm_moment_old_abcd",
      short_id: "lm_abcd",
      session_id: "session-1",
      question: "Old question?",
      timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    });

    expect(await reply(root, "Something unrelated")).toBeNull();
    expect(runClaudeStructured).not.toHaveBeenCalled();
  });

  it("does not ask a second question while one is still open", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    const config = await loadConfig(root);
    config.frequency.minimum_minutes_between_immediate_prompts = 0;
    config.frequency.immediate_prompts_per_hour = 10;
    await writeConfig(root, config);
    await injectMoment(root);

    vi.mocked(runClaudeStructured).mockResolvedValueOnce({ output: eligibleClassification, metrics: testMetrics });
    await fs.writeFile(path.join(root, "README.md"), "a second change\n");
    expect(await postToolBatchHook(hookInput(root, { hook_event_name: "PostToolBatch", tool_calls: [] }))).toBeNull();
    const silenced = (await readEvents(root)).find((event) => event.type === "moment_silenced");
    expect(silenced?.reason).toBe("question_pending");
  });
});

describe("end-of-turn questions", () => {
  async function readyMoment(root) {
    vi.mocked(runClaudeStructured).mockResolvedValueOnce({ output: eligibleClassification, metrics: testMetrics });
    await sessionStartHook(hookInput(root, { hook_event_name: "SessionStart", source: "startup" }));
    await fs.writeFile(path.join(root, "README.md"), "after\n");
    expect(await postToolBatchHook(hookInput(root, { hook_event_name: "PostToolBatch", tool_calls: [] }))).toBeNull();
  }
  const stop = (root, extra = {}) =>
    stopHook(hookInput(root, { hook_event_name: "Stop", last_assistant_message: "Done.", ...extra }));

  it("selects a question during the turn and asks it once the turn ends", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    await readyMoment(root);
    let events = await readEvents(root);
    expect(events.map((event) => event.type)).toContain("moment_ready");
    expect(events.map((event) => event.type)).not.toContain("moment_injected");

    const output = await stop(root);
    const context = output?.hookSpecificOutput.additionalContext;
    expect(output?.hookSpecificOutput.hookEventName).toBe("Stop");
    expect(context).toMatch(/Learning Moment `lm_[0-9a-f]{4}`: What does the change do\?/);
    expect(context).not.toContain("It changes the file.");
    expect(context).not.toMatch(/^(Ask|Wait|Include)\b/m);

    // The continuation's own Stop neither asks again nor loses the question.
    expect(await stop(root, { stop_hook_active: true, last_assistant_message: "What does the change do?" })).toBeNull();
    events = await readEvents(root);
    expect(events.find((event) => event.type === "moment_injected")?.delivery).toBe("stop");
    expect(events.find((event) => event.type === "question_observed")).toMatchObject({ relayed: false });
  });

  it("records the question as seen only once while it stays open", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    await readyMoment(root);
    await stop(root);
    await stop(root, { stop_hook_active: true });
    await stop(root);
    await stop(root);
    const observed = (await readEvents(root)).filter((event) => event.type === "question_observed");
    expect(observed).toHaveLength(1);
  });

  it("does not ask from the Stop that ends a hook-started continuation", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    await readyMoment(root);
    expect(await stop(root, { stop_hook_active: true })).toBeNull();
    expect(await stop(root)).not.toBeNull();
  });

  it("expires a question that waited too long for the turn to end", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    await appendEvent(root, {
      type: "moment_ready",
      moment_id: "lm_moment_stale_abcd",
      short_id: "lm_abcd",
      session_id: "session-1",
      question: "Stale?",
      files: [],
      timestamp: new Date(Date.now() - 31 * 60 * 1000).toISOString()
    });
    expect(await stop(root)).toBeNull();
    const events = await readEvents(root);
    expect(events.find((event) => event.type === "moment_expired")?.moment_id).toBe("lm_moment_stale_abcd");
    expect(events.map((event) => event.type)).not.toContain("moment_injected");
  });

  it("does not ask while the project is paused", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    await readyMoment(root);
    const config = await loadConfig(root);
    config.paused.project = true;
    await writeConfig(root, config);
    expect(await stop(root)).toBeNull();
  });

  it("skips classification while a selected question is waiting", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    await readyMoment(root);
    await fs.writeFile(path.join(root, "README.md"), "another change\n");
    await postToolBatchHook(hookInput(root, { hook_event_name: "PostToolBatch", tool_calls: [] }));
    expect(runClaudeStructured).toHaveBeenCalledTimes(1);
  });

  it("lets overlapping batches spend the last classifier call only once", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    const config = await loadConfig(root);
    config.frequency.classifier_calls_per_hour = 1;
    await writeConfig(root, config);
    const declined = { ...eligibleClassification, eligible: false, delivery: "discard" };
    vi.mocked(runClaudeStructured).mockResolvedValue({ output: declined, metrics: testMetrics });
    for (const session of ["session-a", "session-b"]) {
      await sessionStartHook(hookInput(root, { hook_event_name: "SessionStart", source: "startup", session_id: session }));
    }
    await fs.writeFile(path.join(root, "README.md"), "after\n");

    await Promise.all(
      ["session-a", "session-b"].map((session) =>
        postToolBatchHook(hookInput(root, { hook_event_name: "PostToolBatch", tool_calls: [], session_id: session }))
      )
    );
    expect(runClaudeStructured).toHaveBeenCalledTimes(1);
    vi.mocked(runClaudeStructured).mockReset();
  });

  it("installs the selection hook to run in the background", async () => {
    const root = await tempGitRepo();
    process.chdir(root);
    await initCommand({});
    const settings = JSON.parse(await fs.readFile(path.join(root, ".claude", "settings.local.json"), "utf8"));
    const entry = (event) => settings.hooks[event].flatMap((group) => group.hooks)[0];
    expect(entry("PostToolBatch").async).toBe(true);
    expect(entry("PostToolUse").async).toBe(true);
    expect(entry("Stop").async).toBeUndefined();
    expect(entry("UserPromptSubmit").async).toBeUndefined();
  });
});
