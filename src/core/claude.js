import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { ClaudeCallError } from "./claude-call.js";
import { noHooksSettingsPath } from "./paths.js";

const execFileAsync = promisify(execFile);

// The no-hooks settings file is written by `learning-moments init` at a
// fixed path inside the project's `.learning-moments/` directory. We pass
// the path to `claude -p --settings` only when the file is present AND
// contains `{disableAllHooks: true}`. Three failure modes — missing,
// unparseable, or contents that wouldn't actually disable hooks — all fall
// back to passing the JSON inline. That keeps nested `claude -p` calls from
// recursively firing our hooks even when the file on disk has been
// corrupted or tampered with.
//
// Exported for testing.
/**
 * @param {string} projectRoot
 * @returns {Promise<string>}
 */
export async function settingsArgument(projectRoot) {
  const candidate = noHooksSettingsPath(projectRoot);
  try {
    const text = await fs.readFile(candidate, "utf8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && parsed.disableAllHooks === true) {
      return candidate;
    }
  } catch {
    // ENOENT, unparseable JSON, or any read error — fall through to inline
  }
  return JSON.stringify({ disableAllHooks: true });
}

function parseJsonFromText(text) {
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

function unwrapClaudeOutput(parsed) {
  if (Array.isArray(parsed)) {
    for (const item of [...parsed].reverse()) {
      if (item && typeof item === "object" && "structured_output" in item) {
        return item.structured_output;
      }
      if (item && typeof item === "object" && "result" in item) {
        const result = item.result;
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
    return parsed.structured_output;
  }
  if (parsed && typeof parsed === "object" && "result" in parsed) {
    const result = parsed.result;
    if (typeof result === "string" && result.trim().length > 0) {
      return parseJsonFromText(result);
    }
    if (result && typeof result === "object") {
      return result;
    }
  }

  return parsed;
}

function numberField(record, key) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resultRecord(parsed) {
  const candidates = Array.isArray(parsed) ? [...parsed].reverse() : [parsed];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      if (candidate.type === "result" || "duration_ms" in candidate || "total_cost_usd" in candidate) {
        return candidate;
      }
    }
  }
  return null;
}

function extractMetrics(parsed, wallDurationMs, requestedModel) {
  const result = resultRecord(parsed);
  const usage = result && result.usage && typeof result.usage === "object" ? result.usage : {};

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

/**
 * Environment for nested `claude -p` calls. The selector and grader take
 * their policy from Learning Moments' own prompt files. The developer's
 * CLAUDE.md files and auto memory are written for the coding agent: they
 * add thousands of input tokens to every call and steer the nested model
 * with instructions that have nothing to do with selecting or grading.
 *
 * @param {NodeJS.ProcessEnv} [baseEnv]
 */
export function nestedClaudeEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    LEARNING_MOMENTS_INTERNAL: "1",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1"
  };
}

/**
 * @param {{ projectRoot: string, config: any, prompt: string, system: string,
 *   schema: object, model: string, effort?: string }} request
 * @returns {Promise<string[]>}
 */
export async function nestedClaudeArgs(request) {
  const args = [
    "-p",
    request.prompt,
    "--system-prompt",
    request.system,
    "--output-format",
    "json",
    "--no-session-persistence",
    "--settings",
    await settingsArgument(request.projectRoot),
    "--setting-sources",
    "user",
    "--disable-slash-commands",
    // `--tools` governs only built-in tools. Without the next two flags
    // the nested process loads every MCP server the developer configured
    // and can call an allowed MCP tool, whose result would bypass the
    // bounded, redacted context this package builds.
    "--strict-mcp-config",
    "--disallowedTools",
    "mcp__*",
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
  // Without an explicit level the nested call inherits the developer's
  // `effortLevel` setting, which can make a short classification take
  // most of its timeout.
  if (request.effort && request.effort !== "default") {
    args.push("--effort", request.effort);
  }
  return args;
}

/**
 * Map a failed `execFile` call to a bounded failure category.
 *
 * @param {any} error
 * @returns {import("./claude-call.js").ClaudeFailureReason}
 */
export function execFailureReason(error) {
  if (error?.code === "ENOENT") return "claude_not_found";
  if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "output_too_large";
  if (error?.killed) return "timeout";
  if (typeof error?.code !== "number") return "spawn_error";
  const text = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
  if (/usage limit|rate limit|\b429\b|overloaded/i.test(text)) return "rate_limited";
  if (/not logged in|\/login|invalid api key|authentication_error|\b401\b/i.test(text)) return "auth";
  return "exit_nonzero";
}

/**
 * @param {{ projectRoot: string, config: any, prompt: string, system: string,
 *   schema: object, model: string, effort?: string, timeoutSeconds: number }} request
 */
export async function runClaudeStructured(request) {
  if (!request.config.claude.enabled || process.env.LEARNING_MOMENTS_DISABLE_CLAUDE === "1") {
    throw new ClaudeCallError("disabled", "Claude model calls are disabled.");
  }

  const args = await nestedClaudeArgs(request);
  const startedAt = Date.now();
  const failureMetrics = () => ({
    wall_duration_ms: Date.now() - startedAt,
    requested_model: request.model,
    requested_effort: request.effort
  });

  /** @param {unknown} parsed */
  const resultMetrics = (parsed) => ({
    ...extractMetrics(parsed, Date.now() - startedAt, request.model),
    requested_effort: request.effort
  });

  let stdout;
  try {
    ({ stdout } = await execFileAsync("claude", args, {
      cwd: request.projectRoot,
      env: nestedClaudeEnv(),
      timeout: request.timeoutSeconds * 1000,
      maxBuffer: 10 * 1024 * 1024
    }));
  } catch (error) {
    // A provider error after a billed turn still prints the result
    // envelope before the nonzero exit; keep its usage when it parses.
    let metrics = failureMetrics();
    const output = /** @type {{ stdout?: unknown }} */ (error)?.stdout;
    if (typeof output === "string" && output.trim().length > 0) {
      try {
        metrics = resultMetrics(parseJsonFromText(output));
      } catch {
        // Not an envelope; wall time is all there is.
      }
    }
    throw new ClaudeCallError(execFailureReason(error), "claude -p failed", metrics);
  }

  let parsed;
  try {
    parsed = parseJsonFromText(stdout);
  } catch {
    throw new ClaudeCallError("invalid_json", "claude -p returned unparseable output", failureMetrics());
  }
  const metrics = resultMetrics(parsed);
  const record = resultRecord(parsed);
  if (record?.is_error === true) {
    const text = typeof record.result === "string" ? record.result : "";
    const reason = /usage limit|rate limit|overloaded/i.test(text) ? "rate_limited" : "cli_error";
    throw new ClaudeCallError(reason, "claude -p reported an error result", metrics);
  }
  let output;
  try {
    output = unwrapClaudeOutput(parsed);
  } catch {
    throw new ClaudeCallError("invalid_output", "claude -p returned no structured output", metrics);
  }
  return { output, metrics };
}
