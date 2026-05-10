import fs from "node:fs/promises";
import { z } from "zod";
import { configPath } from "./paths.js";

export const contextStorageSchema = z.enum(["metadata_only", "excerpts", "full"]);
export const modeSchema = z.enum(["active", "observe_only"]);

export const configSchema = z.object({
  schema_version: z.literal(1),
  tool_version: z.string(),
  enabled: z.boolean(),
  paused: z.object({
    project: z.boolean(),
    sessions: z.record(z.string(), z.boolean())
  }),
  frequency: z.object({
    immediate_prompts_per_hour: z.number().int().min(0),
    minimum_minutes_between_immediate_prompts: z.number().int().min(0),
    session_start_recall_limit: z.number().int().min(0),
    classifier_calls_per_hour: z.number().int().min(0)
  }),
  mode: modeSchema,
  context_storage: contextStorageSchema,
  context_limits: z.object({
    max_diff_chars: z.number().int().min(0),
    max_file_excerpt_chars: z.number().int().min(0),
    max_transcript_excerpt_chars: z.number().int().min(0),
    max_paths: z.number().int().min(0)
  }),
  ignore: z.object({
    paths: z.array(z.string()),
    extensions: z.array(z.string()),
    generated_markers: z.array(z.string())
  }),
  confidence: z.object({
    enabled: z.boolean(),
    ask_when_useful: z.boolean()
  }),
  claude: z.object({
    classifier_model: z.string(),
    grading_model: z.string(),
    classifier_timeout_seconds: z.number().int().min(1),
    grader_timeout_seconds: z.number().int().min(1),
    no_hooks_settings_file: z.string(),
    use_bare_when_compatible: z.boolean()
  })
});

export type LearningMomentsConfig = z.infer<typeof configSchema>;

export const defaultConfig: LearningMomentsConfig = {
  schema_version: 1,
  tool_version: "0.1.0",
  enabled: true,
  paused: {
    project: false,
    sessions: {}
  },
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
    max_file_excerpt_chars: 8000,
    max_transcript_excerpt_chars: 4000,
    max_paths: 20
  },
  ignore: {
    paths: ["dist/**", "coverage/**", "node_modules/**"],
    extensions: [".lock"],
    generated_markers: ["@generated", "DO NOT EDIT"]
  },
  confidence: {
    enabled: true,
    ask_when_useful: true
  },
  claude: {
    classifier_model: "default",
    grading_model: "default",
    classifier_timeout_seconds: 20,
    grader_timeout_seconds: 20,
    no_hooks_settings_file: ".learning-moments/claude-no-hooks-settings.json",
    use_bare_when_compatible: false
  }
};

export async function loadConfig(projectRoot: string): Promise<LearningMomentsConfig> {
  const raw = await fs.readFile(configPath(projectRoot), "utf8");
  return configSchema.parse(JSON.parse(raw));
}

export async function writeConfig(
  projectRoot: string,
  config: LearningMomentsConfig
): Promise<void> {
  await fs.writeFile(configPath(projectRoot), `${JSON.stringify(config, null, 2)}\n`);
}
