# Contributing

Learning Moments is an early research prototype. Focused bug reports, reproducible hook failures, privacy improvements, and evidence about question quality or workflow cost are especially useful.

## Before opening a pull request

For substantial behavior changes, open an issue first. The two central architectural constraints are:

1. A learning aid must fail open; it must not break the developer's Claude Code workflow.
2. A question must be specific enough to justify its interruption cost; silence is better than a generic quiz.

Please keep the package inspectable: source-executed JavaScript, no generated runtime bundle, and a strong preference for zero runtime dependencies.

## Development setup

Requirements are Node 20+, Git, and an authenticated Claude Code installation for manual end-to-end testing.

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
- Run `npm run check` and `npm test`.
- Do not regenerate `MANIFEST.json` until all shipped-file changes are final.

## Release-only verification

Maintainers should run:

```bash
npm audit
npm run build-manifest
npm run audit
npm run release-verify
```

The publish workflow repeats type checking, tests, manifest verification, packed-tarball installation, and npm provenance publication.

## Security reports

Follow [SECURITY.md](SECURITY.md) rather than opening a public issue with sensitive details.
