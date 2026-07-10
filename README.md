# Learning Moments

**Keep the speed of AI-assisted programming without giving up the habit of understanding your code.**

[![npm version](https://img.shields.io/npm/v/learning-moments.svg)](https://www.npmjs.com/package/learning-moments)
[![CI](https://github.com/raghubetina/learning-moments/actions/workflows/ci.yml/badge.svg)](https://github.com/raghubetina/learning-moments/actions/workflows/ci.yml)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.md)

Learning Moments is a local, low-interruption comprehension layer for Claude Code.

AI coding agents can inspect a codebase, plan a change, edit files, run tests, and summarize the result. That is useful, but it can also let us move on without doing the tracing, prediction, explanation, and test reasoning that build durable system understanding.

Learning Moments selectively puts a little of that cognitive work back. After a meaningful change during a Claude Code session, it may ask one short question about the actual files you are working on:

> **Learning Moment `lm_a7f3`**
> The new retry branch treats timeouts differently from other failures. What behavior would you expect after the final timeout, and what test would distinguish it from the old behavior?

You answer in the normal Claude Code conversation. Learning Moments gives brief feedback and the work continues. If the change does not support a useful, specific question, or if selection fails, it stays quiet.

The aim is not to turn work into a course. It is to expose the gap between accepting code and being able to explain, predict, or test it. Learning Moments complements code review and tests by exercising understanding before a session change becomes code you are expected to maintain.

Running a hook inside an active codebase asks for substantial trust. Learning Moments is deliberately unobfuscated, has no runtime dependencies or install-time scripts, and provides a verifiable path from the public GitHub source to the npm package. See [Inspectability and package integrity](#inspectability-and-package-integrity).

## Status

Learning Moments is an **early alpha for local testing and research prototypes**.

Implemented today:

- project-local installation through Claude Code Hooks;
- Git-based detection of changes made during the current Claude Code session;
- situated **Predict** and **Test** questions selected with `claude -p`;
- answer capture, skipping, structured 0-3 grading, and brief feedback;
- configurable question and classifier budgets;
- local timing, usage, cost, and outcome metrics;
- project/session pause controls and observe-only mode;
- secret-path filtering, pattern redaction, and local integrity auditing; and
- fail-open behavior: a Learning Moments failure does not block Claude Code.

Not implemented yet:

- delayed recall across sessions ([issue #15](https://github.com/raghubetina/learning-moments/issues/15));
- background classification; the classifier currently adds synchronous hook latency ([issue #14](https://github.com/raghubetina/learning-moments/issues/14));
- confidence prompts or polished research exports; and
- support for coding agents other than Claude Code.

## What I can claim so far

After using Learning Moments in my own work for several weeks, I cannot honestly say whether it will prevent long-term skill decay. The current prototype cannot establish that, and delayed recall is not implemented yet.

I can say that it makes it impossible for me to ignore how much code I accept without fully understanding it. A specific question about a change often reveals that I cannot yet predict its behavior, explain a decision, or name the test that would expose a mistake.

That is the present value proposition: an immediate check on comprehension. Whether repeated checks improve long-term retention remains a research question.

## Quick start

### Requirements

- Node.js 20 or newer
- Git
- a recent Claude Code version with Hooks support
- Claude Code authenticated on your machine
- a Git repository you trust

Learning Moments calls `claude -p` using your existing Claude Code authentication and model configuration. Those calls can consume usage and may incur provider charges.

### Install

```bash
npm install -g learning-moments
```

Initialize it in a project where you use Claude Code:

```bash
cd /path/to/your/project
learning-moments init
learning-moments doctor
```

Then start Claude Code normally:

```bash
claude
```

`init` creates project-local configuration under `.learning-moments/`, adds that directory to `.gitignore`, installs hooks in `.claude/settings.local.json`, and creates `/learning-moments:*` command prompts. It is safe to rerun after an upgrade.

By default, Learning Moments asks at most **one question per hour**, with at least **20 minutes between questions**. It is intentionally not triggered by every edit.

### Try it without automatic questions

Observe-only mode runs selection and records what would have happened, but does not inject questions:

```bash
learning-moments init --observe-only
```

Observe-only mode still calls Claude for candidate selection, so it can add latency and consume usage.

### Install from an auditable checkout

The package runs directly from readable JavaScript. There is no generated `dist/` bundle.

```bash
git clone https://github.com/raghubetina/learning-moments.git
cd learning-moments
npm ci --ignore-scripts
node src/cli.js init
node src/cli.js doctor
```

Hooks installed this way point to that checkout's absolute `src/cli.js` path, so you can inspect or pin the exact implementation being executed.

## How it works

```text
Claude Code session starts
        |
        v
Record a Git working-tree baseline
        |
        v
Claude edits files ---> compare with the baseline
        |
        v
Filter ignored paths, bound context, skip symlinks/binaries,
and redact likely secrets
        |
        v
Use `claude -p` to decide whether the change contains a
specific, worthwhile Learning Moment
        |
        +--- decline / timeout / error ---> stay quiet
        |
        v
Check the interruption budget and inject one short question
        |
        v
Capture the next answer or "skip" ---> grade ---> brief feedback
```

The lifecycle is implemented with six Claude Code hooks:

1. `SessionStart` records the current branch, commit, dirty paths, and content fingerprints.
2. `PostToolUse` records lightweight edit telemetry.
3. `PostToolBatch` finds files that changed since the session baseline and selects a candidate moment.
4. `UserPromptSubmit` captures and grades the answer to a pending question.
5. `Stop` checks whether the question or feedback was actually displayed.
6. `UserPromptExpansion` records slash-command hook activity.

Change attribution is session-relative. Learning Moments can tell that a file changed after the baseline; it cannot prove that every byte came from Claude rather than an external editor used during the same session.

### Question types

- **Predict:** Explain what behavior changed or what might break.
- **Test:** Name a concrete check that would expose a misunderstanding.
- **Recall:** Retrieve the rationale for an earlier change. This is part of the design vocabulary but is not implemented yet.

The selector generates an expected-answer outline for grading, but that outline is not inserted into the conversation before you answer.

## Commands

| Command | Purpose |
| --- | --- |
| `learning-moments init` | Create local data, hooks, and command prompts |
| `learning-moments doctor` | Check the installation and required tools |
| `learning-moments status` | Show mode, pause state, frequency, and answer counts |
| `learning-moments metrics [--since 7d]` | Report latency, outcomes, usage, and estimated cost |
| `learning-moments verify` | Print a question about meaningful current uncommitted changes |
| `learning-moments pause --project` | Stop asking questions in this project |
| `learning-moments resume --project` | Resume questions in this project |
| `learning-moments override <id> --grade 0-3` | Record a manual grade correction |
| `learning-moments audit` | Verify installed package files against the shipped manifest |
| `learning-moments uninstall` | Remove hooks and slash commands but keep learning data |
| `learning-moments delete-data --logs-only` | Truncate disposable telemetry only |
| `learning-moments delete-data` | Delete all project-local Learning Moments data |

Claude Code command prompts are also installed for status, metrics, pause, resume, and manual verification.

## Configuration

Learning Moments separates stable integration code from editable pedagogical policy:

```text
.learning-moments/
|-- config.json
|-- profile.md
|-- prompts/
|   |-- classify-change.md
|   |-- grade-answer.md
|   |-- answer-feedback.md
|   |-- select-recall.md
|   `-- verify.md
|-- ledger.jsonl
|-- control.jsonl
`-- telemetry.jsonl
```

- `profile.md` describes the skills you want to preserve and your interruption preferences.
- `classify-change.md` defines what makes a question worthwhile.
- `grade-answer.md` defines the 0-3 rubric and feedback style.
- `config.json` controls models, timeouts, budgets, ignored paths, and context limits.

Important defaults:

| Setting | Default |
| --- | ---: |
| Visible questions per hour | 1 |
| Minimum spacing | 20 minutes |
| Classifier calls per hour | 10 |
| Maximum changed paths | 20 |
| Maximum diff/context | 12,000 characters |
| Classifier model | `opus` |
| Grader model | `opus` |
| Model-call timeout | 45 seconds |

`init` preserves valid existing configuration, profiles, and prompt policies. It refreshes the installed hooks and Claude Code command files.

## Privacy and trust

Learning Moments stores its own data locally and uses your configured Claude provider for inference. It has no backend and sends no product telemetry to the project author. Configuration and event records stay in the Git-ignored `.learning-moments/` directory. Candidate diffs and answers are sent through your configured Claude Code model provider when Learning Moments calls `claude -p`.

Before a model call, the tool:

- excludes common generated and secret-bearing paths such as `node_modules/**`, `.env*`, `.npmrc`, `.ssh/**`, private-key extensions, and lockfiles;
- refuses to follow symbolic links while gathering file context;
- skips large and binary untracked files;
- caps both path count and context size;
- redacts common credential formats in diffs and answers;
- disables tools, hooks, slash commands, and session persistence in the nested Claude process; and
- validates model responses against strict JSON schemas.

These controls reduce risk; they do not make redaction infallible. Review `.learning-moments/config.json` and `src/core/redaction.js` before using the tool on sensitive code. Use it only in repositories you trust. Claude Code's non-interactive `-p` mode does not show the workspace trust dialog.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and [AUDIT.md](AUDIT.md) for the current code-review record and residual risks.

### Local storage classes

- `ledger.jsonl` is the durable learning record: questions, answers, grades, and model-call usage.
- `control.jsonl` contains bounded operational state such as session baselines and recent classifier claims.
- `telemetry.jsonl` contains disposable hook timing and failure outcomes.

`learning-moments delete-data --logs-only` truncates only telemetry. Full deletion removes the entire `.learning-moments/` directory.

## Inspectability and package integrity

Installing a hook that runs inside active projects, reads changed code, and invokes a model asks users for substantial trust. Transparency is therefore part of the product, not just part of its documentation.

Learning Moments is designed so the code that runs is the code you can inspect:

- unobfuscated, source-executed ESM JavaScript;
- no bundling, minification, or generated runtime artifact;
- zero runtime npm dependencies;
- no npm install-time lifecycle scripts;
- CI on the declared Node 20 floor;
- package metadata that identifies this public GitHub repository;
- npm Trusted Publishing from GitHub Actions, without a long-lived npm publish token;
- an npm provenance attestation connecting the published package to its source repository and workflow; and
- a SHA-256 manifest that accounts for every expected shipped source file and flags unexpected ones.

You can inspect the latest version's registry attestation without installing it:

```bash
npm view learning-moments dist.attestations --json
```

The [npm package page](https://www.npmjs.com/package/learning-moments) exposes the attested source commit, build workflow, and public transparency-log entry. [npm also documents](https://docs.npmjs.com/viewing-package-provenance/) how `npm audit signatures` verifies registry signatures and provenance for packages downloaded into a local npm project.

After installation, run:

```bash
learning-moments audit
```

The command reports installation mode, hook entrypoints, runtime dependencies, lifecycle scripts, prompt files, and any missing, unexpected, or modified shipped file. These measures do not prove that the software is safe. They make its implementation, package contents, and GitHub-to-npm provenance independently inspectable.

## Performance and cost

Model selection and grading are visible costs, not hidden implementation details:

```bash
learning-moments metrics
learning-moments metrics --since 7d
learning-moments metrics --since 24h --json
```

Metrics include:

- total hook runs, median latency, and p95 latency;
- classifier attempts, declines, duplicates, and fail-open outcomes;
- answer-feedback attempts and failures;
- questions, answers, skips, and grades; and
- Claude-reported token use and estimated cost.

The current classifier runs synchronously in `PostToolBatch`, so eligible classification attempts can noticeably pause the workflow. Frequency gating avoids many unnecessary calls, but the architectural fix is the background pipeline tracked in [issue #14](https://github.com/raghubetina/learning-moments/issues/14).

## Related projects

Several projects are exploring how developers can keep learning while they work with coding agents. They share much of the motivation behind Learning Moments and make different choices about timing, depth, and product form.

| Project | When it intervenes | What it offers |
| --- | --- | --- |
| [Learning Opportunities](https://github.com/DrCatHicks/learning-opportunities) | On request, or after substantial work and commits | Open-source Claude Code and Codex skills for optional 10-15 minute exercises, retrieval check-ins, and codebase orientation |
| [StaySharp](https://staysharp.dev/) | When the developer runs `/learn` after a session | An early-access hosted dashboard with a generated lesson and optional short quiz |
| Learning Moments | After selected changes during a Claude Code session | A brief question inside the coding conversation, followed by structured feedback and local research metrics |

These approaches can be complementary. Learning Opportunities is designed for richer, longer exercises and guided exploration. StaySharp turns a completed session into material that can be reviewed later. Learning Moments' distinctive combination is timing, granularity, restraint, and instrumentation: one in-flow question selected from actual session changes, under a strict interruption budget, with structured local outcomes. We are glad to see other people working on this problem and expect the projects to learn from one another.

## Why this design

Learning Moments starts from a narrow concern: AI assistance can reduce opportunities to rehearse the comprehension and judgment routines developers still need to supervise and maintain software.

The design draws on several lines of research:

- [skill decay under nonuse](https://doi.org/10.1207/s15327043hup1101_3);
- [the out-of-the-loop problem in automation](https://doi.org/10.1518/001872095779064555);
- [retrieval practice and long-term retention](https://doi.org/10.1111/j.1467-9280.2006.01693.x);
- [self-explanation as a learning mechanism](https://doi.org/10.1207/s15516709cog1302_1);
- [the navigator's role in pair programming](https://doi.org/10.1016/j.ijhcs.2007.03.005); and
- [cognitive-engagement interfaces for AI-generated code](https://doi.org/10.1145/3708359.3712104).

Those findings motivate five product choices:

1. Require generation, not mere recognition.
2. Ask about the developer's actual change, not generic trivia.
3. Ask while the relevant code is still in working memory.
4. Prefer concrete prediction, explanation, and verification.
5. Enforce interruption budgets and prefer silence over a weak question.

Structured local outcomes and observe-only mode make the intervention measurable without requiring a Learning Moments backend.

This prototype does **not** establish that Learning Moments prevents long-term deskilling. Immediate questions test feasibility and situated comprehension. Delayed recall and comparison designs are needed to study retention more directly.

## Development

```bash
git clone https://github.com/raghubetina/learning-moments.git
cd learning-moments
npm ci --ignore-scripts
npm run check
npm test
node src/cli.js --help
```

The test suite mocks Claude model calls; running it does not consume Claude usage.

Release verification additionally checks npm advisories, the shipped-file manifest, and installation from the packed tarball. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

## Roadmap

The next two meaningful product steps are deliberately larger than polish:

1. [Move classification off the blocking hook path](https://github.com/raghubetina/learning-moments/issues/14).
2. [Add delayed recall for prior Learning Moments](https://github.com/raghubetina/learning-moments/issues/15).

Bug reports and small, well-tested improvements are welcome. For research use, the repository includes [citation metadata](CITATION.cff).

## License

[MIT](LICENSE.md)
