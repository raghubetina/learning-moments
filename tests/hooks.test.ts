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
import { userPromptSubmitHook } from "../src/commands/hooks/user-prompt-submit.js";
import { runClaudeStructured } from "../src/core/claude.js";
import { readEvents } from "../src/core/log.js";

let previousCwd: string;

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
      })
      .mockResolvedValueOnce({
        grade: 3,
        label: "correct",
        feedback: "Correct: you identified the README claim and named a concrete verification.",
        reason: "The answer matched the expected outline.",
        confidence: 0.92
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
});
