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

export async function runClaudeStructured(request: ClaudeStructuredRequest): Promise<unknown> {
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

  const { stdout } = await execFileAsync("claude", args, {
    cwd: request.projectRoot,
    env: {
      ...process.env,
      LEARNING_MOMENTS_INTERNAL: "1"
    },
    timeout: request.timeoutSeconds * 1000,
    maxBuffer: 10 * 1024 * 1024
  });

  return unwrapClaudeOutput(parseJsonFromText(stdout));
}
