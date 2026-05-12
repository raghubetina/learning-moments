import fs from "node:fs/promises";
import { createId } from "./ids.js";
import { logPath } from "./paths.js";
import { withProjectLock } from "./lock.js";
import { assertObject, assertString, optional } from "./validate.js";

export function parseEvent(raw, loc = "event") {
  const obj = assertObject(raw, loc);
  assertString(obj.id, `${loc}.id`);
  assertString(obj.type, `${loc}.type`);
  assertString(obj.timestamp, `${loc}.timestamp`);
  optional(obj.session_id, assertString, `${loc}.session_id`);
  optional(obj.transcript_path, assertString, `${loc}.transcript_path`);
  optional(obj.cwd, assertString, `${loc}.cwd`);
  return obj;
}

export function normalizeEvent(event) {
  return parseEvent({
    id: event.id ?? createId("event"),
    timestamp: event.timestamp ?? new Date().toISOString(),
    ...event
  });
}

export async function appendEvent(projectRoot, event) {
  return withProjectLock(projectRoot, "moments-jsonl", async () => {
    const normalized = normalizeEvent(event);
    await fs.appendFile(logPath(projectRoot), `${JSON.stringify(normalized)}\n`);
    return normalized;
  });
}

export async function readEvents(projectRoot) {
  let raw;
  try {
    raw = await fs.readFile(logPath(projectRoot), "utf8");
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => parseEvent(JSON.parse(line), `event[${index}]`));
}
