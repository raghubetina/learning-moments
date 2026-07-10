# Changelog

All notable changes to Learning Moments are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.4] - 2026-07-10

Patch release improving project transparency, privacy hardening, static coverage, and release safety.

### Added

- Added a public code-audit record, security policy, contribution guide, citation metadata, and Dependabot coverage for npm and GitHub Actions.
- Future tag releases now create a GitHub Release after npm publication succeeds.

### Changed

- Rewrote the README around the product's situated-learning rationale, with a shorter onboarding path, an honest alpha/latency statement, an architecture walkthrough, corrected storage documentation, and explicit privacy boundaries.
- Expanded `npm run check` from nine explicitly annotated modules to all production source and release scripts. Node type definitions now track the declared Node 20 runtime floor.
- Updated Vitest and its transitive Vite/esbuild dependencies to versions with no known npm audit findings.
- Hardened the default selector and grader instructions against following instructions embedded in diffs or answers.

### Fixed

- Context collection no longer follows untracked symbolic links, preventing a repository symlink from pulling an arbitrary outside file into classifier context.
- Installed `UserPromptSubmit` hooks now declare a 60-second timeout. Previously Claude Code could terminate the containing hook at its 30-second default before the 45-second grader reached its own clean fail-open timeout.
- `learning-moments doctor` now checks data-directory permissions without recreating the retired pre-migration `moments.jsonl` file.
- Packed-release verification now requires the installed CLI version to exactly match `package.json` rather than accepting any semver-shaped output.
- Packed-release verification now uses an isolated temporary npm cache instead of inheriting user-level cache permissions or state.
- The npm publish job now runs type checking and rejects a Git tag that does not match the package version.

## [0.5.3] - 2026-06-18

Patch release fixing two data-integrity bugs surfaced by a full-codebase review. No on-disk format change beyond telemetry moving to its own file.

### Fixed

- **Migration crash could permanently destroy the ledger.** `logPath()` (the pre-migration unified log) and `telemetryPath()` (post-migration Class C) both resolved to `moments.jsonl`, so the migration's final rename overwrote its own source with the telemetry-only subset. If the process was killed after that rename but before the `.migration-complete` marker was written, the next `init` re-read the now-telemetry-only file and overwrote the populated `ledger.jsonl`/`control.jsonl` with empty staging — silently erasing durable events (`moment_created`, `answer_received`, `grade_created`, …). Telemetry now lives in its own `telemetry.jsonl`, so migration never overwrites its source; the legacy log is unlinked only after the marker is durable, leaving any crash mid-migration in a clean, fully retryable state.
- **Missed-injection events flooded the ledger every Stop.** `pendingFeedbackMoment` only treated `feedback_observed` as closing a moment, and `pendingInjectedMoment` only `answer_received`/`skip_recorded`. The negative outcomes `feedback_injection_missed` and `moment_injection_missed` (both `ledger`-class, retained forever) never closed the moment, so once a Stop logged one, every subsequent Stop in the session re-evaluated the same pending moment and appended another row. Both negative outcomes now close the moment, capping each at one row.

## [0.5.2] - 2026-05-12

Patch release. Slash command descriptions are now user-facing instead of prompt-to-Claude text, and `init` clobbers slash command files on every run so changes to defaults land without manual cleanup.

### Changed

- Slash commands now ship with YAML frontmatter `description:` fields aimed at the user reading the slash-command picker, not at Claude. Previously the first line of the prompt body ("Run `learning-moments status` and summarize the result briefly.") was what showed up in the picker — confusing copy if you're not Claude. The bodies still contain instructions to Claude when the command runs.
- `init` now overwrites slash command files unconditionally instead of skipping any file that already exists. Since the tool has no users besides the author, customization-preservation ceremony isn't earning its keep yet; clobbering on every re-init means default changes land without each project needing a manual `rm .claude/commands/learning-moments/*.md` step first. If/when there are external users we'll revisit with a marker-based or content-hash-based check.

## [0.5.1] - 2026-05-12

Two follow-up commits on the feedback-4 and feedback-5 audit notes. Mostly internal improvements; no on-disk format changes. The default config gains some secret-path ignores, so users who re-run `learning-moments init` after upgrading get a stronger first-line privacy filter (the existing pattern-based redactor is still in place for content that does reach the diff pipeline).

### Changed

- `PostToolBatch` no longer holds the `moment-claim` lock across the classifier call. Phase 1 acquires the lock briefly to read control events, check dedupe by fingerprint, and write `classifier_called` (the claim row). The lock is released before `classifyCandidate` runs. Phase 2 reacquires the lock around `moment_created` + budget read + `moment_injected` / `moment_silenced` so the inject/silence decision is still atomic against other in-flight injections. The previous single-lock structure could make a concurrent hook fail-open just because one Claude model call was in flight (default 45s classifier timeout vs. 5s lock acquisition timeout); the slow path now serializes only on the fingerprint dedupe, not on the model call.
- `gitHashObjects` no longer sends files over 1 MB to `git hash-object`. Large files now use a `meta:<size>:<mtimeMs>` fingerprint instead of a git blob SHA-1, which `changedSinceBaseline` reads as a normal string comparison. `git hash-object` would otherwise read the whole file even though we never look at its contents — a stray large untracked file that escaped `config.ignore` would pay the full read cost on every hook fire.
- `PostToolBatch` gates the classifier call on the immediate-prompt budget in active mode. With the default 1-question-per-hour budget, the classifier was previously running on every change event and getting silenced shortly afterward; an exhausted prompt budget now short-circuits the hook with `immediate_prompt_budget_exhausted` before the ~20s model call. The phase-2 lock still does the authoritative budget check (state can drift between the upstream read and the lock); this is an advisory fast-path. Observe-only mode is deliberately excluded so the ledger keeps capturing `moment_created` records the user can review.
- `defaultConfig.ignore` now defaults-out secret-bearing paths and extensions before they can reach `contextForFiles` or the redactor: `.env`, `.env.*`, `.npmrc`, `.pypirc`, `.netrc`, `.aws/**`, `.ssh/**`, `.config/gcloud/**`, and extensions `.pem`, `.key`, `.p12`, `.pfx`. Pattern-based redaction is still in place for content that does reach the diff pipeline, but the ignore filter is a stronger first line — a file that's filtered out never gets read at all. `.env.example` is also caught by the `.env.*` glob; we accept that false positive on purpose since the safety win is worth more than classifying example env files.

## [0.5.0] - 2026-05-12

Substantial internal restructuring. Two themes:

1. **Log split** (#13): the single growing `moments.jsonl` is replaced by three retention classes — `ledger.jsonl` (durable learning history, kept forever), `control.jsonl` (hot-path state, retained 1h–24h), and `moments.jsonl` (telemetry, truncatable at any time). Every event the tool writes is classified at write time; unknown types now throw rather than silently routing. Hot hooks read only the file they need instead of merging everything. A one-time migration runs on first `init` after upgrading and is a no-op on subsequent runs.
2. **Git-native working-tree snapshots** (#8): the eager `snapshot()` that hashed every dirty and untracked file with SHA-256 in Node is gone. Path discovery still runs eagerly (one `git status`, one ignore filter), but hashing is deferred until a baseline is materialized and is delegated to a single batched `git hash-object --stdin-paths` call. Git's own blob cache handles clean tracked files; we never open them.

All log-file mutators now share one project-level write lock, so prune/truncate/migrate can't race with `appendEvent`. `dirtyFiles` was fixed to use the new path for renames (the previous code recorded the old path) and to pass `--untracked-files=all` (without it, a brand-new directory collapsed to a single `dir/` entry).

No user-visible breaking changes — the on-disk JSONL format is preserved, the marker-gated migration keeps existing repos working until `init` runs, and the slash commands are unchanged.

### Added

- `src/core/event-registry.js` enumerates every event type the tool writes and assigns each one a retention class (`ledger`, `control`, or `telemetry`). `appendEvent` now throws on an unknown type rather than silently writing it, so a new event introduced without a registry decision fails loudly at write time. A test scans `src/` for `type: "..."` literals and asserts every one appears in the registry, keeping the table from drifting out of sync. Foundation for the upcoming log split (#13); no on-disk format changes yet.
- Path helpers `ledgerPath`, `controlPath`, `telemetryPath`, and `migrationCompletePath` for the three-class split. `appendEvent` now routes by retention class — but only after the `.migration-complete` marker is written. Until then (every repo currently in the wild), writes continue to go to the unified `moments.jsonl`, so this commit is a no-op for existing users. The marker is written by the migration step (next phase). `readEvents` merges the three class files post-migration; pre-migration it still reads the unified file.
- One-time log migration triggered by `learning-moments init`. Reads the unified `moments.jsonl`, classifies each row via the event registry, and writes `ledger.jsonl` / `control.jsonl` plus a telemetry-only `moments.jsonl` via a staging-and-rename sequence so a crashed run leaves no partial split. Writes `.migration-complete` last, which is the boolean every reader and writer checks. Idempotent — running `init` again after migration is a no-op. The migration also cleans up `.staging` debris from a prior aborted run.

### Changed

- Hot-path readers switched from the merged `readEvents` to per-class helpers (`readLedger`, `readControl`, `readTelemetry`). `PostToolBatch` now reads only the control file for budget, dedupe, and session-baseline lookup, and only the ledger for the immediate-prompt budget check; `UserPromptSubmit` and `Stop` read only the ledger. Pre-migration the helpers fall back to filtering the unified log so behavior is unchanged; post-migration each hook touches one small file instead of the merged view. `readEvents` remains for `status` and `metrics`, which need the merged set.
- `learning-moments delete-data` accepts `--logs-only`, which truncates `moments.jsonl` (telemetry) while leaving `ledger.jsonl` and `control.jsonl` intact. Refuses to run before migration since pre-migration `moments.jsonl` is the unified log and would take ledger rows with it. Cost reporting in `metrics` is unaffected because `classifier_completed` / `grader_completed` carry the cost numbers and live in the ledger.
- `SessionStart` now compacts `control.jsonl` on every fire. Classifier-budget rows (`classifier_called`, `candidate_already_seen`) are dropped after the trailing 1h window the budget and dedupe checks use; `session_baseline_created` rows are kept for 24h so hot hooks can still find the latest baseline for a long-running session. Best-effort: any failure here is swallowed so it can't block a session from starting.
- Working-tree construction shifted from an eager `snapshot()` to a lazy `workspaceContext(cwd, config)`. Path discovery + filtering still run up front (one `git status` + ignore filter, both cheap), but file hashing is deferred until `toBaseline()` is called and is delegated to a single batched `git hash-object --stdin-paths` instead of N file reads + N SHA-256s in Node. Git's own blob cache handles clean tracked files; we never open them. The persisted session-baseline payload changes shape: `dirtyFiles` → `candidates`, and the hashes are git blob SHA-1s instead of in-process SHA-256s. Closes #8.
- All log-file mutations now share the `moments-jsonl` lock. Previously `appendEvent` was the only writer that took the lock; `pruneControlLog` (SessionStart) and `truncateTelemetry` (`delete-data --logs-only`) rewrote their files without locking, so a hook could append to `control.jsonl` mid-prune (or to `moments.jsonl` mid-truncate) and have the appended row silently dropped by the subsequent rewrite. Migration used to take a separate `log-migration` lock for the same reason — a hook could append to the unified file during the partition phase and lose the row at the final rename. The split-lock setup is now gone: `appendEvent`, control pruning, telemetry truncation, and migration all serialize against each other through one project-level write lock.
- `session_baseline_created` reclassified from `ledger` (retained forever) to `control` (retained 24h). The ledger is for durable learning history (created moments, answers, grades); baselines are operational session state and shouldn't accumulate forever in a file that hot hooks read on every PostToolBatch. `PostToolBatch` now finds the latest baseline by reading `control.jsonl` instead of the ledger.
- `dirtyFiles` now uses the new path for `git status` rename/copy entries instead of the old path. The previous logic added `status[index + 1]` (the old path) to the candidate set; for a rename `R  <new>\0<old>\0` in `-z` format we want the post-rename location, which is the path embedded in the original status entry. Renamed files were effectively being looked up at their pre-rename path, which no longer exists on disk.
- `dirtyFiles` passes `--untracked-files=all`. Without it, a brand-new directory collapses to a single `dir/` entry in `git status` output, so files created inside a newly-created folder never reached the classifier as candidates.

### Fixed

- `learning-moments status` no longer counts `recall_scheduled` events (a recall feature that was never built — the event type isn't even in the registry, so the count was always 0). The status output now reads `lastError.error_message` instead of the nonexistent `lastError.reason ?? lastError.message`; `hook_error` events have always written the message under `error_message`, so the prior code printed an empty string after the timestamp.

### Testing

- Bumped the vitest `testTimeout` from the 5s default to 15s. Hook-flow tests run real git operations against per-test temp directories and were occasionally tipping over the 5s timeout under heavy parallel I/O when all four test files ran at once. Single-worker and isolated runs were comfortably under a second per test; the timeout bump is purely for the parallel case.

## [0.4.0] - 2026-05-12

Breaking minor release. Tightens the config validation surface (a 0.3.0 changelog claim that wasn't backed by code is now true) and stops `snapshot()` from doing repository-wide file reads on hot hook paths. Pairs with the safety nets in 0.3.2: any hook failure produced by stricter validation will now fail-open with a logged `hook_error` event.

### Changed (breaking)

- `parseConfig` now rejects unknown top-level and nested keys. The 0.3.0 changelog claimed this behavior already existed — it didn't. The parser was permissive and silently dropped removed fields. It now throws `config.X: unknown key "..."` on the first offending key, naming every extra key in one pass.
- `learning-moments init` detects an existing `.learning-moments/config.json` that fails strict parse, moves it aside to `config.json.bak`, and writes the default. Customizations must be merged back by hand from the backup. This is deliberately not an auto-migrator: the visible audit trail of what changed fits the project's posture better than silently stripping fields. A re-run of `init` against a valid config is unchanged (no `.bak` is created).

Migration path for users upgrading from 0.3.x or earlier with a customized config:

```bash
npm install -g learning-moments@latest
cd /path/to/your/project
learning-moments init
# Init will report which fields failed validation and back up the old config.
# Merge any customizations from .learning-moments/config.json.bak by hand,
# omitting the fields it complained about (typically `confidence`,
# `generated_markers`, `max_file_excerpt_chars`, `max_transcript_excerpt_chars`,
# `no_hooks_settings_file` — all removed in 0.3.0).
```

### Changed

- `snapshot()` filters dirty files through `candidateFiles(...)` before opening any of them for hashing. Without this, `node_modules`, `dist/`, `coverage/`, lockfiles, and any other configured-ignored path was hashed on every working-tree snapshot before later being filtered out. The function now accepts an optional `config` parameter; both `PostToolBatch` and `SessionStart` pass it. Callers that omit `config` get the old behavior (used only in tests).
- `fileHash` skips files larger than 1 MB and files whose first 8 KB contains a NUL byte. The NUL-byte probe is the same heuristic lefthook uses to short-circuit binary content before decoding. Skipped files return `null`, which compares equal to the existing missing-file return — they simply don't contribute to `changedSinceBaseline`.
- `contextForFiles` applies the same size + binary guards to untracked files before reading them as UTF-8. This is a privacy improvement in addition to a perf one: a binary or oversize untracked file matching no ignore pattern would previously be opened and shipped to `claude -p` as text; it now isn't.

## [0.3.2] - 2026-05-12

Reliability and audit-story tightening across six small fixes. No breaking changes; safe drop-in upgrade from 0.3.1. Lands before the strict-parser change planned for 0.4.0 so users get the fail-open improvements in place first.

### Changed

- Hook event dispatch now runs inside the fail-open boundary. Previously the unknown-event check in `src/cli.js` threw before `runHook` was invoked, so a stale installed hook entry (event renamed in a later version) or a typo would exit non-zero and interrupt the user's Claude Code session. The lookup now happens inside the wrapped action; unknown events produce a logged `hook_error` and a clean exit 0.
- `SessionStart` defers its working-tree snapshot past the disabled/paused checks, mirroring the same reorder already in place for `PostToolBatch`. Paused or disabled projects no longer pay the cost of hashing every dirty and untracked file on every session start.
- The no-hooks settings file used to isolate nested `claude -p` calls is now validated by contents, not just existence. A corrupted or hand-edited file with `disableAllHooks: false` (or no field at all) silently re-enabled hooks in nested calls; the inline-fallback path now covers that case alongside missing-file.
- `hook_error` events no longer include stack traces by default. Setting `LEARNING_MOMENTS_DEBUG=1` re-enables stack capture in the log and surfaces a one-line failure message on stderr for immediate visibility. Default behavior keeps the persisted record narrower and less likely to embed local paths.

### Added

- `.github/workflows/ci.yml` runs type-check, tests, and audit on Node 20 (the declared `engines` floor) for every push and pull request to `main`. The publish workflow continues to use Node 24 (Trusted Publishing needs npm 11+), so this is the only surface that exercises the minimum supported runtime.

### Fixed

- `package-lock.json` version metadata refreshed to match the current `package.json` version. The lockfile still said `0.3.0` after the previous patch bump; no transitive dep changes, only the two `"version"` fields.

## [0.3.1] - 2026-05-12

### Added

- `scripts/release-verify.js`: packs the project, installs the tarball into a throwaway consumer project, and runs `learning-moments audit` against the installed copy. Catches packaging-shaped bugs that the in-repo audit cannot see — a file referenced by code but missing from `package.json` `files`, executable bits stripped during pack, manifest drift. Wired into the `release` npm script and into the publish workflow (after `npm pack --dry-run`, before `npm publish`), so a release tag that would produce a broken tarball now fails CI before the tarball reaches the registry.
- Type checking via JSDoc + `tsc --noEmit`. The CLI ships as plain JavaScript exactly as before — no compile step, no `dist/` — but the source files in `src/core/` now carry JSDoc annotations on exports and shared data shapes (`Config`, `EventRecord`, the hook input types). A new `npm run check` runs the TypeScript compiler in no-emit mode against the JS sources; `npm run release` runs it as part of the pre-publish gate. The config-validation regression fixed in 8a45560 is exactly the bug class this catches at edit time. Initial coverage: `validate.js`, `config.js`, `log.js`, `hook-input.js`, `redaction.js`, `paths.js`, `hook-runner.js`. Remaining modules can be annotated incrementally; files without `// @ts-check` are still skipped.

## [0.3.0] - 2026-05-12

This release tightens the trust story (package.json now integrity-checked, user answers now redacted before logging or grading), closes several reliability and privacy gaps surfaced by a deep audit (silent hook failures, stale locks, snapshot work on paused projects), and removes aspirational config that no runtime code read.

Breaking: `parseConfig` will reject configurations that still contain the removed fields. If you have a customized `.learning-moments/config.json`, re-run `learning-moments init` or delete the removed keys by hand. See the Removed section.

### Changed

- `MANIFEST.json` and `learning-moments audit` now hash `package.json` alongside the other shipped files. `package.json` ships with every npm tarball regardless of the `files` array and controls what gets shipped (`files`) and what gets installed (`bin`), so leaving it out of integrity verification meant the most tamper-sensitive metadata was the only thing not protected.
- Hook failures now leave a trail. The hook runner previously caught every error and exited 0 silently — correct fail-open behavior, but undebuggable. It now best-effort writes a `hook_error` event to the log before exiting 0, with the originating hook name, the error message, and the duration. Logging failures themselves are still swallowed so the fail-open contract holds.
- Project locks recover from stale holders. The lock implementation in `src/core/lock.js` now writes the holder's PID, acquisition timestamp, and lock name into a `holder.json` inside the lock directory. On contention, the contender checks the holder's liveness (`process.kill(pid, 0)`) and the age of the lock; if the PID is no longer running or the lock is older than five minutes, the contender reclaims the lock and retries. Previously a crashed hook left a permanent lock directory that wedged the project until manual cleanup.
- `PostToolBatch` now short-circuits on disabled or paused projects before taking a working-tree snapshot. The previous order — snapshot, then check config — meant paused projects still paid the cost of hashing every dirty and untracked file on every batch event. The classifier-budget check also runs before the snapshot now, so budget-exhausted invocations are cheap too.
- User-typed answers are now pattern-redacted before they are logged or sent to the grader. Previously redaction applied only to code diffs; raw answer text was written to `moments.jsonl` and shipped to `claude -p` as-is. A user who pasted a credential into an answer would surface it in both places. The same `redactSecrets` patterns already used for diffs now run once on the answer; the redacted text is what travels onward, and the `redaction_findings` array is logged for audit. Skip detection happens against the redacted text; the redaction patterns and the skip keywords don't overlap, so the leading keyword is preserved. README's Privacy section updated to describe the broader coverage.
- The classifier's `timing` field is now honored. Previously the injection gate ignored it: a model that returned `timing: "ask_later"` with `delivery: "active"` would still interrupt the user immediately, contradicting its own signal. Injection now requires `timing === "ask_now"`; otherwise the moment is silenced with `reason: "ask_later"` (distinct from `observe_only` and `budget_or_delivery`).

### Removed

- Unused configuration fields removed from `config.json`: `context_limits.max_file_excerpt_chars`, `context_limits.max_transcript_excerpt_chars`, `ignore.generated_markers`, and the `confidence` object. All four were validated by `parseConfig` and persisted to disk but never read by any runtime code — editing them in `config.json` had no effect. They are deleted from `defaultConfig` and `parseConfig`; existing user configs that still contain them will fail validation. If you have a customized `config.json`, re-run `learning-moments init` or remove these keys by hand. When the features behind these knobs land (excerpt limits, generated-file detection, confidence prompts), the knobs come back alongside their implementation.
- `config.claude.no_hooks_settings_file` removed. The path was technically configurable but the file is always written by `init` at `.learning-moments/claude-no-hooks-settings.json`; nothing else has a legitimate reason to change it. `src/core/claude.js` now resolves the path directly via `noHooksSettingsPath(projectRoot)`, the same helper `init` and `doctor` already used.

## [0.2.3] - 2026-05-12

0.2.2's publish workflow failed at the npm upgrade step: `npm install -g npm@latest` running under Node 22's bundled npm 10.9 corrupted itself mid-upgrade (`MODULE_NOT_FOUND: promise-retry` after the new files partially replaced the old ones — a known npm self-upgrade race).

### Changed

- Publish workflow bumped to Node 24, which ships with npm 11+ by default. This satisfies Trusted Publishing's npm-version requirement without an in-place npm self-upgrade. A diagnostic `npm --version` step prints the resolved version into the workflow log for future debugging.

## [0.2.2] - 2026-05-12

0.2.2 is the first version of the 0.2.x line actually present on npm. 0.2.1 was tagged but never published — the publish workflow ran successfully through tests and provenance signing, but `npm publish` returned 404 because npm 10 (bundled with Node 20) does not implement Trusted Publishing's OIDC-for-publish-auth path. It silently fell back to token-based publish, found only `setup-node`'s placeholder token, and the registry rejected it.

### Changed

- Publish workflow now uses Node 22 and explicitly upgrades npm to the latest version before publishing. This guarantees Trusted Publishing support regardless of which point release of Node ships which npm. Also removes the deprecation warning about Node 20 actions.

## [0.2.1] - 2026-05-12

0.2.1 is the first published version of the 0.2.x line. 0.2.0 was tagged but never reached npm — the publish workflow failed at the test step before `npm publish` ran. The fix below is the only behavioral difference from the intended 0.2.0; see the 0.2.0 entry for what changed versus 0.1.x.

### Fixed

- CI publish workflow now passes on a fresh runner. Test fixtures that initialize temporary git repositories previously relied on a global `~/.gitconfig` for `user.name`/`user.email`; they now configure identity locally on each temp repo so the suite runs cleanly in any environment.

## [0.2.0] - 2026-05-12

This release rebuilds Learning Moments around a source-executed, zero-dependency CLI so the shipped code can be read end-to-end. It also closes several integrity and privacy gaps found by an adversarial review of the rewrite.

### Added

- `learning-moments audit` command. Prints install mode, hook entry paths, runtime dependencies, npm lifecycle scripts, and SHA-256 hashes of every shipped file, verified bidirectionally against `MANIFEST.json` (missing, mismatched, or unexpected files all fail the audit). `--json` for machine-readable output.
- `MANIFEST.json` ships with every release as the integrity baseline. Regenerated via `npm run build-manifest`.
- npm Trusted Publishing with provenance attestations. Each published tarball is cryptographically linked to the GitHub Actions build of a specific commit in this repository; verify with `npm audit signatures`.
- `learning-moments init` and other commands run from a git checkout (`node src/cli.js init`) for users who prefer not to install from npm.

### Changed

- **Source-executed CLI.** No more `dist/`, no build step, no bundler. The `bin` field in `package.json` points directly at `src/cli.js`, and Claude Code hooks installed by `init` invoke that same file by absolute path.
- Plain ESM JavaScript runtime. TypeScript, `commander`, and `zod` removed; zero runtime dependencies, only `vitest` as devDep.
- Audit verification is bidirectional and fail-closed. Missing or unparseable `MANIFEST.json` exits non-zero rather than silently skipping the check.
- Config validation restores numeric bounds: frequency and context-limit fields must be non-negative; Claude call timeouts must be at least one second.
- Glob patterns in `ignore.paths` are validated at config load. Unsupported minimatch features (brace expansion, character classes, extglobs, `?` single-char wildcard) are rejected with a clear error rather than silently mismatching against paths the user expected excluded.

### Fixed

- `pause --session <id>` now actually pauses the session. Previously `config.paused.sessions[id]` was written but never read; classifier calls and prompt injection continued in paused sessions.
- `UserPromptSubmit` hook now honors both project-scope and session-scope pause. Previously it had no pause check at all, so a paused session would still consume a pending answer through the grader.

### Security

- End-to-end inspectability story: `npm audit signatures` verifies the tarball came from this repository's CI; `learning-moments audit` verifies the files on disk match the manifest that travelled with it. Together they cover public source → CI build → registry → installed files.
- No npm install-time scripts (`preinstall`, `postinstall`, `prepare`, etc.). `audit` actively reports any that appear.

[Unreleased]: https://github.com/raghubetina/learning-moments/compare/v0.5.4...HEAD
[0.5.4]: https://github.com/raghubetina/learning-moments/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/raghubetina/learning-moments/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/raghubetina/learning-moments/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/raghubetina/learning-moments/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/raghubetina/learning-moments/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/raghubetina/learning-moments/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/raghubetina/learning-moments/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/raghubetina/learning-moments/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/raghubetina/learning-moments/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/raghubetina/learning-moments/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/raghubetina/learning-moments/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/raghubetina/learning-moments/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/raghubetina/learning-moments/releases/tag/v0.2.0
