import fs from "node:fs/promises";
import path from "node:path";
import { runClaudeStructured } from "./claude.js";
import { defaultProfile, defaultPrompts } from "./defaults.js";
import { profilePath, promptsDir } from "./paths.js";
import {
  assertArray,
  assertBoolean,
  assertEnum,
  assertInteger,
  assertObject,
  assertString
} from "./validate.js";

const TIMING = ["ask_now", "ask_later"];
const DELIVERY = ["active", "silent_log_only", "discard"];
const MOMENT_TYPE = ["predict", "test", "recall"];

function parseClassifierOutput(raw, loc = "classifier") {
  const obj = assertObject(raw, loc);
  const learning_value = assertInteger(obj.learning_value, `${loc}.learning_value`);
  if (learning_value < 0 || learning_value > 3) {
    throw new Error(`${loc}.learning_value: expected 0..3, got ${learning_value}`);
  }
  const flow_cost = assertInteger(obj.flow_cost, `${loc}.flow_cost`);
  if (flow_cost < 0 || flow_cost > 3) {
    throw new Error(`${loc}.flow_cost: expected 0..3, got ${flow_cost}`);
  }

  const recall = assertObject(obj.recall, `${loc}.recall`);
  const recallParsed = {
    schedule: assertBoolean(recall.schedule, `${loc}.recall.schedule`),
    prompt_seed: assertString(recall.prompt_seed, `${loc}.recall.prompt_seed`),
    delay: assertEnum(recall.delay, ["next_session"], `${loc}.recall.delay`)
  };

  const storage = assertObject(obj.storage, `${loc}.storage`);
  const tags = assertArray(storage.tags, `${loc}.storage.tags`);
  tags.forEach((tag, i) => assertString(tag, `${loc}.storage.tags[${i}]`));

  return {
    eligible: assertBoolean(obj.eligible, `${loc}.eligible`),
    timing: assertEnum(obj.timing, TIMING, `${loc}.timing`),
    delivery: assertEnum(obj.delivery, DELIVERY, `${loc}.delivery`),
    moment_type: assertEnum(obj.moment_type, MOMENT_TYPE, `${loc}.moment_type`),
    learning_value,
    flow_cost,
    question: assertString(obj.question, `${loc}.question`),
    expected_answer_outline: assertString(obj.expected_answer_outline, `${loc}.expected_answer_outline`),
    reason: assertString(obj.reason, `${loc}.reason`),
    recall: recallParsed,
    storage: {
      summary: assertString(storage.summary, `${loc}.storage.summary`),
      tags
    }
  };
}

const classifierJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    eligible: { type: "boolean" },
    timing: { enum: TIMING },
    delivery: { enum: DELIVERY },
    moment_type: { enum: MOMENT_TYPE },
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

async function readTextOrDefault(filePath, fallback) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
}

function buildClassifierPrompt(profile, instruction, input) {
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

export async function classifyCandidate(projectRoot, config, input) {
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
    const result = await runClaudeStructured({
      projectRoot,
      config,
      prompt: buildClassifierPrompt(profile, instruction, input),
      schema: classifierJsonSchema,
      model: config.claude.classifier_model,
      timeoutSeconds: config.claude.classifier_timeout_seconds
    });
    return {
      classification: parseClassifierOutput(result.output),
      metrics: result.metrics
    };
  } catch {
    return null;
  }
}
