# Code audit

This audit covers Learning Moments `0.6.0` as reviewed on 2026-10-31. The release followed a whole-repository audit of `0.5.5` and was built as a series of reviewed pull requests (#34–#46). Each pull request was cross-reviewed by Codex, re-reviewed after fixes until no material findings remained, and merged only on green CI across Node 22, 24, and 26.

## Executive assessment

The question selection was already the strongest part of the product: in the author's own ledgers the selected questions were specific and well chosen. The defects were in everything around them, and `0.6.0` addresses them:

- Selection blocked Claude for 16–45 seconds per eligible tool batch, and its question was injected mid-task with instructions to wait. Selection now runs in an `async` hook and the question is asked when Claude finishes its turn.
- The nested `claude -p` loaded the developer's MCP servers, CLAUDE.md, auto memory, and effort level. Fixed overhead fell from about 20,000 input tokens to about 1,000 per call, and MCP tools are no longer callable.
- Four privacy protections described in the README did not hold (root-only secret paths, truncation before redaction, pathspec filenames, unexcluded lockfiles). All four are fixed and covered by regression tests that fail without the fix.
- Commands, "Proceed", background-agent reports, and "I'm not sure" were graded as wrong answers; in the author's ledgers five of seven graded replies were of this kind. Replies are now classified before grading.
- Hooks wrote `.learning-moments/` into any repository the session entered and failed in worktree sessions. They now act only in initialized projects and support linked worktrees.

No critical issue remains open from the review.

## Review methods

- A whole-repository audit by Claude and, independently, by Codex (`gpt-6-astra`, max effort), with a written rubric covering correctness, product purpose, user experience, architecture, the Claude Code hooks contract, privacy, and release gaps.
- Comparison against the current Claude Code documentation for hooks, async hooks, plugins, marketplaces, skills, permissions, and mods, read from code.claude.com rather than from memory.
- Analysis of the author's own Learning Moments data from seven projects (May–October 2026): selection latency and failures, token use, question delivery, and how replies were graded.
- Live measurement of nested-call overhead and of classifier latency, cost, and question quality at four effort levels on real diffs.
- Live end-to-end sessions in Claude Code 2.1.316 (tmux-driven, throwaway repositories) for end-of-turn delivery, answer feedback, background grading, the plugin install path, `/learning-moments:verify`, and the question band.
- Per-pull-request Codex reviews (`gpt-6.1-sol`, xhigh effort), each finding checked against the cited code before acting on it; every fix shipped with a regression test, and most tests were confirmed to fail without their fix.

## Findings addressed

### Model-call isolation (#35)

Nested calls pass `--strict-mcp-config` and `--disallowedTools "mcp__*"`, set `CLAUDE_CODE_DISABLE_CLAUDE_MDS` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, send the selector or grader policy as the system prompt, and set an explicit effort (`low` by default). Failed calls record a bounded failure category and any billed usage, including usage printed before a nonzero exit.

### Privacy boundaries (#36)

Credential files, lockfiles, and the tool's own data are excluded at any depth by a built-in list that applies regardless of `config.json`, including to changes measured against an older saved baseline. Each file's context is redacted whole before the budget truncates it, and a private key with no END marker is redacted to the end of the excerpt. Git reads filenames literally, with external diff and textconv programs disabled and conflicting inherited pathspec modes cleared. Redaction covers more token formats and connection-string passwords.

### Hook scoping (#37)

Hooks resolve an initialized project from `CLAUDE_PROJECT_DIR`, the working directory's repository, or a linked worktree's main checkout, and do nothing elsewhere; only `init` creates the data directory. Subagent tool batches are ignored. Resume and compaction keep the session baseline; `/clear` starts a new session, and with it a new baseline. A damaged JSONL line no longer breaks every reader, and tests can no longer reach a real project through an inherited `CLAUDE_PROJECT_DIR`.

### Answer capture (#38)

Replies are classified before grading: commands and automatic prompts leave the question open, skip and continue phrases decline it, "I don't know" gets an explanation, and non-answers get no feedback. One question is open per session, a seen question stays open across command turns, and an open question expires after two hours.

### The question loop (#40, #41, #42)

Selection runs in an `async` PostToolBatch hook and records a ready question; `Stop` asks it at the end of the turn as context the transcript also shows, phrased as facts rather than commands. The classifier budget is reserved under the claim lock. Each look at the working tree considers only what changed since the last one, newest first, built from blob versions captured once, so edits made while a hook waits are not lost; files are taken least recently reviewed first, so a large or often-edited file can't crowd the others out of the bounded context, pre-session edits are not presented as Claude's, a path is never read through a symlink, whether the file itself or a parent directory was replaced by one, and chmod-only changes are shown. Claude gives answer feedback itself, without the hidden outline, and a detached process records the structured grade with a redacted code excerpt.

### Records and tools (#43)

`verify` opens its question in the session so the reply is graded; `override` resolves the short ID; `metrics` reports outcomes, grade distribution (manual overrides win), time Claude waited on synchronous hooks, and cost per question, with attempt counts that survive control-log pruning; `audit --json` fails like the text output.

### Distribution (#44)

The package is also a Claude Code plugin whose marketplace source is the published npm package. Its hooks and skills are generated from the same templates `init` uses and checked for drift. Local files are ignored through `.git/info/exclude`. `doctor` reports hooks that point at a missing or different install, and hooks installed twice.

### Delayed recall (#45) and the question band (#46)

Questions return in later sessions on an expanding schedule (1, 7, 30 days), using the recall prompt the selector writes, now kept with each question. An opt-in, experimental Claude Code mod can show questions in a band above the prompt so that neither question nor answer enters Claude's context.

## Residual risks

### Redaction is best effort: medium

Credential paths are excluded and common formats redacted, but pattern matching cannot find every secret. Use the tool only in repositories you trust, review the ignore rules, and set `context_storage` to `metadata_only` to keep code excerpts out of the local ledger.

### Model-selected and model-graded answers: medium

The same model family selects questions, writes outlines, and grades answers. Grades are not ground truth; research use should sample and review them, and `override` records corrections.

### Claude relays end-of-turn questions: low

Hook-delivered questions reach the developer through Claude, which could paraphrase a question or hint at its answer. The transcript also shows the question verbatim as Stop hook feedback. The question band avoids the relay entirely but is experimental.

### Reply classification is heuristic: low

Commands, tagged automatic prompts, and common skip and "don't know" phrases are recognized by pattern; anything else is treated as a possible answer, and Claude or the grader sets aside non-answers. An untagged automatic prompt can still be graded as an answer.

### Async hooks under `claude -p`: low

Claude Code cancels async hooks when a non-interactive session ends, so a selection still running at that point is dropped. Interactive sessions are unaffected.

### Plugin updates are manual by default: low

Claude Code does not auto-update third-party marketplaces unless the user turns it on. The README documents both routes; `doctor` catches stale npm-installed hooks but not a stale plugin.

### Early-access mods API: low

The question band depends on Claude Code's early-access mods API, draws only in interactive surfaces, and is off by default.

### Growing ledger reads: low

Hot paths still replay the durable ledger. This is appropriate at current volume; measure before adding an index.

## Security boundaries

- Learning Moments has no backend and emits no product telemetry.
- Diffs and answers used for selection or grading are sent to the developer's configured Claude Code provider.
- Model subprocesses run with built-in tools, MCP servers and tools, hooks, slash commands, CLAUDE.md files, auto memory, and session persistence disabled.
- Project data is stored under `.learning-moments/`, ignored through the repository's own `info/exclude`, and created only by `init`.
- The npm package has no runtime dependencies and no install-time lifecycle scripts; the plugin is the same package, fetched without install scripts.
- npm provenance connects published packages to GitHub Actions; `learning-moments audit` verifies installed files against the shipped manifest.

## Verification gate

Before release:

```bash
npm ci --ignore-scripts
npm audit
npm run release
claude plugin validate .
```

`npm run release` regenerates the plugin files and `MANIFEST.json`, type-checks, runs the tests, audits the installed files, and installs and audits the packed tarball.
