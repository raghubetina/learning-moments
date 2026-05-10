import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runClaudeStructured } from "./claude.js";
import type { LearningMomentsConfig } from "./config.js";
import { defaultPrompts } from "./defaults.js";
import { promptsDir } from "./paths.js";

export interface GradeInput {
  question: string;
  expectedAnswerOutline?: string;
  answer: string;
  files: string[];
}

export const gradeOutputSchema = z.object({
  grade: z.number().int().min(0).max(3),
  label: z.enum(["correct", "partially_correct", "likely_incorrect", "unclear"]),
  feedback: z.string(),
  reason: z.string(),
  confidence: z.number().min(0).max(1)
});

export type GradeOutput = z.infer<typeof gradeOutputSchema>;

const gradeJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    grade: { type: "integer", minimum: 0, maximum: 3 },
    label: { enum: ["correct", "partially_correct", "likely_incorrect", "unclear"] },
    feedback: { type: "string" },
    reason: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  },
  required: ["grade", "label", "feedback", "reason", "confidence"]
};

async function readTextOrDefault(filePath: string, fallback: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
}

function buildGradePrompt(instruction: string, input: GradeInput): string {
  return [
    instruction.trim(),
    "",
    "Grade the user's answer to this Learning Moment. Be fair and concise.",
    "Use grade 3 for a correct, specific answer; 2 for mostly correct but incomplete; 1 for weak or vague; 0 for incorrect or missing.",
    "The feedback should be one short sentence the coding assistant can pass to the user.",
    "",
    "Question:",
    input.question,
    "",
    "Expected answer outline:",
    input.expectedAnswerOutline ?? "(none recorded)",
    "",
    "Changed files:",
    input.files.map((file) => `- ${file}`).join("\n"),
    "",
    "User answer:",
    input.answer
  ].join("\n");
}

export async function gradeAnswer(
  projectRoot: string,
  config: LearningMomentsConfig,
  input: GradeInput
): Promise<GradeOutput | null> {
  const instruction = await readTextOrDefault(
    path.join(promptsDir(projectRoot), "grade-answer.md"),
    defaultPrompts["grade-answer.md"] ?? ""
  );

  try {
    const raw = await runClaudeStructured({
      projectRoot,
      config,
      prompt: buildGradePrompt(instruction, input),
      schema: gradeJsonSchema,
      model: config.claude.grading_model,
      timeoutSeconds: config.claude.grader_timeout_seconds
    });
    return gradeOutputSchema.parse(raw);
  } catch {
    return null;
  }
}
