# Changelog

All notable changes to Learning Moments are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/raghubetina/learning-moments/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/raghubetina/learning-moments/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/raghubetina/learning-moments/releases/tag/v0.2.0
