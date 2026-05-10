import { z } from "zod";

export const commonHookInputSchema = z.object({
  session_id: z.string(),
  transcript_path: z.string().optional(),
  cwd: z.string(),
  permission_mode: z.string().optional(),
  hook_event_name: z.string()
}).passthrough();

export const toolHookInputSchema = commonHookInputSchema.extend({
  tool_name: z.string(),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
  tool_use_id: z.string().optional()
});

export const userPromptSubmitInputSchema = commonHookInputSchema.extend({
  hook_event_name: z.literal("UserPromptSubmit"),
  prompt: z.string()
});

export const postToolBatchInputSchema = commonHookInputSchema.extend({
  hook_event_name: z.literal("PostToolBatch"),
  tool_calls: z.array(z.unknown()).default([])
});

export const stopHookInputSchema = commonHookInputSchema.extend({
  hook_event_name: z.literal("Stop"),
  stop_hook_active: z.boolean().optional(),
  last_assistant_message: z.string().optional()
});

export type CommonHookInput = z.infer<typeof commonHookInputSchema>;
export type ToolHookInput = z.infer<typeof toolHookInputSchema>;
export type UserPromptSubmitInput = z.infer<typeof userPromptSubmitInputSchema>;
export type PostToolBatchInput = z.infer<typeof postToolBatchInputSchema>;
export type StopHookInput = z.infer<typeof stopHookInputSchema>;

export interface AdditionalContextOutput {
  hookSpecificOutput: {
    hookEventName: string;
    additionalContext: string;
  };
}
