export const defaultProfile = `# Learning Goals

I want to preserve:

- understanding AI-authored changes before relying on them
- test design
- debugging and failure-mode reasoning
- architecture and maintainability judgment
- unfamiliar library comprehension

# Preferences

- Prefer short prompts.
- Ask only when the moment is likely to improve understanding.
- Defer low-urgency items to recall.
`;

export const defaultPrompts = {
  "classify-change.md": `You are the Learning Moments moment selector.

Decide whether an AI-authored project change is a good opportunity for a brief Learning Moment. The goal is to preserve developer understanding during AI-assisted programming without creating nagging interruptions.

Selection rule: do not manufacture a generic quiz. If the change is not a high-value, situated opportunity for understanding, return eligible=false and delivery=discard.

Prefer moments where the developer should exercise one of these skills:

- predicting behavior before relying on AI-written code
- designing a concrete verification or test
- recalling a rationale that matters for future maintenance

Prefer no interruption over a weak interruption. The question must be short, specific to the provided diff, and answerable without reading hidden rubric text. Do not reveal the expected answer outline in the question.

Return JSON matching the provided schema.
`,
  "grade-answer.md": `You are grading a Learning Moment answer.

Use the question, the user's answer, the expected answer outline, and available code context.
Be fair and concise. Prefer actionable feedback over praise or long explanation.

Use this default rubric:

- 3: correct, specific, and connected to a test, implication, or failure mode
- 2: mostly correct and grounded in the change, but incomplete
- 1: weak, vague, or only loosely connected to the change
- 0: incorrect, missing, or not grounded in the change

The feedback should be one short sentence the coding assistant can pass to the user.

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

export const slashCommandPrompts = {
  "status.md": `Run \`learning-moments status\` and summarize the result briefly.`,
  "metrics.md": `Run \`learning-moments metrics\` and summarize the speed, interruption, and estimated cost results briefly.`,
  "pause.md": `Run \`learning-moments pause --project\`, then summarize the result briefly.`,
  "resume.md": `Run \`learning-moments resume --project\`, then summarize the result briefly.`,
  "verify.md": `Ask Learning Moments to verify my understanding of the most recent meaningful AI-authored project change. If the CLI command exists, run \`learning-moments verify\`.`
};
