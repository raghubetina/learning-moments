// Hooks and commands prefer CLAUDE_PROJECT_DIR when resolving the project.
// A value inherited from a Claude Code session running the tests would
// point them at a real project, where a test could delete its data.
delete process.env.CLAUDE_PROJECT_DIR;
