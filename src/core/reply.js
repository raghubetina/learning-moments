// @ts-check

/**
 * What the developer's next message is, relative to a pending question.
 * Only "answer" and "dont_know" are graded; everything else must not be
 * scored as a wrong answer.
 *
 * @typedef {"pause" | "command" | "automatic" | "skip" | "continue" | "dont_know" | "answer"} ReplyKind
 */

const PAUSE_COMMAND = /^\/learning-moments:pause\b/i;
// A command name followed by arguments or nothing, so "/dev/null is the
// target" still reads as an answer.
const SLASH_COMMAND = /^\/[a-z][\w:-]*(\s|$)/i;
// Background-agent reports, scheduled tasks, and messages from other
// sessions also reach UserPromptSubmit. Those that Claude Code wraps in a
// tag are recognizable here; the grader's not_an_answer label catches the
// rest.
const AUTOMATIC = /^<(task-notification|agent-message|scheduled-task|cross-session-message|system-reminder)\b/i;
const SKIP = /^(skip|pass|not now|later|too busy|no thanks)( (it|this|this one|for now|please))?[.!]*$/i;
const CONTINUE = /^(proceed|continue|go ahead|go on|keep going|carry on|next|ok(ay)?|yes|yep|sure|do it|lgtm)[.!]*$/i;
const DONT_KNOW =
  /^(i (really )?(don'?t|do not) know|i'?m not sure|i am not sure|not sure|no idea|no clue|idk|dunno|i have no idea)\b/i;

/**
 * @param {string} text the redacted prompt
 * @returns {ReplyKind}
 */
export function classifyReply(text) {
  const trimmed = text.trim();
  if (PAUSE_COMMAND.test(trimmed)) return "pause";
  if (SLASH_COMMAND.test(trimmed)) return "command";
  if (AUTOMATIC.test(trimmed)) return "automatic";
  if (SKIP.test(trimmed)) return "skip";
  if (CONTINUE.test(trimmed)) return "continue";
  if (DONT_KNOW.test(trimmed)) return "dont_know";
  return "answer";
}
