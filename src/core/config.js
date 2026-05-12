// @ts-check
import fs from "node:fs/promises";
import { unsupportedGlobFeature } from "./filter.js";
import { configPath } from "./paths.js";
import { version as packageVersion } from "./path-self.js";
import {
  assertArray,
  assertBoolean,
  assertEnum,
  assertIntegerMin,
  assertObject,
  assertString
} from "./validate.js";

/**
 * @typedef {"active" | "observe_only"} Mode
 * @typedef {"metadata_only" | "excerpts" | "full"} ContextStorage
 *
 * @typedef {Object} ConfigFrequency
 * @property {number} immediate_prompts_per_hour
 * @property {number} minimum_minutes_between_immediate_prompts
 * @property {number} session_start_recall_limit
 * @property {number} classifier_calls_per_hour
 *
 * @typedef {Object} ConfigContextLimits
 * @property {number} max_diff_chars
 * @property {number} max_paths
 *
 * @typedef {Object} ConfigIgnore
 * @property {string[]} paths
 * @property {string[]} extensions
 *
 * @typedef {Object} ConfigPaused
 * @property {boolean} project
 * @property {Record<string, boolean>} sessions
 *
 * @typedef {Object} ConfigClaude
 * @property {boolean} enabled
 * @property {string} classifier_model
 * @property {string} grading_model
 * @property {number} classifier_timeout_seconds
 * @property {number} grader_timeout_seconds
 * @property {boolean} use_bare_when_compatible
 *
 * @typedef {Object} Config
 * @property {1} schema_version
 * @property {string} tool_version
 * @property {boolean} enabled
 * @property {ConfigPaused} paused
 * @property {ConfigFrequency} frequency
 * @property {Mode} mode
 * @property {ContextStorage} context_storage
 * @property {ConfigContextLimits} context_limits
 * @property {ConfigIgnore} ignore
 * @property {ConfigClaude} claude
 */

/** @type {readonly ContextStorage[]} */
const CONTEXT_STORAGE = ["metadata_only", "excerpts", "full"];
/** @type {readonly Mode[]} */
const MODES = ["active", "observe_only"];

/**
 * @param {unknown} value
 * @param {string} loc
 * @returns {string[]}
 */
function parseStringArray(value, loc) {
  const arr = assertArray(value, loc);
  arr.forEach((item, i) => assertString(item, `${loc}[${i}]`));
  return /** @type {string[]} */ (arr);
}

/**
 * @param {unknown} value
 * @param {string} loc
 * @returns {string[]}
 */
function parseIgnorePaths(value, loc) {
  const arr = parseStringArray(value, loc);
  arr.forEach((pattern, i) => {
    const feature = unsupportedGlobFeature(pattern);
    if (feature) {
      throw new Error(
        `${loc}[${i}]: pattern ${JSON.stringify(pattern)} uses ${feature}, ` +
          "which Learning Moments does not support. Supported syntax: literal segments, '*' within a segment, and '**' across segments."
      );
    }
  });
  return arr;
}

/**
 * @param {unknown} value
 * @param {string} loc
 * @returns {Record<string, boolean>}
 */
function parseSessionsMap(value, loc) {
  const obj = assertObject(value, loc);
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const [key, val] of Object.entries(obj)) {
    out[key] = assertBoolean(val, `${loc}.${key}`);
  }
  return out;
}

/**
 * @param {unknown} raw
 * @param {string} [loc]
 * @returns {Config}
 */
export function parseConfig(raw, loc = "config") {
  const obj = assertObject(raw, loc);

  if (obj.schema_version !== 1) {
    throw new Error(`${loc}.schema_version: expected 1, got ${JSON.stringify(obj.schema_version)}`);
  }

  const paused = assertObject(obj.paused, `${loc}.paused`);
  const frequency = assertObject(obj.frequency, `${loc}.frequency`);
  const contextLimits = assertObject(obj.context_limits, `${loc}.context_limits`);
  const ignore = assertObject(obj.ignore, `${loc}.ignore`);
  const claude = assertObject(obj.claude, `${loc}.claude`);

  return {
    schema_version: 1,
    tool_version: assertString(obj.tool_version, `${loc}.tool_version`),
    enabled: assertBoolean(obj.enabled, `${loc}.enabled`),
    paused: {
      project: assertBoolean(paused.project, `${loc}.paused.project`),
      sessions: parseSessionsMap(paused.sessions, `${loc}.paused.sessions`)
    },
    frequency: {
      immediate_prompts_per_hour: assertIntegerMin(
        frequency.immediate_prompts_per_hour,
        0,
        `${loc}.frequency.immediate_prompts_per_hour`
      ),
      minimum_minutes_between_immediate_prompts: assertIntegerMin(
        frequency.minimum_minutes_between_immediate_prompts,
        0,
        `${loc}.frequency.minimum_minutes_between_immediate_prompts`
      ),
      session_start_recall_limit: assertIntegerMin(
        frequency.session_start_recall_limit,
        0,
        `${loc}.frequency.session_start_recall_limit`
      ),
      classifier_calls_per_hour: assertIntegerMin(
        frequency.classifier_calls_per_hour,
        0,
        `${loc}.frequency.classifier_calls_per_hour`
      )
    },
    mode: assertEnum(obj.mode, MODES, `${loc}.mode`),
    context_storage: assertEnum(obj.context_storage, CONTEXT_STORAGE, `${loc}.context_storage`),
    context_limits: {
      max_diff_chars: assertIntegerMin(
        contextLimits.max_diff_chars,
        0,
        `${loc}.context_limits.max_diff_chars`
      ),
      max_paths: assertIntegerMin(contextLimits.max_paths, 0, `${loc}.context_limits.max_paths`)
    },
    ignore: {
      paths: parseIgnorePaths(ignore.paths, `${loc}.ignore.paths`),
      extensions: parseStringArray(ignore.extensions, `${loc}.ignore.extensions`)
    },
    claude: {
      enabled: claude.enabled === undefined ? true : assertBoolean(claude.enabled, `${loc}.claude.enabled`),
      classifier_model: assertString(claude.classifier_model, `${loc}.claude.classifier_model`),
      grading_model: assertString(claude.grading_model, `${loc}.claude.grading_model`),
      classifier_timeout_seconds: assertIntegerMin(
        claude.classifier_timeout_seconds,
        1,
        `${loc}.claude.classifier_timeout_seconds`
      ),
      grader_timeout_seconds: assertIntegerMin(
        claude.grader_timeout_seconds,
        1,
        `${loc}.claude.grader_timeout_seconds`
      ),
      use_bare_when_compatible: assertBoolean(
        claude.use_bare_when_compatible,
        `${loc}.claude.use_bare_when_compatible`
      )
    }
  };
}

/** @type {Config} */
export const defaultConfig = {
  schema_version: 1,
  tool_version: packageVersion(),
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
    max_paths: 20
  },
  ignore: {
    paths: ["dist/**", "coverage/**", "node_modules/**"],
    extensions: [".lock"]
  },
  claude: {
    enabled: true,
    classifier_model: "opus",
    grading_model: "opus",
    classifier_timeout_seconds: 45,
    grader_timeout_seconds: 45,
    use_bare_when_compatible: false
  }
};

/**
 * @param {string} projectRoot
 * @returns {Promise<Config>}
 */
export async function loadConfig(projectRoot) {
  const raw = await fs.readFile(configPath(projectRoot), "utf8");
  return parseConfig(JSON.parse(raw));
}

/**
 * @param {string} projectRoot
 * @param {Config} config
 */
export async function writeConfig(projectRoot, config) {
  await fs.writeFile(configPath(projectRoot), `${JSON.stringify(config, null, 2)}\n`);
}
