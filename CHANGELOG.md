# Changelog

All notable changes to Learning Moments are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `src/core/event-registry.js` enumerates every event type the tool writes and assigns each one a retention class (`ledger`, `control`, or `telemetry`). `appendEvent` now throws on an unknown type rather than silently writing it, so a new event introduced without a registry decision fails loudly at write time. A test scans `src/` for `type: "..."` literals and asserts every one appears in the registry, keeping the table from drifting out of sync. Foundation for the upcoming log split (#13); no on-disk format changes yet.
- Path helpers `ledgerPath`, `controlPath`, `telemetryPath`, and `migrationCompletePath` for the three-class split. `appendEvent` now routes by retention class — but only after the `.migration-complete` marker is written. Until then (every repo currently in the wild), writes continue to go to the unified `moments.jsonl`, so this commit is a no-op for existing users. The marker is written by the migration step (next phase). `readEvents` merges the three class files post-migration; pre-migration it still reads the unified file.
- One-time log migration triggered by `learning-moments init`. Reads the unified `moments.jsonl`, classifies each row via the event registry, and writes `ledger.jsonl` / `control.jsonl` plus a telemetry-only `moments.jsonl` via a staging-and-rename sequence so a crashed run leaves no partial split. Writes `.migration-complete` last, which is the boolean every reader and writer checks. Idempotent — running `init` again after migration is a no-op. The migration also cleans up `.staging` debris from a prior aborted run.

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

[Unreleased]: https://github.com/raghubetina/learning-moments/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/raghubetina/learning-moments/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/raghubetina/learning-moments/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/raghubetina/learning-moments/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/raghubetina/learning-moments/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/raghubetina/learning-moments/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/raghubetina/learning-moments/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/raghubetina/learning-moments/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/raghubetina/learning-moments/releases/tag/v0.2.0
