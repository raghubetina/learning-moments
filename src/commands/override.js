import { appendEvent, readLedger } from "../core/log.js";
import { requireProject } from "../core/project.js";

/**
 * Record a manual grade, which replaces the model's grade in metrics.
 * Accepts the short ID shown in the conversation (`lm_a7f3`) or the full
 * moment ID.
 */
export async function overrideCommand(momentRef, options) {
  const grade = Number.parseInt(options.grade, 10);
  if (!Number.isInteger(grade) || grade < 0 || grade > 3) {
    throw new Error("--grade must be an integer from 0 to 3");
  }
  const { dataRoot: projectRoot } = await requireProject();
  const events = await readLedger(projectRoot);
  const moments = new Map();
  for (const event of events) {
    if (["moment_created", "moment_injected"].includes(event.type) && typeof event.moment_id === "string") {
      if (event.moment_id === momentRef || event.short_id === momentRef) moments.set(event.moment_id, event);
    }
  }
  if (moments.size === 0) {
    throw new Error(`No Learning Moment ${momentRef} in this project.`);
  }
  if (moments.size > 1) {
    throw new Error(`${momentRef} matches ${moments.size} Learning Moments; use the full ID: ${[...moments.keys()].join(", ")}`);
  }
  const [moment] = moments.values();
  await appendEvent(projectRoot, {
    type: "grade_created",
    moment_id: moment.moment_id,
    short_id: moment.short_id,
    session_id: moment.session_id,
    grade,
    note: options.note,
    source: "manual_override",
    cwd: projectRoot
  });
  console.log(`Recorded manual grade ${grade} for ${moment.short_id}.`);
}
