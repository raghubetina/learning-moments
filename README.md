# Learning Moments

Learning Moments is an experimental Claude Code hook tool for prompting brief, situated checks of developer understanding during AI-assisted programming.

The goal is not to quiz you constantly. Learning Moments watches for AI-authored project changes, asks Claude to classify whether there is a high-value learning checkpoint, and only interrupts when the classifier finds a specific moment worth asking about. If classification fails, declines, or times out, it fails open and asks nothing.

## Status

This is an early alpha. It is useful for local testing and research prototypes, not a polished production tool.

Current capabilities:

- initialize project-local Learning Moments data
- install Claude Code hooks into `.claude/settings.local.json`
- create Claude Code slash command prompt files
- record session Git baselines and AI-authored file changes
- detect changed files since a session baseline
- call Claude Code in print mode to classify high-value Learning Moments
- inject an initial question through hook `additionalContext`
- capture the next user answer through `UserPromptSubmit`
- grade the answer with Claude Code and inject brief feedback
- pause/resume at project or session scope
- remove installed hooks without deleting local learning data

Not implemented yet:

- delayed recall prompts
- confidence prompts
- polished reporting/export
- non-Claude Code agents

## Requirements

- Node.js 20+
- Git
- Claude Code
- Claude Code authenticated on your machine

Learning Moments uses `claude -p` internally for classification and grading, so it uses your existing Claude Code authentication and model configuration.

## Install

```bash
npm install -g learning-moments
```

Then initialize it inside a Git project where you use Claude Code:

```bash
cd /path/to/your/project
learning-moments init
learning-moments doctor
```

Start Claude Code normally from that project directory. When Learning Moments detects a high-value checkpoint, Claude will ask a short question in the normal chat flow.

## Commands

```bash
learning-moments init
learning-moments doctor
learning-moments status
learning-moments pause --project
learning-moments resume --project
learning-moments verify
learning-moments uninstall
learning-moments delete-data
```

`uninstall` removes hooks and slash commands but keeps `.learning-moments/`.

`delete-data` removes local Learning Moments data.

## Customization

Learning Moments is intentionally moderately configurable. The plumbing and data shape stay fixed, while your goals and prompt policy live in project-local Markdown.

Editable files created by `learning-moments init`:

- `.learning-moments/profile.md`: skill-retention goals and preferences.
- `.learning-moments/prompts/classify-change.md`: what counts as a valuable Learning Moment.
- `.learning-moments/prompts/grade-answer.md`: grading rubric and feedback style.
- `.learning-moments/prompts/answer-feedback.md`: reserved for feedback prompt tuning.
- `.learning-moments/prompts/select-recall.md`: reserved for delayed recall selection.
- `.learning-moments/prompts/verify.md`: reserved for manual verification prompts.

Editable config in `.learning-moments/config.json`:

- model aliases and timeouts for classifier/grader calls
- immediate prompt frequency and minimum spacing
- observe-only vs active mode
- ignored paths/extensions
- context limits

By default, classifier and grader calls use Claude Code's `opus` model alias. You can change this in `.learning-moments/config.json`.

Fixed in the MVP:

- Claude Code hooks as the integration surface
- Git diff-based candidate detection
- the classifier and grader JSON schemas
- Predict/Test/Recall as the moment types
- the 0-3 grading scale shape
- fail-open behavior when Claude classification or grading fails

## Privacy

Learning Moments stores logs and configuration locally in `.learning-moments/`, which `init` adds to `.gitignore`.

There is no Learning Moments backend and no external telemetry. However, classification and grading are not local inference: selected redacted context is sent through your configured Claude Code model provider by calling `claude -p`.

The tool applies local pattern-based redaction before sending diffs to Claude, but redaction is not a guarantee. Review your project and configuration before using this on sensitive code.

## Development

```bash
git clone https://github.com/raghubetina/learning-moments.git
cd learning-moments
npm install
npm run build
npm test
```

Run locally from this repo:

```bash
npm run dev -- init
npm run dev -- status
npm run dev -- doctor
```

After building, the CLI entrypoint is:

```bash
node dist/cli.js --help
```

## License

MIT
