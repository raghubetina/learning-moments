import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,js}"],
    restoreMocks: true,
    // Hook tests run real git operations against tempdirs and can hit the
    // default 5s timeout under heavy file-system contention when vitest is
    // running every test file in parallel. The work itself is fast (any
    // single test passes well under a second in isolation) — the timeout
    // bump is purely for the parallel case.
    testTimeout: 15000
  }
});
