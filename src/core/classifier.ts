import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runClaudeStructured } from "./claude.js";
import type { LearningMomentsConfig } from "./config.js";
import { defaultProfile, defaultPrompts } from "./defaults.js";
import { profilePath, promptsDir } from "./paths.js";

export interface ClassifierInput {
  files: string[];
  diff: string;
}

export const classifierOutputSchema = z.object({
  eligible: z.boolean(),
  timing: z.enum(["ask_now", "ask_later"]),
  delivery: z.enum(["active", "silent_log_only", "discard"]),
  moment_type: z.enum(["predict", "test", "recall"]),
  learning_value: z.number().int().min(0).max(3),
  flow_cost: z.number().int().min(0).max(3),
  question: z.string(),
  expected_answer_outline: z.string(),
  reason: z.string(),
  recall: z.object({
    schedule: z.boolean(),
    prompt_seed: z.string(),
    delay: z.literal("next_session")
  }),
  storage: z.object({
    summary: z.string(),
    tags: z.array(z.string())
  })
});

export type ClassifierOutput = z.infer<typeof classifierOutputSchema>;

const classifierJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    eligible: { type: "boolean" },
    timing: { enum: ["ask_now", "ask_later"] },
    delivery: { enum: ["active", "silent_log_only", "discard"] },
    moment_type: { enum: ["predict", "test", "recall"] },
    learning_value: { type: "integer", minimum: 0, maximum: 3 },
    flow_cost: { type: "integer", minimum: 0, maximum: 3 },
    question: { type: "string" },
    expected_answer_outline: { type: "string" },
    reason: { type: "string" },
    recall: {
      type: "object",
      additionalProperties: false,
      properties: {
        schedule: { type: "boolean" },
        prompt_seed: { type: "string" },
        delay: { const: "next_session" }
      },
      required: ["schedule", "prompt_seed", "delay"]
    },
    storage: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string" },
        tags: { type: "array", items: { type: "string" } }
      },
      required: ["summary", "tags"]
    }
  },
  required: [
    "eligible",
    "timing",
    "delivery",
    "moment_type",
    "learning_value",
    "flow_cost",
    "question",
    "expected_answer_outline",
    "reason",
    "recall",
    "storage"
  ]
};

async function readTextOrDefault(filePath: string, fallback: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
}

function buildClassifierPrompt(profile: string, instruction: string, input: ClassifierInput): string {
  return [
    instruction.trim(),
    "",
    "User profile:",
    profile.trim(),
    "",
    "Changed files:",
    input.files.map((file) => `- ${file}`).join("\n"),
    "",
    "Redacted diff:",
    "```diff",
    input.diff,
    "```"
  ].join("\n");
}

export async function classifyCandidate(
  projectRoot: string,
  config: LearningMomentsConfig,
  input: ClassifierInput
): Promise<ClassifierOutput | null> {
  if (input.files.length === 0 || input.diff.trim().length === 0) {
    return null;
  }

  const [profile, instruction] = await Promise.all([
    readTextOrDefault(profilePath(projectRoot), defaultProfile),
    readTextOrDefault(
      path.join(promptsDir(projectRoot), "classify-change.md"),
      defaultPrompts["classify-change.md"] ?? ""
    )
  ]);

  try {
    const raw = await runClaudeStructured({
      projectRoot,
      config,
      prompt: buildClassifierPrompt(profile, instruction, input),
      schema: classifierJsonSchema,
      model: config.claude.classifier_model,
      timeoutSeconds: config.claude.classifier_timeout_seconds
    });
    return classifierOutputSchema.parse(raw);
  } catch {
    return null;
  }
}
