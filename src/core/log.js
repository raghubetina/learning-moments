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
    const separator = (await endsMidLine(target)) ? "\n" : "";
    await fs.appendFile(target, `${separator}${JSON.stringify(normalized)}\n`);
    return normalized;
  });
}

/**
 * Whether `file` ends without a newline, as after an interrupted append.
 * The next record must then start on a new line, or it would merge into
 * the damaged one and be lost with it.
 *
 * @param {string} file
 */
async function endsMidLine(file) {
  let handle;
  try {
    handle = await fs.open(file, "r");
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? /** @type {{code?: string}} */ (error).code : undefined;
    if (code === "ENOENT") return false;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    await handle.close();
  }
}

/**
 * @typedef {{ line: number, error: string }} MalformedLine
 */

/**
 * Read a JSONL file, setting aside lines that do not parse as events.
 * A damaged line, such as the tail of an interrupted append, must not
 * make every later hook fail; `doctor` reports what was set aside.
 *
 * @param {string} file
 * @param {string} label
 * @returns {Promise<{ events: EventRecord[], malformed: MalformedLine[] }>}
 */
export async function scanJsonlFile(file, label) {
  /** @type {string} */
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? /** @type {{code?: string}} */ (error).code : undefined;
    if (code === "ENOENT") {
      return { events: [], malformed: [] };
    }
    throw error;
  }
  /** @type {EventRecord[]} */
  const events = [];
  /** @type {MalformedLine[]} */
  const malformed = [];
  raw.split("\n").forEach((line, index) => {
    if (line.trim().length === 0) return;
    try {
      events.push(parseEvent(JSON.parse(line), `${label}[${index}]`));
    } catch (error) {
      malformed.push({ line: index + 1, error: error instanceof Error ? error.message : String(error) });
    }
  });
  return { events, malformed };
}

/**
 * @param {string} file
 * @param {string} label
 * @returns {Promise<EventRecord[]>}
 */
async function readJsonlFile(file, label) {
  return (await scanJsonlFile(file, label)).events;
}

/**
 * Pre-migration: read the unified `moments.jsonl`. Post-migration: read
 * all three class files and merge by timestamp. Callers that need only
 * one retention class should use `readLedger` / `readControl` /
 * `readTelemetry` to avoid the merge cost on the hot path.
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

/**
 * @param {string} projectRoot
 * @param {"ledger" | "control" | "telemetry"} klass
 * @returns {Promise<EventRecord[]>}
 */
async function readClass(projectRoot, klass) {
  if (!(await isMigrated(projectRoot))) {
    // Pre-migration: filter the unified log by class. Slower, but the only
    // hot-path call sites that hit this branch are the dev environment
    // before `init` runs. Production paths see a marker after first init.
    const all = await readJsonlFile(logPath(projectRoot), "event");
    return all.filter((event) => EVENT_CLASSES[event.type] === klass);
  }
  const file =
    klass === "ledger"
      ? ledgerPath(projectRoot)
      : klass === "control"
        ? controlPath(projectRoot)
        : telemetryPath(projectRoot);
  return readJsonlFile(file, klass);
}

/**
 * Read only durable learning-record events. Use this on hot paths that
 * call into `latestSessionBaseline`, `pendingInjectedMoment`,
 * `pendingFeedbackMoment`, or `immediatePromptBudgetAvailable`.
 *
 * @param {string} projectRoot
 * @returns {Promise<EventRecord[]>}
 */
export function readLedger(projectRoot) {
  return readClass(projectRoot, "ledger");
}

/**
 * Read only hot-path control events. Use this for `classifierBudgetAvailable`
 * and the PostToolBatch dedupe check.
 *
 * @param {string} projectRoot
 * @returns {Promise<EventRecord[]>}
 */
export function readControl(projectRoot) {
  return readClass(projectRoot, "control");
}

/**
 * Read only disposable telemetry. Currently only used by `metrics` for
 * latency reporting.
 *
 * @param {string} projectRoot
 * @returns {Promise<EventRecord[]>}
 */
export function readTelemetry(projectRoot) {
  return readClass(projectRoot, "telemetry");
}
