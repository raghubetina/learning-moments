export const defaultProfile = `# Learning Goals

I want to preserve:

- understanding AI-authored changes before approving them
- test design
- debugging and failure-mode reasoning
- architecture and maintainability judgment
- unfamiliar library comprehension

# Preferences

- Prefer short prompts.
- Ask only when the moment is likely to improve understanding.
- Defer low-urgency items to recall.
`;

export const defaultPrompts: Record<string, string> = {
  "classify-change.md": `You are the Learning Moments classifier.

Decide whether an AI-authored project change is a good opportunity for a brief learning checkpoint.
Prefer moments where the developer should predict behavior, name a test, or recall a rationale.

Return JSON matching the provided schema.
`,
  "grade-answer.md": `You are grading a Learning Moment answer.

Use the question, the user's answer, the expected answer outline, and available code context.
Return JSON matching the provided schema.
`,
  "answer-feedback.md": `Give brief feedback on the user's Learning Moment answer.

Keep it to correct / partially correct / likely incorrect plus one concise explanation.
Do not over-explain unless the user asks.
`,
  "select-recall.md": `Select delayed recall prompts for Learning Moments.

Prefer moments with low confidence, low grade, high learning value, or explicit recall scheduling.
`,
  "verify.md": `Generate a Learning Moment for the selected recent AI-authored change.

Focus on understanding, prediction, testing, or recall rather than generic code review.
`
};

export const slashCommandPrompts: Record<string, string> = {
  "status.md": `Run \`learning-moments status\` and summarize the result briefly.`,
  "pause.md": `Run \`learning-moments status\` if needed, then tell the user they can pause Learning Moments with \`learning-moments status\` for CLI state. If they asked to pause, ask Claude to run the appropriate Learning Moments pause command when it exists.`,
  "resume.md": `Tell the user Learning Moments resume support is managed by the CLI. If they asked to resume, ask Claude to run the appropriate Learning Moments resume command when it exists.`,
  "verify.md": `Ask Learning Moments to verify the most recent meaningful AI-authored project change. If the CLI command exists, run \`learning-moments verify\`.`
};
