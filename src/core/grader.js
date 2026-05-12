import fs from "node:fs/promises";
import path from "node:path";
import { runClaudeStructured } from "./claude.js";
import { defaultPrompts } from "./defaults.js";
import { promptsDir } from "./paths.js";
import {
  assertEnum,
  assertInteger,
  assertNumber,
  assertObject,
  assertString
} from "./validate.js";

const GRADE_LABELS = ["correct", "partially_correct", "likely_incorrect", "unclear"];

function parseGradeOutput(raw, loc = "grade") {
  const obj = assertObject(raw, loc);
  const grade = assertInteger(obj.grade, `${loc}.grade`);
  if (grade < 0 || grade > 3) {
    throw new Error(`${loc}.grade: expected 0..3, got ${grade}`);
  }
  const confidence = assertNumber(obj.confidence, `${loc}.confidence`);
  if (confidence < 0 || confidence > 1) {
    throw new Error(`${loc}.confidence: expected 0..1, got ${confidence}`);
  }
  return {
    grade,
    label: assertEnum(obj.label, GRADE_LABELS, `${loc}.label`),
    feedback: assertString(obj.feedback, `${loc}.feedback`),
    reason: assertString(obj.reason, `${loc}.reason`),
    confidence
  };
}

const gradeJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    grade: { type: "integer", minimum: 0, maximum: 3 },
    label: { enum: GRADE_LABELS },
    feedback: { type: "string" },
    reason: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  },
  required: ["grade", "label", "feedback", "reason", "confidence"]
};

async function readTextOrDefault(filePath, fallback) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
}

function buildGradePrompt(instruction, input) {
  return [
    instruction.trim(),
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

export async function gradeAnswer(projectRoot, config, input) {
  const instruction = await readTextOrDefault(
    path.join(promptsDir(projectRoot), "grade-answer.md"),
    defaultPrompts["grade-answer.md"] ?? ""
  );

  try {
    const result = await runClaudeStructured({
      projectRoot,
      config,
      prompt: buildGradePrompt(instruction, input),
      schema: gradeJsonSchema,
      model: config.claude.grading_model,
      timeoutSeconds: config.claude.grader_timeout_seconds
    });
    return {
      grade: parseGradeOutput(result.output),
      metrics: result.metrics
    };
  } catch {
    return null;
  }
}
