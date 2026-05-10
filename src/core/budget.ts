import type { EventRecord } from "./log.js";
import type { LearningMomentsConfig } from "./config.js";

function since(events: EventRecord[], windowMs: number, now = new Date()): EventRecord[] {
  const cutoff = now.getTime() - windowMs;
  return events.filter((event) => new Date(event.timestamp).getTime() >= cutoff);
}

export function immediatePromptBudgetAvailable(
  events: EventRecord[],
  config: LearningMomentsConfig,
  now = new Date()
): boolean {
  const perHour = config.frequency.immediate_prompts_per_hour;
  if (perHour === 0) {
    return false;
  }

  const recentInjections = since(events, 60 * 60 * 1000, now).filter(
    (event) => event.type === "moment_injected"
  );
  if (recentInjections.length >= perHour) {
    return false;
  }

  const lastInjection = [...events].reverse().find((event) => event.type === "moment_injected");
  if (!lastInjection) {
    return true;
  }
  const elapsedMinutes = (now.getTime() - new Date(lastInjection.timestamp).getTime()) / 60000;
  return elapsedMinutes >= config.frequency.minimum_minutes_between_immediate_prompts;
}

export function classifierBudgetAvailable(
  events: EventRecord[],
  config: LearningMomentsConfig,
  now = new Date()
): boolean {
  const maxCalls = config.frequency.classifier_calls_per_hour;
  if (maxCalls === 0) {
    return false;
  }
  const recentCalls = since(events, 60 * 60 * 1000, now).filter(
    (event) => event.type === "classifier_called"
  );
  return recentCalls.length < maxCalls;
}
