# Learning Moments

**Keep the speed of AI-assisted programming without giving up the habit of understanding your code.**

[![npm version](https://img.shields.io/npm/v/learning-moments.svg)](https://www.npmjs.com/package/learning-moments)
[![CI](https://github.com/raghubetina/learning-moments/actions/workflows/ci.yml/badge.svg)](https://github.com/raghubetina/learning-moments/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.md)

Learning Moments asks brief questions about changes made during a Claude Code session.

AI coding agents can inspect a codebase, plan a change, edit files, run tests, and summarize the result. Their speed also makes it easy to move on before tracing the code, predicting its behavior, or deciding how to test it.

The approach is borrowed from aviation. As autopilots took over routine flying, the FAA warned airlines that "continuous use of those systems does not reinforce a pilot's knowledge and skills in manual flight operations" and urged them to make sure pilots keep practicing by hand ([SAFO 13002](https://www.faa.gov/sites/faa.gov/files/other_visit/aviation_industry/airline_operators/airline_safety/SAFO13002.pdf), 2013; see also the [Flight Deck Automation Working Group report](https://www.faa.gov/sites/faa.gov/files/aircraft/air_cert/design_approvals/human_factors/OUFPMS_Report.pdf)). Learning Moments applies the same idea to AI-assisted programming: keep the automation, and keep exercising the skills it would otherwise replace.

When Claude finishes a turn that made a meaningful change, Learning Moments may ask one short question about it:

> **Learning Moment `lm_a7f3`**
> The new retry branch treats timeouts differently from other failures. What behavior would you expect after the final timeout, and what test would distinguish it from the old behavior?

You answer in the normal Claude Code conversation. Learning Moments gives brief feedback and the work continues. If the change does not support a useful, specific question, or if selection fails, it stays quiet.

Each question checks whether you can explain, predict, or test code you just accepted. It supplements code review and tests with a quick comprehension check while the change is still fresh.

Because the hook runs inside active projects, the package is unobfuscated, has no runtime dependencies or install-time scripts, and includes checks that connect the public GitHub source to the npm package. See [Inspectability and package integrity](#inspectability-and-package-integrity).

`learning-moments metrics` reports added time and estimated model cost, with token counts available in JSON. One pause command stops the questions when you need uninterrupted work. The learning profile, selection policy, and grading rubric are Markdown files you can edit without rebuilding or reinstalling anything.

## Contents

- Get started with the [quick start](#quick-start), [commands](#commands), and [configuration](#configuration).
- Read the [project status](#status), [current claims](#what-i-can-claim-so-far), [hook lifecycle](#how-it-works), and [design rationale](#why-this-design).
- Review [privacy and trust](#privacy-and-trust), [package integrity](#inspectability-and-package-integrity), and [performance and cost](#performance-and-cost).
- See [related projects](#related-projects), [development](#development), the [roadmap](#roadmap), and the [license](#license).

## Status

Learning Moments is an **early alpha for local testing and research prototypes**.

Implemented today:

- installation as a Claude Code plugin or with npm, acting only in projects you initialize;
- Git-based detection of changes made during the current Claude Code session;
- situated **Predict** and **Test** questions, selected in the background with `claude -p` and asked when Claude finishes its turn;
- answer capture, skipping, structured 0-3 grading, and brief feedback;
- delayed recall: earlier questions come back in later sessions, spaced 1, 7, then 30 days apart;
- configurable question and classifier budgets;
- local timing, usage, cost, and outcome metrics;
- project/session pause controls and observe-only mode;
- secret-path filtering, pattern redaction, and local integrity auditing; and
- fail-open behavior: a Learning Moments failure does not block Claude Code.

Not implemented yet:

- confidence prompts or polished research exports; and
- support for coding agents other than Claude Code.

## What I can claim so far

I have used Learning Moments in my own work for several weeks. That is too little evidence to say whether it prevents long-term skill decay, especially without delayed recall.

In that time, its questions have regularly shown me that I accepted code without fully understanding it. A specific question often reveals that I cannot yet predict the behavior, explain a decision, or name the test that would expose a mistake.

For now, I can say only that it checks comprehension in the moment. I do not yet know whether repeated checks improve long-term retention.

## Quick start

### Requirements

- Node.js 22 or newer
- Git
- a recent Claude Code version with Hooks support
- Claude Code authenticated on your machine
- a Git repository you trust

Learning Moments calls `claude -p` using your existing Claude Code authentication and model configuration. Those calls can consume usage and may incur provider charges.

### Install as a Claude Code plugin

In Claude Code:

```text
/plugin install learning-moments --marketplace raghubetina/learning-moments
```

The marketplace in this repository installs the published npm package, so the plugin is the same provenance-attested files that `learning-moments audit` checks, fetched without install scripts. Claude Code doesn't auto-update third-party marketplaces by default: turn on **Enable auto-update** for this marketplace under `/plugin` → **Marketplaces**, or run `claude plugin update learning-moments@learning-moments` in a shell after a release and then `/reload-plugins`.

The plugin acts only in projects where you turn it on. Open Claude Code in a project and run:

```text
/learning-moments:init
```

That creates `.learning-moments/` for the project and ignores it in the repository's `.git/info/exclude`. The plugin supplies the hooks and the `/learning-moments:*` commands.

### Install with npm

```bash
npm install -g learning-moments
cd /path/to/your/project
learning-moments init
learning-moments doctor
```

`init` creates `.learning-moments/`, installs hooks in `.claude/settings.local.json`, writes `/learning-moments:*` commands, and ignores both in `.git/info/exclude`. The hooks and commands run this install's absolute `src/cli.js` path, so after upgrading Node or the package, run `init` again; `learning-moments doctor` reports hooks that point at a missing or older install. If you later switch to the plugin, run `/learning-moments:init` once in each project to remove the settings hooks, so hooks don't run twice.

By default, Learning Moments asks at most **one question per hour**, with at least **20 minutes between questions**. It is intentionally not triggered by every edit.

When you just need to get work done, pause it from Claude Code:

```text
/learning-moments:pause
```

Resume later with `/learning-moments:resume`. Pausing does not uninstall the hooks or delete your learning record. To ask for a question when it suits you, run `/learning-moments:verify`.

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

Hooks installed this way point to that checkout's absolute `src/cli.js` path, so you can inspect or pin the exact implementation being executed. To load the checkout as a plugin for one session instead, run `claude --plugin-dir /path/to/learning-moments` and `/learning-moments:init`.

## How it works

```text
Claude Code session starts
        |
        v
Record a Git working-tree baseline
        |
        v
Claude edits files ---> compare with the baseline (in the background;
        |                Claude keeps working)
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
Claude finishes its turn ---> check the interruption budget
        |                     and ask the one selected question
        v
Read your reply ---> grade, explain, or set aside ---> brief feedback
```

The lifecycle is implemented with six Claude Code hooks:

1. `SessionStart` records the current branch, commit, dirty paths, and content fingerprints once per session; resuming, compacting, or clearing keeps that baseline.
2. `PostToolUse` records lightweight edit telemetry in the background.
3. `PostToolBatch` runs in the background after each batch of tool calls. It finds files that changed since the session baseline and, when one is worth it, selects a question. Claude does not wait for it.
4. `Stop` asks the selected question when Claude finishes its turn, and checks whether earlier questions and feedback were displayed.
5. `UserPromptSubmit` reads your reply to an open question. Claude gives brief feedback right away, judged against the code it already has in context; a separate background process grades the reply against the hidden answer outline for your local record.
6. `UserPromptExpansion` records slash-command activity in the background.

A question appears in the transcript as Stop hook feedback, and Claude then asks it. Questions arrive at the end of a turn rather than in the middle of a task, so you can read Claude's summary and the question together, and Claude's work is never paused waiting for an answer. A selected question that is not asked within 30 minutes is dropped.

Each look at the working tree considers only what changed since the classifier last looked, newest files first, and diffs files that were already uncommitted when the session began against their state at that point, so your own earlier edits are not presented as Claude's. The classifier is also told which questions were asked recently, so it does not repeat them.

Change attribution is session-relative. Learning Moments can tell that a file changed after the baseline; it cannot prove that every byte came from Claude rather than an external editor used during the same session.

The hooks act only in a project where `learning-moments init` ran, and never create `.learning-moments/` anywhere else, even when Claude runs `cd` into another repository. In a linked worktree of an initialized project, such as a Claude Code worktree session, Learning Moments reads changes from the worktree and keeps its records in the main checkout. Tool calls made inside subagents are not asked about directly; their edits are picked up when the main conversation's tool batch ends.

### Question types

- `Predict` asks what behavior changed or what might break.
- `Test` asks for a concrete check that would expose a misunderstanding.
- `Recall` asks, in a later session, about an earlier question's change, to be answered from memory before looking at the code.

### Delayed recall

A question you were asked comes back in a later session, a day after it was asked, then 7 days after that recall, then 30. A weak answer or "I don't know" brings it back after a day instead, up to three recalls per question. Recalls use the recall prompt the selector writes with each question, are asked at the end of a turn only when no new question is waiting, share the hourly question budget, and are limited per session by `frequency.session_start_recall_limit` (default 1; set it to `0` to turn recall off). A recall nobody gets to within a week of falling due is dropped. The grader is told an answer is a recall, so it rewards remembered purpose and risk rather than exact names.

The selector also writes an expected-answer outline. Only the background grader sees it; it enters the conversation only if you say you don't know, as the explanation.

### Replying to a question

Your next message after a question is read as a reply, with a few exceptions so that ordinary work is never graded as a wrong answer:

- `skip`, `not now`, or `later` declines the question, and so do `proceed`, `continue`, and `ok`.
- `/learning-moments:pause` declines the question and pauses the project.
- Other slash commands, and messages Claude Code sends on its own (such as a background agent's report), leave the question open.
- "I don't know" or "not sure" gets a short explanation instead of a grade.
- A message that is not an attempt, such as a new instruction, gets no feedback; the grader records it as `not_an_answer`.

Only one question is open per session, and a question nobody answers within two hours stops capturing messages.

## Commands

| Command | Purpose |
| --- | --- |
| `learning-moments init` | Create local data, hooks, and command prompts |
| `learning-moments doctor` | Check the installation and required tools |
| `learning-moments status` | Show mode, pause state, frequency, counts, and the last question |
| `learning-moments metrics [--since 7d]` | Report latency, outcomes, usage, and estimated cost |
| `learning-moments verify [--session <id>]` | Ask a question about current uncommitted changes; `/learning-moments:verify` opens it in the session so your reply is read and graded |
| `learning-moments pause --project` | Stop asking questions in this project |
| `learning-moments resume --project` | Resume questions in this project |
| `learning-moments override <id> --grade 0-3` | Replace a question's grade, by its `lm_xxxx` ID |
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
|   `-- verify.md
|-- ledger.jsonl
|-- control.jsonl
`-- telemetry.jsonl
```

- `profile.md` describes the skills you want to preserve and your interruption preferences.
- `classify-change.md` defines what makes a question worthwhile.
- `grade-answer.md` defines the 0-3 rubric the background grader uses.
- `config.json` controls models, timeouts, budgets, ignored paths, and context limits.
- `context_storage` in `config.json` sets how much redacted code is kept with each question for grading: `excerpts` (the default, up to 4,000 characters), `full`, or `metadata_only` (file names only).

The profile, classifier policy, and grading rubric are read again when the relevant model call runs. Edit the Markdown, save it, and the next selection or grading call uses the new policy. There is no prompt build step and no restart required.

Defaults:

| Setting | Default |
| --- | ---: |
| Visible questions per hour | 1 |
| Minimum spacing | 20 minutes |
| Classifier calls per hour | 10 |
| Maximum changed paths | 20 |
| Maximum diff/context | 12,000 characters |
| Classifier model | `opus` |
| Grader model | `opus` |
| Classifier and grader effort | `low` |
| Model-call timeout | 45 seconds |

`init` preserves valid existing configuration, profiles, and prompt policies. It refreshes the installed hooks and Claude Code command files.

## Privacy and trust

Learning Moments stores its own data locally and uses your configured Claude provider for inference. It has no backend and sends no product telemetry to the project author. Configuration and event records stay in the Git-ignored `.learning-moments/` directory. Candidate diffs and answers are sent through your configured Claude Code model provider when Learning Moments calls `claude -p`.

Before a model call, the tool:

- always excludes credential files at any depth, whatever `config.json` says: `.env*`, `.envrc`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `.aws/`, `.ssh/`, `.gnupg/`, SSH and TLS private keys, keystores, and Terraform state (see `BUILTIN_IGNORED_PATHS` in `src/core/filter.js`);
- always excludes lockfiles and its own `.learning-moments/` data, and applies your `ignore` patterns on top;
- refuses to follow symbolic links while gathering file context;
- passes filenames to Git as literal paths, never as pathspec patterns, and disables external diff and textconv programs;
- skips files over 1 MB and binary untracked files;
- caps both path count and context size;
- redacts common credential formats in diffs and answers, file by file, before the context limit truncates anything;
- runs the nested Claude process with built-in tools, MCP servers and tools, hooks, slash commands, CLAUDE.md files, auto memory, and session persistence disabled; and
- validates model responses against strict JSON schemas.

These controls reduce exposure but cannot catch every secret. Review `.learning-moments/config.json` and `src/core/redaction.js` before using the tool on sensitive code. Use it only in repositories you trust. Claude Code's non-interactive `-p` mode does not show the workspace trust dialog.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and [AUDIT.md](AUDIT.md) for the current code-review record and residual risks.

### Local storage classes

- `ledger.jsonl` is the durable learning record: questions, answers, grades, and model-call usage.
- `control.jsonl` contains bounded operational state such as session baselines and recent classifier claims.
- `telemetry.jsonl` contains disposable hook timing and failure outcomes.

`learning-moments delete-data --logs-only` truncates only telemetry. Full deletion removes the entire `.learning-moments/` directory.

## Inspectability and package integrity

Learning Moments is designed so you can inspect the code that runs inside your projects:

- unobfuscated, source-executed ESM JavaScript;
- no bundling, minification, or generated runtime artifact;
- zero runtime npm dependencies;
- no npm install-time lifecycle scripts;
- CI on the declared Node 22 floor and on Node 24 and 26;
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

The command reports installation mode, hook entrypoints, runtime dependencies, lifecycle scripts, prompt files, and any missing, unexpected, or modified shipped file. These checks expose the implementation, package contents, and GitHub-to-npm provenance for independent review. Assessing whether the software is safe still requires reading the code and considering the repository where it will run.

## Performance and cost

Model selection and grading cost time and tokens. Each nested call sends only Learning Moments' own instructions, your profile, and the bounded context, with an explicit effort level (`claude.classifier_effort` and `claude.grading_effort`, default `low`). Set either to `default` to inherit your Claude Code `effortLevel` instead; higher levels made classification slower and costlier without clearly better questions in local testing.

Learning Moments records hook latency, classifier and grader latency, token use, cache tokens, Claude-reported estimated cost, and why a failed model call failed (for example `timeout`, `rate_limited`, or `invalid_output`):

```bash
learning-moments metrics
learning-moments metrics --since 7d
learning-moments metrics --since 24h --json
```

Metrics include:

- questions asked, answered, "don't know", skipped (by kind), not-an-answer, and expired, with rates;
- the grade distribution and mean, counting a manual override in place of the model's grade;
- how long Claude waited on Learning Moments' synchronous hooks, and median and p95 latency per hook;
- classifier calls, declines, duplicates, and failures by reason; and
- Claude-reported token use, estimated cost, and cost per question asked.

Selection and grading both run in the background, so they cost tokens but not waiting time.

## Related projects

Other projects are also exploring how developers can keep learning while they work with coding agents:

| Project | When it intervenes | What it offers |
| --- | --- | --- |
| [Learning Opportunities](https://github.com/DrCatHicks/learning-opportunities) | On request, or after substantial work and commits | Open-source Claude Code and Codex skills for optional 10-15 minute exercises, retrieval check-ins, and codebase orientation |
| [StaySharp](https://staysharp.dev/) | When the developer runs `/learn` after a session | An early-access hosted dashboard with a generated lesson and optional short quiz |
| Learning Moments | After selected changes during a Claude Code session | A brief question inside the coding conversation, followed by structured feedback and local research metrics |

Learning Opportunities provides longer exercises and guided exploration. StaySharp turns a completed session into material for later review. Learning Moments stays in the coding conversation: it selects one brief question from session changes, enforces an interruption budget, reports model cost, and stores outcomes locally.

## Why this design

Learning Moments starts from a narrow concern: AI assistance can reduce opportunities to rehearse the comprehension and judgment routines developers still need to supervise and maintain software.

The design draws on aviation safety guidance and several lines of research:

- aviation guidance on keeping manual flying skills alongside autopilot use ([FAA SAFO 13002](https://www.faa.gov/sites/faa.gov/files/other_visit/aviation_industry/airline_operators/airline_safety/SAFO13002.pdf) and the [PARC/CAST Flight Deck Automation Working Group report](https://www.faa.gov/sites/faa.gov/files/aircraft/air_cert/design_approvals/human_factors/OUFPMS_Report.pdf));
- [skill decay under nonuse](https://doi.org/10.1207/s15327043hup1101_3);
- [the out-of-the-loop problem in automation](https://doi.org/10.1518/001872095779064555);
- [retrieval practice and long-term retention](https://doi.org/10.1111/j.1467-9280.2006.01693.x);
- [self-explanation as a learning mechanism](https://doi.org/10.1207/s15516709cog1302_1);
- [the navigator's role in pair programming](https://doi.org/10.1016/j.ijhcs.2007.03.005); and
- [cognitive-engagement interfaces for AI-generated code](https://doi.org/10.1145/3708359.3712104).

The design follows five rules:

1. Use questions that require the developer to produce an answer.
2. Tie each question to the current change.
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

Next: an optional Claude Code pane that shows the question with an answer field ([experimental](#experimental-question-pane)), and comparison designs (some eligible changes asked, others only recalled later) to study retention.

Bug reports and small, well-tested improvements are welcome. For research use, the repository includes [citation metadata](CITATION.cff).

## License

[MIT](LICENSE.md)
