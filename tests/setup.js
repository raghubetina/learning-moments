// Hooks and commands prefer CLAUDE_PROJECT_DIR when resolving the project.
// A value inherited from a Claude Code session running the tests would
// point them at a real project, where a test could delete its data.
delete process.env.CLAUDE_PROJECT_DIR;

// No test may make a real model call. Tests that exercise the call path
// against a stand-in `claude` executable clear this themselves; spawned
// child processes inherit it.
process.env.LEARNING_MOMENTS_DISABLE_CLAUDE = "1";
