import { assertArray, assertObject, assertString, optional } from "./validate.js";

export function parseCommonHookInput(raw, loc = "input") {
  const obj = assertObject(raw, loc);
  assertString(obj.session_id, `${loc}.session_id`);
  assertString(obj.cwd, `${loc}.cwd`);
  assertString(obj.hook_event_name, `${loc}.hook_event_name`);
  optional(obj.transcript_path, assertString, `${loc}.transcript_path`);
  optional(obj.permission_mode, assertString, `${loc}.permission_mode`);
  return obj;
}

export function parseToolHookInput(raw, loc = "input") {
  const obj = parseCommonHookInput(raw, loc);
  assertString(obj.tool_name, `${loc}.tool_name`);
  optional(obj.tool_use_id, assertString, `${loc}.tool_use_id`);
  return obj;
}

export function parseUserPromptSubmitInput(raw, loc = "input") {
  const obj = parseCommonHookInput(raw, loc);
  assertString(obj.prompt, `${loc}.prompt`);
  return obj;
}

export function parsePostToolBatchInput(raw, loc = "input") {
  const obj = parseCommonHookInput(raw, loc);
  if (obj.tool_calls === undefined) {
    obj.tool_calls = [];
  } else {
    assertArray(obj.tool_calls, `${loc}.tool_calls`);
  }
  return obj;
}

export function parseStopHookInput(raw, loc = "input") {
  const obj = parseCommonHookInput(raw, loc);
  optional(obj.last_assistant_message, assertString, `${loc}.last_assistant_message`);
  return obj;
}
