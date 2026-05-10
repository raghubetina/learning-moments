# Learning Moments

Learning Moments is a local Claude Code hook tool for prompting brief, situated checks of developer understanding during AI-assisted programming.

This repository contains the implementation. The adjacent parent repository contains the paper drafts, research notes, and source corpus.

## Current Status

This is an early prototype. It can:

- initialize project-local Learning Moments data
- install Claude Code hooks into `.claude/settings.local.json`
- create slash command prompt files
- record session Git baselines and AI-authored file changes
- detect changed files since a session baseline
- inject an initial question through hook `additionalContext`
- capture the next user answer through `UserPromptSubmit`
- inject the hidden answer outline only after the user answers
- pause/resume at project or session scope
- remove installed hooks without deleting local learning data

The classifier is currently deterministic and conservative. The next major implementation step is replacing that boundary with the LLM-based classifier/grader while preserving the tested state machine.

## Development

```bash
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
