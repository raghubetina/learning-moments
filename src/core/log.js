// @ts-check
import fs from "node:fs/promises";
import { EVENT_CLASSES, isKnownEventType } from "./event-registry.js";
import { createId } from "./ids.js";
import { controlPath, ledgerPath, logPath, migrationCompletePath, telemetryPath } from "./paths.js";
import { withProjectLock } from "./lock.js";
import { assertObject, assertString, optional } from "./validate.js";

/**
 * Per-process cache of which projects have finished the one-time migration
 * from `moments.jsonl` to the three-class split. Migration is only ever
 * forward, so once we observe the marker we never need to re-check.
 *
 * @type {Map<string, boolean>}
 */
const migrationCache = new Map();

/**
 * Drops the per-process cache so the next call to `isMigrated` re-checks
 * the filesystem. Used by `migrateLegacyLog` after it writes the marker,
 * and by tests that recycle the cache across temp dirs.
 */
export function invalidateMigrationCache() {
  migrationCache.clear();
}

/**
 * @param {string} projectRoot
 * @returns {Promise<boolean>}
 */
async function isMigrated(projectRoot) {
  const cached = migrationCache.get(projectRoot);
  if (cached === true) return true;
  try {
    await fs.access(migrationCompletePath(projectRoot));
    migrationCache.set(projectRoot, true);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} projectRoot
 * @param {string} eventType
 * @returns {string}
 */
function destinationPath(projectRoot, eventType) {
  const klass = EVENT_CLASSES[eventType];
  if (klass === "ledger") return ledgerPath(projectRoot);
  if (klass === "control") return controlPath(projectRoot);
  return telemetryPath(projectRoot);
}

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
    const target = (await isMigrated(projectRoot))
      ? destinationPath(projectRoot, normalized.type)
      : logPath(projectRoot);
    await fs.appendFile(target, `${JSON.stringify(normalized)}\n`);
    return normalized;
  });
}

/**
 * @param {string} file
 * @param {string} label
 * @returns {Promise<EventRecord[]>}
 */
async function readJsonlFile(file, label) {
  /** @type {string} */
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
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
    .map((line, index) => parseEvent(JSON.parse(line), `${label}[${index}]`));
}

/**
 * Pre-migration: read the unified `moments.jsonl`. Post-migration: read
 * all three class files and merge by timestamp. Callers that need only a
 * single class should use the per-class read helpers (added in a later
 * phase) instead of paying for the merge.
 *
 * @param {string} projectRoot
 * @returns {Promise<EventRecord[]>}
 */
export async function readEvents(projectRoot) {
  if (!(await isMigrated(projectRoot))) {
    return readJsonlFile(logPath(projectRoot), "event");
  }
  const [ledger, control, telemetry] = await Promise.all([
    readJsonlFile(ledgerPath(projectRoot), "ledger"),
    readJsonlFile(controlPath(projectRoot), "control"),
    readJsonlFile(telemetryPath(projectRoot), "telemetry")
  ]);
  const merged = [...ledger, ...control, ...telemetry];
  merged.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return merged;
}
