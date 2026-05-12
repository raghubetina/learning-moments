import { findGitRoot } from "../core/git.js";
import { appendEvent } from "../core/log.js";

export async function overrideCommand(momentId, options) {
  const grade = Number.parseInt(options.grade, 10);
  if (!Number.isInteger(grade) || grade < 0 || grade > 3) {
    throw new Error("--grade must be an integer from 0 to 3");
  }
  const projectRoot = findGitRoot(process.cwd());
  await appendEvent(projectRoot, {
    type: "grade_created",
    moment_id: momentId,
    grade,
    note: options.note,
    source: "manual_override",
    cwd: projectRoot
  });
  console.log(`Recorded manual grade ${grade} for ${momentId}.`);
}
