---
description: Ask me a question about the current uncommitted changes
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/src/cli.js" verify *)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/src/cli.js" verify --session ${CLAUDE_SESSION_ID}` and show me its output exactly as printed. If it prints a question, stop there: do not answer it, hint at the answer, or explain the change. My next message is my answer.
