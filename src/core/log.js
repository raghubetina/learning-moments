// @ts-check
import fs from "node:fs/promises";
import { isKnownEventType } from "./event-registry.js";
import { createId } from "./ids.js";
import { logPath } from "./paths.js";
import { withProjectLock } from "./lock.js";
import { assertObject, assertString, optional } from "./validate.js";

/**
 * The shape every persisted event satisfies. Individual event types add their
 * own fields on top of these — see EVENT_CLASSES in `tmp/sec_3_log_split.md`
 * for the full enumeration. We model the open shape as a string-indexed
 * record rather than a discriminated union so parseEvent can accept future
 * event types without a parser change.
 *
 * @typedef {Object} LearningMomentEvent
 * @property {string} id
 * @property {string} type
 * @property {string} timestamp
 * @property {string} [session_id]
 * @property {string} [transcript_path]
 * @property {string} [cwd]
 *
 * @typedef {LearningMomentEvent & Record<string, unknown>} EventRecord
 */

/**
 * @param {unknown} raw
 * @param {string} [loc]
 * @returns {EventRecord}
 */
export function parseEvent(raw, loc = "event") {
  const obj = assertObject(raw, loc);
  assertString(obj.id, `${loc}.id`);
  assertString(obj.type, `${loc}.type`);
  assertString(obj.timestamp, `${loc}.timestamp`);
  optional(obj.session_id, assertString, `${loc}.session_id`);
  optional(obj.transcript_path, assertString, `${loc}.transcript_path`);
  optional(obj.cwd, assertString, `${loc}.cwd`);
  return /** @type {EventRecord} */ (obj);
}

/**
 * @param {Record<string, unknown>} event
 * @returns {EventRecord}
 */
export function normalizeEvent(event) {
  return parseEvent({
    id: event.id ?? createId("event"),
    timestamp: event.timestamp ?? new Date().toISOString(),
    ...event
  });
}

/**
 * @param {string} projectRoot
 * @param {Record<string, unknown>} event
 * @returns {Promise<EventRecord>}
 */
export async function appendEvent(projectRoot, event) {
  return withProjectLock(projectRoot, "moments-jsonl", async () => {
    const normalized = normalizeEvent(event);
    if (!isKnownEventType(normalized.type)) {
      throw new Error(
        `Unknown event type "${normalized.type}". Add it to src/core/event-registry.js with a retention class (ledger | control | telemetry) before writing it.`
      );
    }
    await fs.appendFile(logPath(projectRoot), `${JSON.stringify(normalized)}\n`);
    return normalized;
  });
}

/**
 * @param {string} projectRoot
 * @returns {Promise<EventRecord[]>}
 */
export async function readEvents(projectRoot) {
  /** @type {string} */
  let raw;
  try {
    raw = await fs.readFile(logPath(projectRoot), "utf8");
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? /** @type {{code?: string}} */ (error).code : undefined;
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
