# Learning Moments

Learning Moments is an experimental Claude Code integration that adds brief checks of developer understanding to AI-assisted programming.

It watches project changes during Claude Code sessions and uses `claude -p` to decide whether there is a specific, situated question worth asking. When there is, it injects a short question into the normal Claude Code flow. When selection fails, declines, or times out, it stays quiet and lets the workflow continue.

Learning Moments is for exercising understanding before moving on from AI-assisted changes. It is meant to complement tests, code review, and project instructions.

## Status

This is an early alpha intended for local testing and research prototypes.

Current capabilities:

- initialize project-local Learning Moments data
- install Claude Code hooks into `.claude/settings.local.json`
- create Claude Code slash command prompt files
- track file changes during a Claude Code session
- select candidate Learning Moments with `claude -p`
- ask an initial question in the normal Claude Code flow
- capture the next user answer
- use Claude Code to provide brief graded feedback
- report hook latency and Claude-reported token/cost estimates
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

Learning Moments uses `claude -p` internally to select moments and give answer feedback, so it uses your existing Claude Code authentication and model configuration.

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

Start Claude Code normally from that project directory. When Learning Moments selects a candidate, it adds a short question to the normal chat flow.

## Upgrade

Update the global CLI:

```bash
npm install -g learning-moments@latest
```

Then run this inside each project that uses Learning Moments:

```bash
learning-moments init
learning-moments doctor
```

`init` is safe to rerun. It updates missing hook and slash command files without deleting your local Learning Moments data.

## Verifying the install

Each release is built and published from GitHub Actions and includes a [npm provenance attestation](https://docs.npmjs.com/generating-provenance-statements) cryptographically tying the tarball to a specific commit in this repository. There is no long-lived npm token; publishing uses npm Trusted Publishing via OIDC.

After installing, you can verify both layers of the trust chain:

```bash
npm audit signatures      # attestation: this tarball was built from the public repo
learning-moments audit    # local integrity: file hashes match MANIFEST.json
```

`npm audit signatures` checks the registry's signed attestation that the tarball was built by GitHub Actions from a specific commit of `raghubetina/learning-moments`. `learning-moments audit` then verifies that every shipped source file on disk matches the SHA-256 in `MANIFEST.json` that travelled with that tarball. Together they cover the chain from `git tag → CI build → registry → installed files`.

If you want to skip the registry entirely, [install from a git checkout](#development) instead — `learning-moments audit` will then show install mode `git-checkout`.

## Commands

```bash
learning-moments init
learning-moments doctor
learning-moments status
learning-moments metrics
learning-moments pause --project
learning-moments resume --project
learning-moments verify
learning-moments audit
learning-moments uninstall
learning-moments delete-data
```

`audit` prints the install mode, the absolute paths of the CLI and Claude Code hook entries, runtime dependencies, lifecycle scripts, and SHA-256 hashes of every shipped file, verified against `MANIFEST.json`. Audit exits non-zero if `MANIFEST.json` is missing, unparseable, or disagrees with any file on disk in either direction. Use `learning-moments audit --json` for a machine-readable report.

`uninstall` removes hooks and slash commands but keeps `.learning-moments/`.

`delete-data` removes local Learning Moments data.

To remove the global CLI from your machine:

```bash
npm uninstall -g learning-moments
```

For a full project cleanup, run `learning-moments uninstall`, then `learning-moments delete-data`, then remove the global npm package if you no longer use it anywhere.

## Performance and Cost Visibility

Learning Moments records local hook timing and Claude-reported usage for moment selection and answer feedback in `.learning-moments/moments.jsonl`.

Use:

```bash
learning-moments metrics
learning-moments metrics --since 7d
learning-moments metrics --json
```

The metrics command reports:

- hook run counts, median latency, and p95 latency
- moment-selection attempts, declined moments, selection failures that did not interrupt your workflow, and repeated changes skipped
- answer-feedback attempts and feedback failures that did not interrupt your workflow
- estimated cost for moment selection and answer feedback from Claude Code output
- prompt, answer, skip, and grade counts

Cost values are Claude Code's reported estimates. They may not match marginal dollars charged on a subscription plan.

## Customization

Learning Moments is configurable in the places you are most likely to tune. The integration code and log format stay fixed, while your goals and prompt policy live in project-local Markdown.

Editable files created by `learning-moments init`:

- `.learning-moments/profile.md`: skill-retention goals and preferences.
- `.learning-moments/prompts/classify-change.md`: what counts as a valuable Learning Moment.
- `.learning-moments/prompts/grade-answer.md`: grading rubric and feedback style.
- `.learning-moments/prompts/answer-feedback.md`: reserved for feedback prompt tuning.
- `.learning-moments/prompts/select-recall.md`: reserved for delayed recall selection.
- `.learning-moments/prompts/verify.md`: reserved for manual verification prompts.

Editable config in `.learning-moments/config.json`:

- model aliases and timeouts for moment-selection and answer-feedback calls
- immediate prompt frequency and minimum spacing
- observe-only mode vs asking questions
- ignored paths/extensions
- context limits

By default, moment-selection and answer-feedback calls use Claude Code's `opus` model alias. You can change this in `.learning-moments/config.json`.

Fixed in the MVP:

- Claude Code hooks as the integration surface
- Git-based change detection
- structured response schemas for moment selection and answer feedback
- Predict/Test/Recall as the moment types
- the 0-3 grading scale shape
- quiet behavior when Claude moment selection or answer feedback fails

## Privacy

Learning Moments stores logs and configuration locally in `.learning-moments/`, which `init` adds to `.gitignore`.

There is no Learning Moments backend and no external telemetry. However, moment selection and answer feedback are not local inference: code diffs and the answers you type are sent through your configured Claude Code model provider by calling `claude -p`.

The tool applies local pattern-based redaction to both code diffs *and* user answers before sending them to Claude, and the redacted text is also what gets persisted to `.learning-moments/moments.jsonl` (raw answer text never leaves the hook). Redaction is not a guarantee — review your project and the redaction patterns in `src/core/redaction.js` before using this on sensitive code.

## Development

Learning Moments is a source-executed plain-JavaScript CLI. There is no build step: the `bin` entrypoint in `package.json` points directly at `src/cli.js`, and Claude Code hooks installed by `learning-moments init` invoke the same source file with an absolute path. No `dist/`, no bundling, no minification.

```bash
git clone https://github.com/raghubetina/learning-moments.git
cd learning-moments
npm ci --ignore-scripts
npm test
node src/cli.js --help
```

`--ignore-scripts` is recommended for audit-oriented workflows; the project itself defines no lifecycle scripts.

Run locally from this repo:

```bash
node src/cli.js init
node src/cli.js status
node src/cli.js doctor
node src/cli.js audit
```

To regenerate the shipped `MANIFEST.json` (SHA-256 baseline used by `learning-moments audit`):

```bash
npm run build-manifest
```

## License

MIT
