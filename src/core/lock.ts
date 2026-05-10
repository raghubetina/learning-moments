import fs from "node:fs/promises";
import path from "node:path";
import { locksDir } from "./paths.js";

export class LockTimeoutError extends Error {
  constructor(lockName: string) {
    super(`Timed out acquiring lock: ${lockName}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withProjectLock<T>(
  projectRoot: string,
  lockName: string,
  fn: () => Promise<T>,
  timeoutMs = 5000
): Promise<T> {
  const lockRoot = locksDir(projectRoot);
  const lockPath = path.join(lockRoot, `${lockName}.lock`);
  await fs.mkdir(lockRoot, { recursive: true });

  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new LockTimeoutError(lockName);
      }
      await sleep(25);
    }
  }

  try {
    return await fn();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}
