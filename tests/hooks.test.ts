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
import { sessionStartHook } from "../src/commands/hooks/session-start.js";
import { stopHook } from "../src/commands/hooks/stop.js";
import { userPromptSubmitHook } from "../src/commands/hooks/user-prompt-submit.js";
import { runClaudeStructured } from "../src/core/claude.js";
import { readEvents } from "../src/core/log.js";

let previousCwd: string;

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

async function tempGitRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learning-moments-hook-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  await fs.writeFile(path.join(root, "README.md"), "before\n");
  execFileSync("git", ["add", "README.md"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  return root;
}

beforeEach(() => {
  previousCwd = process.cwd();
  vi.mocked(runClaudeStructured).mockReset();
});

afterEach(() => {
  process.chdir(previousCwd);
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
    const askOutput = await postToolBatchHook({
      ...common,
      hook_event_name: "PostToolBatch",
      tool_calls: []
    });

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
    vi.mocked(runClaudeStructured).mockRejectedValueOnce(new Error("classifier unavailable"));

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
    expect(events.map((event) => event.type)).toContain("classifier_failed_open");
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
    await postToolBatchHook({
      ...common,
      hook_event_name: "PostToolBatch",
      tool_calls: []
    });
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
