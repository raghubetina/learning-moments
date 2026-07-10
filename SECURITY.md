# Security policy

## Supported versions

Learning Moments is an early alpha. Security fixes are made on the latest published version; older releases are not maintained separately.

## Reporting a vulnerability

Please do not open a public issue containing exploit details, credentials, private code, or other sensitive information.

Use GitHub's private vulnerability-reporting flow at:

<https://github.com/raghubetina/learning-moments/security/advisories/new>

If that flow is unavailable, open a minimal public issue asking the maintainer for a private contact channel, without including sensitive details.

Include, when possible:

- the affected Learning Moments and Claude Code versions;
- the operating system and Node version;
- a minimal reproduction using non-sensitive sample data;
- the likely impact and whether the issue has been exploited; and
- any suggested mitigation.

## Privacy boundary

Learning Moments stores its own data locally, but its classifier and grader are not local inference. Redacted code context and redacted answers are sent through the Claude Code provider configured on the user's machine. Secret detection is best effort, not a guarantee. Review the [privacy and trust section of the README](README.md#privacy-and-trust) before using the tool with sensitive repositories.

The current review record and known residual risks are documented in [AUDIT.md](AUDIT.md).
