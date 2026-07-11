# Code audit

This audit covers Learning Moments `0.5.5` as reviewed on 2026-07-10. It examined the shipped source, hook lifecycle, local storage, model-call isolation, privacy boundaries, release pipeline, dependency tree, and test suite. The `0.5.5` follow-up changes documentation only; its runtime is identical to `0.5.4`.

## Executive assessment

The core design is appropriately small and inspectable: source-executed JavaScript, no runtime dependencies, explicit Git-based change detection, structured model responses, append-only local records, and fail-open hooks. No critical code-execution or data-loss issue was found in the reviewed version.

Synchronous classifier latency is the largest remaining product risk. Full semantic classification still runs in `PostToolBatch`, so a candidate can pause the agentic loop while `claude -p` responds. That work is tracked in [issue #14](https://github.com/raghubetina/learning-moments/issues/14).

## Review methods

- Read every runtime module, command, hook, test, and release script.
- Compared hook inputs, outputs, timing, and timeout behavior with the current Claude Code hook reference.
- Ran the test suite and TypeScript's JavaScript checker against all production source and release scripts.
- Ran the packed-tarball installation and manifest verification path.
- Queried npm's advisory database and reviewed the dependency tree.
- Examined Git boundary handling: staged, unstaged, untracked, renamed, deleted, large, binary, ignored, and symbolic-link paths.
- Reviewed concurrency around fingerprint claims, JSONL writes, migration, pruning, and stale-lock recovery.

## Findings addressed in this review

### Untracked symlinks could escape the project boundary

`contextForFiles` used `stat` followed by `readFile` for untracked files. A symlink inside the repository could therefore point to a readable file outside the repository and have its target included in classifier context. Context collection now uses `lstat` and skips symbolic links. A regression test covers both hashing and context construction.

### The grader timeout exceeded Claude Code's hook timeout

Claude Code gives `UserPromptSubmit` command hooks a shorter default timeout than other command hooks. Learning Moments allowed its grader 45 seconds, but the containing hook could be terminated after 30 seconds. The installed hook now declares a 60-second timeout so the grader can reach its own deadline and record a clean fail-open outcome.

### The advertised type check covered only part of the program

The previous `tsconfig.json` had `checkJs` disabled, so only the nine files carrying an explicit `// @ts-check` directive were checked. The check now covers all production source and release scripts. Existing strongly annotated modules remain strict; currently unannotated modules are checked structurally while their JSDoc coverage is improved incrementally.

### `doctor` recreated a retired log file

The diagnostic command tested writability by appending an empty legacy `moments.jsonl`. After the log migration, that file is intentionally absent. The check now tests the data directory's write permission without creating or modifying files.

### Development dependencies contained known advisories

The prior Vitest dependency resolved to vulnerable Vite and esbuild versions. The patch upgrade removes the advisories. Node type definitions are also pinned to the Node 20 line so static checking cannot silently bless APIs newer than the declared runtime floor.

### The publish job had gaps independent of CI

The npm publish job now runs the type check itself, verifies that the Git tag matches `package.json`, disables package-manager caching, checks the exact installed CLI version, and creates a GitHub Release only after npm publication succeeds. Dependabot now watches both npm and GitHub Actions dependencies.

## Residual risks and roadmap

### Synchronous classification latency: high product risk

`PostToolBatch` still awaits the classifier. The existing prompt and classifier budgets reduce how often that happens, but calls that pass the gates still add latency. [Issue #14](https://github.com/raghubetina/learning-moments/issues/14) tracks a background candidate pipeline with freshness, claim, retry, and later-injection semantics.

### Session-relative attribution: medium

Learning Moments identifies files that changed after the Claude Code session baseline. It cannot prove every byte was authored by Claude: edits from another editor during the same session are included. Product language should say "changes made during the session" unless stronger provenance is available.

### Redaction is best effort: medium

Likely secret-bearing paths are excluded before reading, common credential patterns are redacted, symlinks are skipped, context is bounded, and nested Claude calls have tools and hooks disabled. Pattern matching cannot guarantee removal of every sensitive value. Use the tool only in repositories you trust, and review ignore rules before using it with sensitive code.

### Model-selected and model-graded moments: medium

The same model family selects questions and evaluates answers. JSON schemas and hidden expected-answer outlines make the workflow predictable, but grades are not ground truth. The `override` command exists for manual correction; research use should sample and independently review grades.

### Delayed recall is not implemented: product gap

The current product exercises immediate comprehension. It does not yet test retention after time has passed, which is closer to the project's anti-deskilling hypothesis. See [issue #15](https://github.com/raghubetina/learning-moments/issues/15).

### Growing ledger reads: low at current scale

Several hot-path queries replay the durable ledger. This is simple and appropriate for the current event volume, but eventually becomes linear in long-term usage. Measure real ledger sizes before adding an index or database.

### Failure telemetry could be more diagnostic: low

Classifier and grader failures intentionally stay quiet, but they currently collapse timeouts, invalid structured output, unavailable models, and CLI errors into broad fail-open events. Sanitized reason categories would improve support without persisting raw provider errors.

### Unusual filenames: low

Git status parsing is NUL-safe, but batch hashing uses line-delimited `git hash-object --stdin-paths`. A filename containing a newline can be misinterpreted. Such paths should eventually be skipped explicitly or hashed through a NUL-safe strategy.

## Security boundaries

- Learning Moments has no backend and emits no product telemetry.
- Diffs and answers used for selection or grading are sent to the developer's configured Claude Code provider.
- Model subprocesses run with tools disabled, hooks disabled, slash commands disabled, and session persistence disabled.
- Project state is stored under the Git-ignored `.learning-moments/` directory.
- The npm package has no runtime dependencies and no install-time lifecycle scripts.
- npm provenance connects published packages to GitHub Actions; `learning-moments audit` verifies installed files against the shipped manifest.

## Verification gate

Before release, the expected gate is:

```bash
npm ci --ignore-scripts
npm run check
npm test
npm audit
npm run build-manifest
npm run audit
npm run release-verify
```

`build-manifest` intentionally changes `MANIFEST.json`; run it only after the release contents are final.
