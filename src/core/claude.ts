import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { LearningMomentsConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export interface ClaudeStructuredRequest {
  projectRoot: string;
  config: LearningMomentsConfig;
  prompt: string;
  schema: Record<string, unknown>;
  model: string;
  timeoutSeconds: number;
}

export interface ClaudeCallMetrics {
  wall_duration_ms: number;
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  num_turns?: number;
  requested_model: string;
  model_usage?: unknown;
}

export interface ClaudeStructuredResult {
  output: unknown;
  metrics: ClaudeCallMetrics;
}

async function settingsArgument(projectRoot: string, config: LearningMomentsConfig): Promise<string> {
  const configured = config.claude.no_hooks_settings_file;
  const candidate = path.isAbsolute(configured) ? configured : path.join(projectRoot, configured);
  try {
    await fs.access(candidate);
    return candidate;
  } catch {
    return JSON.stringify({ disableAllHooks: true });
  }
}

function parseJsonFromText(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(unfenced.slice(start, end + 1));
    }
    throw new Error("Claude did not return parseable JSON.");
  }
}

function unwrapClaudeOutput(parsed: unknown): unknown {
  if (Array.isArray(parsed)) {
    for (const item of [...parsed].reverse()) {
      if (item && typeof item === "object" && "structured_output" in item) {
        return (item as { structured_output: unknown }).structured_output;
      }
      if (item && typeof item === "object" && "result" in item) {
        const result = (item as { result: unknown }).result;
        if (typeof result === "string" && result.trim().length > 0) {
          return parseJsonFromText(result);
        }
        if (result && typeof result === "object") {
          return result;
        }
      }
    }
  }

  if (parsed && typeof parsed === "object" && "structured_output" in parsed) {
    return (parsed as { structured_output: unknown }).structured_output;
  }
  if (parsed && typeof parsed === "object" && "result" in parsed) {
    const result = (parsed as { result: unknown }).result;
    if (typeof result === "string" && result.trim().length > 0) {
      return parseJsonFromText(result);
    }
    if (result && typeof result === "object") {
      return result;
    }
  }

  return parsed;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resultRecord(parsed: unknown): Record<string, unknown> | null {
  const candidates = Array.isArray(parsed) ? [...parsed].reverse() : [parsed];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      const record = candidate as Record<string, unknown>;
      if (record.type === "result" || "duration_ms" in record || "total_cost_usd" in record) {
        return record;
      }
    }
  }
  return null;
}

function extractMetrics(
  parsed: unknown,
  wallDurationMs: number,
  requestedModel: string
): ClaudeCallMetrics {
  const result = resultRecord(parsed);
  const usage =
    result && result.usage && typeof result.usage === "object"
      ? result.usage as Record<string, unknown>
      : {};

  return {
    wall_duration_ms: wallDurationMs,
    duration_ms: result ? numberField(result, "duration_ms") : undefined,
    duration_api_ms: result ? numberField(result, "duration_api_ms") : undefined,
    total_cost_usd: result ? numberField(result, "total_cost_usd") : undefined,
    input_tokens: numberField(usage, "input_tokens"),
    output_tokens: numberField(usage, "output_tokens"),
    cache_creation_input_tokens: numberField(usage, "cache_creation_input_tokens"),
    cache_read_input_tokens: numberField(usage, "cache_read_input_tokens"),
    num_turns: result ? numberField(result, "num_turns") : undefined,
    requested_model: requestedModel,
    model_usage: result ? result.modelUsage : undefined
  };
}

export async function runClaudeStructured(
  request: ClaudeStructuredRequest
): Promise<ClaudeStructuredResult> {
  if (!request.config.claude.enabled || process.env.LEARNING_MOMENTS_DISABLE_CLAUDE === "1") {
    throw new Error("Claude model calls are disabled.");
  }

  const args = [
    "-p",
    request.prompt,
    "--output-format",
    "json",
    "--no-session-persistence",
    "--settings",
    await settingsArgument(request.projectRoot, request.config),
    "--setting-sources",
    "user",
    "--disable-slash-commands",
    "--tools",
    "",
    "--json-schema",
    JSON.stringify(request.schema)
  ];

  if (request.config.claude.use_bare_when_compatible) {
    args.push("--bare");
  }
  if (request.model !== "default") {
    args.push("--model", request.model);
  }

  const startedAt = Date.now();
  const { stdout } = await execFileAsync("claude", args, {
    cwd: request.projectRoot,
    env: {
      ...process.env,
      LEARNING_MOMENTS_INTERNAL: "1"
    },
    timeout: request.timeoutSeconds * 1000,
    maxBuffer: 10 * 1024 * 1024
  });

  const parsed = parseJsonFromText(stdout);
  return {
    output: unwrapClaudeOutput(parsed),
    metrics: extractMetrics(parsed, Date.now() - startedAt, request.model)
  };
}
