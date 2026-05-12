# Changelog

All notable changes to Learning Moments are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `MANIFEST.json` and `learning-moments audit` now hash `package.json` alongside the other shipped files. `package.json` ships with every npm tarball regardless of the `files` array and controls what gets shipped (`files`) and what gets installed (`bin`), so leaving it out of integrity verification meant the most tamper-sensitive metadata was the only thing not protected.
- Hook failures now leave a trail. The hook runner previously caught every error and exited 0 silently — correct fail-open behavior, but undebuggable. It now best-effort writes a `hook_error` event to the log before exiting 0, with the originating hook name, the error message, and the duration. Logging failures themselves are still swallowed so the fail-open contract holds.
- Project locks recover from stale holders. The lock implementation in `src/core/lock.js` now writes the holder's PID, acquisition timestamp, and lock name into a `holder.json` inside the lock directory. On contention, the contender checks the holder's liveness (`process.kill(pid, 0)`) and the age of the lock; if the PID is no longer running or the lock is older than five minutes, the contender reclaims the lock and retries. Previously a crashed hook left a permanent lock directory that wedged the project until manual cleanup.
- `PostToolBatch` now short-circuits on disabled or paused projects before taking a working-tree snapshot. The previous order — snapshot, then check config — meant paused projects still paid the cost of hashing every dirty and untracked file on every batch event. The classifier-budget check also runs before the snapshot now, so budget-exhausted invocations are cheap too.

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

[Unreleased]: https://github.com/raghubetina/learning-moments/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/raghubetina/learning-moments/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/raghubetina/learning-moments/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/raghubetina/learning-moments/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/raghubetina/learning-moments/releases/tag/v0.2.0
