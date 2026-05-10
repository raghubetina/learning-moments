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
- call Claude Code in print mode to classify high-value Learning Moments
- inject an initial question through hook `additionalContext`
- capture the next user answer through `UserPromptSubmit`
- grade the answer with Claude Code and inject brief feedback
- pause/resume at project or session scope
- remove installed hooks without deleting local learning data

The classifier intentionally has no rules-based quizzing fallback. If the Claude-backed classifier fails, declines, or times out, Learning Moments logs the event and asks nothing.

By default, classifier and grader calls use Claude Code's `opus` model alias. You can change this in `.learning-moments/config.json`.

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
