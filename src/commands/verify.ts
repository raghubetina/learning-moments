import { classifyCandidate } from "../core/classifier.js";
import { loadConfig } from "../core/config.js";
import { candidateFiles } from "../core/filter.js";
import { diffForFiles, dirtyFiles, findGitRoot } from "../core/git.js";
import { createId, shortId } from "../core/ids.js";
import { appendEvent } from "../core/log.js";
import { redactSecrets } from "../core/redaction.js";

export async function verifyCommand(): Promise<void> {
  const projectRoot = findGitRoot(process.cwd());
  const config = await loadConfig(projectRoot);
  const files = candidateFiles(dirtyFiles(projectRoot), config).slice(0, config.context_limits.max_paths);
  if (files.length === 0) {
    console.log("No meaningful dirty project changes found.");
    return;
  }

  const diff = redactSecrets(diffForFiles(projectRoot, files, config.context_limits.max_diff_chars));
  const classification = classifyCandidate({ files, diff: diff.text });
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
