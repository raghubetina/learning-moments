# Contributing

Learning Moments is an early research prototype. Focused bug reports, reproducible hook failures, privacy improvements, and evidence about question quality or workflow cost are especially useful.

## Before opening a pull request

For substantial behavior changes, open an issue first. The two central architectural constraints are:

1. A learning aid must fail open; it must not break the developer's Claude Code workflow.
2. A question must be specific enough to justify its interruption cost; silence is better than a generic quiz.

Please keep the package inspectable: source-executed JavaScript, no generated runtime bundle, and a strong preference for zero runtime dependencies.

## Development setup

Requirements are Node 22+, Git, and an authenticated Claude Code installation for manual end-to-end testing.

```bash
git clone https://github.com/raghubetina/learning-moments.git
cd learning-moments
npm ci --ignore-scripts
npm run check
npm test
```

Tests mock model calls; they do not consume Claude usage.

## Pull-request checklist

- Add a regression test for changed behavior.
- Preserve fail-open behavior on every hook path.
- Consider whether new event types belong in the durable ledger, bounded control state, or disposable telemetry; update `src/core/event-registry.js` explicitly.
- Keep code and answer context bounded and redacted before persistence or model calls.
- Update the README and changelog when behavior or configuration changes.
- After changing hook specs in `src/core/claude-settings.js` or command prompts in `src/core/defaults.js`, run `npm run build-plugin`; a test fails when the plugin's `hooks/` and `skills/` drift from them.
- Run `npm run check` and `npm test`.
- Run `npm run build-manifest` as the last step of any change to a shipped file. CI runs `learning-moments audit`, which fails on a stale `MANIFEST.json`.

## Trying a change in Claude Code

- Load the checkout as a plugin for one session with `claude --plugin-dir .`, then run `/learning-moments:init` in a throwaway Git repository. `claude plugin validate .` checks the manifest, hooks, skills, and the question-band mod.
- Tests never make model calls: `tests/setup.js` sets `LEARNING_MOMENTS_DISABLE_CLAUDE=1`, and hook tests mock the background grader.
- The question-band mod (`hooks/question-band.tsx`) is TypeScript the engine compiles; type-check it against the declarations Claude Code writes beside a loaded mod (see the `plugin-authoring` skill), since `npm run check` covers only `src/` and `scripts/`.

## Release-only verification

Maintainers should run:

```bash
npm audit
npm run release
```

`npm run release` regenerates the plugin files and the manifest, then type-checks, tests, audits, and installs the packed tarball. Bump `version` in `package.json` first; the plugin manifest takes its version from there. Tag `v<version>` on `main` to publish: the workflow repeats the checks, refuses a tag that doesn't match `package.json`, fails on high-severity advisories, and publishes with npm provenance. The plugin marketplace's npm source picks up the release from there.

## Security reports

Follow [SECURITY.md](SECURITY.md) rather than opening a public issue with sensitive details.
