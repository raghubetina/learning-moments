import fs from "node:fs/promises";
import path from "node:path";
import { locksDir } from "./paths.js";

const STALE_LOCK_MS = 5 * 60 * 1000;
const HOLDER_FILE = "holder.json";

export class LockTimeoutError extends Error {
  constructor(lockName) {
    super(`Timed out acquiring lock: ${lockName}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readHolder(lockPath) {
  try {
    const raw = await fs.readFile(path.join(lockPath, HOLDER_FILE), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function holderIsAlive(pid) {
  if (typeof pid !== "number" || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? error.code : undefined;
    // EPERM means "process exists but you can't signal it" — still alive.
    return code === "EPERM";
  }
}

async function reclaimIfStale(lockPath, now = Date.now()) {
  const holder = await readHolder(lockPath);
  if (!holder) {
    // No metadata: either an older-version lock from before this change or a
    // partial write. Reclaim conservatively if the directory mtime is old.
    try {
      const stat = await fs.stat(lockPath);
      if (now - stat.mtimeMs >= STALE_LOCK_MS) {
        await fs.rm(lockPath, { recursive: true, force: true });
        return true;
      }
    } catch {
      // lock was removed between checks; treat as reclaimed
      return true;
    }
    return false;
  }
  const acquiredAt = typeof holder.acquiredAt === "number" ? holder.acquiredAt : 0;
  if (holderIsAlive(holder.pid) && now - acquiredAt < STALE_LOCK_MS) {
    return false;
  }
  await fs.rm(lockPath, { recursive: true, force: true });
  return true;
}

export async function withProjectLock(projectRoot, lockName, fn, timeoutMs = 5000) {
  const lockRoot = locksDir(projectRoot);
  const lockPath = path.join(lockRoot, `${lockName}.lock`);
  await fs.mkdir(lockRoot, { recursive: true });

  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (true) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") {
        throw error;
      }
      attempts += 1;
      // Probe for staleness occasionally rather than on every retry — avoids
      // hammering the filesystem during normal contention.
      if (attempts === 1 || attempts % 20 === 0) {
        if (await reclaimIfStale(lockPath)) {
          continue;
        }
      }
      if (Date.now() >= deadline) {
        throw new LockTimeoutError(lockName);
      }
      await sleep(25);
    }
  }

  try {
    await fs.writeFile(
      path.join(lockPath, HOLDER_FILE),
      `${JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), lockName })}\n`
    );
    return await fn();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}
