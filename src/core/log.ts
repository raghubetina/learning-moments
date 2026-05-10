import fs from "node:fs/promises";
import { z } from "zod";
import { createId } from "./ids.js";
import { logPath } from "./paths.js";
import { withProjectLock } from "./lock.js";

export const eventSchema = z.object({
  id: z.string(),
  type: z.string(),
  timestamp: z.string(),
  session_id: z.string().optional(),
  transcript_path: z.string().optional(),
  cwd: z.string().optional()
}).passthrough();

export type EventRecord = z.infer<typeof eventSchema>;

export type NewEventRecord = Omit<EventRecord, "id" | "timestamp"> &
  Partial<Pick<EventRecord, "id" | "timestamp">>;

export function normalizeEvent(event: NewEventRecord): EventRecord {
  return eventSchema.parse({
    id: event.id ?? createId("event"),
    timestamp: event.timestamp ?? new Date().toISOString(),
    ...event
  });
}

export async function appendEvent(projectRoot: string, event: NewEventRecord): Promise<EventRecord> {
  return withProjectLock(projectRoot, "moments-jsonl", async () => {
    const normalized = normalizeEvent(event);
    await fs.appendFile(logPath(projectRoot), `${JSON.stringify(normalized)}\n`);
    return normalized;
  });
}

export async function readEvents(projectRoot: string): Promise<EventRecord[]> {
  let raw: string;
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
    .map((line) => eventSchema.parse(JSON.parse(line)));
}
