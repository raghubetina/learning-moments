import { classifyCandidate } from "../core/classifier.js";
import { loadConfig } from "../core/config.js";
import { candidateFiles } from "../core/filter.js";
import { contextForFiles, dirtyFiles, findGitRoot } from "../core/git.js";
import { createId, shortId } from "../core/ids.js";
import { appendEvent } from "../core/log.js";

export async function verifyCommand() {
  const projectRoot = findGitRoot(process.cwd());
  const config = await loadConfig(projectRoot);
  const files = candidateFiles(dirtyFiles(projectRoot), config).slice(0, config.context_limits.max_paths);
  if (files.length === 0) {
    console.log("No meaningful uncommitted project changes found.");
    return;
  }

  const diff = contextForFiles(projectRoot, files, config.context_limits.max_diff_chars);
  const result = await classifyCandidate(projectRoot, config, { files, diff: diff.text });
  if (result && !result.ok) {
    console.log(`Could not select a question (${result.reason}).`);
    return;
  }
  const classification = result?.value;
  if (!classification || !classification.eligible || classification.delivery === "discard") {
    console.log("No high-value Learning Moment found in the current uncommitted changes.");
    return;
  }
  const momentId = createId("moment");
  const displayId = shortId(momentId);
  await appendEvent(projectRoot, {
    type: "moment_created",
    moment_id: momentId,
    short_id: displayId,
    cwd: projectRoot,
    files,
    question: classification.question,
    expected_answer_outline: classification.expected_answer_outline,
    classifier_reason: "manual verify",
    redaction_findings: diff.findings
  });

  console.log(`Learning Moment ${displayId}`);
  console.log(classification.question);
}
