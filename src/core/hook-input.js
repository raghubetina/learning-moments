// @ts-check
import { assertArray, assertObject, assertString, optional } from "./validate.js";

/**
 * Shared fields every Claude Code hook input carries. Each event type
 * narrows from this with its own additional fields.
 *
 * @typedef {Object} CommonHookInput
 * @property {string} session_id
 * @property {string} cwd
 * @property {string} hook_event_name
 * @property {string} [transcript_path]
 * @property {string} [permission_mode]
 *
 * @typedef {CommonHookInput & {tool_name: string, tool_use_id?: string, tool_input?: unknown}} ToolHookInput
 * @typedef {CommonHookInput & {prompt: string}} UserPromptSubmitInput
 * @typedef {CommonHookInput & {tool_calls: unknown[]}} PostToolBatchInput
 * @typedef {CommonHookInput & {last_assistant_message?: string}} StopHookInput
 */

/**
 * @param {unknown} raw
 * @param {string} [loc]
 * @returns {CommonHookInput & Record<string, unknown>}
 */
export function parseCommonHookInput(raw, loc = "input") {
  const obj = assertObject(raw, loc);
  assertString(obj.session_id, `${loc}.session_id`);
  assertString(obj.cwd, `${loc}.cwd`);
  assertString(obj.hook_event_name, `${loc}.hook_event_name`);
  optional(obj.transcript_path, assertString, `${loc}.transcript_path`);
  optional(obj.permission_mode, assertString, `${loc}.permission_mode`);
  return /** @type {CommonHookInput & Record<string, unknown>} */ (obj);
}

/**
 * @param {unknown} raw
 * @param {string} [loc]
 * @returns {ToolHookInput & Record<string, unknown>}
 */
export function parseToolHookInput(raw, loc = "input") {
  const obj = parseCommonHookInput(raw, loc);
  assertString(obj.tool_name, `${loc}.tool_name`);
  optional(obj.tool_use_id, assertString, `${loc}.tool_use_id`);
  return /** @type {ToolHookInput & Record<string, unknown>} */ (obj);
}

/**
 * @param {unknown} raw
 * @param {string} [loc]
 * @returns {UserPromptSubmitInput}
 */
export function parseUserPromptSubmitInput(raw, loc = "input") {
  const obj = parseCommonHookInput(raw, loc);
  assertString(obj.prompt, `${loc}.prompt`);
  return /** @type {UserPromptSubmitInput} */ (obj);
}

/**
 * @param {unknown} raw
 * @param {string} [loc]
 * @returns {PostToolBatchInput}
 */
export function parsePostToolBatchInput(raw, loc = "input") {
  const obj = parseCommonHookInput(raw, loc);
  if (obj.tool_calls === undefined) {
    obj.tool_calls = [];
  } else {
    assertArray(obj.tool_calls, `${loc}.tool_calls`);
  }
  return /** @type {PostToolBatchInput} */ (obj);
}

/**
 * @param {unknown} raw
 * @param {string} [loc]
 * @returns {StopHookInput}
 */
export function parseStopHookInput(raw, loc = "input") {
  const obj = parseCommonHookInput(raw, loc);
  optional(obj.last_assistant_message, assertString, `${loc}.last_assistant_message`);
  return /** @type {StopHookInput} */ (obj);
}
