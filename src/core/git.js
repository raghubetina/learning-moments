import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { candidateFiles } from "./filter.js";

// Read budget for context excerpts. contextForFiles reads file content
// directly to embed in classifier prompts; we cap that work so a stray
// 100MB log doesn't blow up a single hook. Hashing no longer happens in
// our process (we delegate to `git hash-object`), so it doesn't need a
// matching guard. The NUL-byte probe is the same trick lefthook uses to
// short-circuit binary content before decoding as UTF-8.
const MAX_CONTEXT_FILE_BYTES = 1024 * 1024;
const BINARY_PROBE_BYTES = 8192;

/**
 * @param {Buffer} buf
 * @returns {boolean}
 */
function looksBinary(buf) {
  const sample = buf.subarray(0, Math.min(BINARY_PROBE_BYTES, buf.length));
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) return true;
  }
  return false;
}

export function runGit(args, cwd = process.cwd()) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

export function findGitRoot(cwd = process.cwd()) {
  return runGit(["rev-parse", "--show-toplevel"], cwd).trim();
}

function runGitOrNull(args, cwd = process.cwd()) {
  try {
    return runGit(args, cwd).trim();
  } catch {
    return null;
  }
}

export function splitNul(raw) {
  return raw.split("\0").filter(Boolean);
}

export function dirtyFiles(cwd = process.cwd()) {
  const root = findGitRoot(cwd);
  const status = splitNul(runGit(["status", "--porcelain=v1", "-z"], root));
  const files = new Set();

  for (let index = 0; index < status.length; index += 1) {
    const entry = status[index];
    if (!entry) {
      continue;
    }
    const pathPart = entry.slice(3);
    if (entry.startsWith("R ") || entry.startsWith("C ")) {
      files.add(status[index + 1] ?? pathPart);
      index += 1;
    } else {
      files.add(pathPart);
    }
  }

  return [...files].sort();
}

/**
 * Hash a batch of working-tree paths via `git hash-object --stdin-paths`.
 * Returns a path → blob hash map. Paths that don't exist on disk (e.g. a
 * deletion still appearing in `git status`) get a `null` entry so
 * baseline comparison can detect their absence as a change.
 *
 * Two reasons for delegating to git rather than reading + SHA-256-ing in
 * Node:
 *   1. Git keeps a blob cache; clean tracked files don't touch disk.
 *   2. A single spawn beats N file reads + N hashes for typical hook
 *      workloads (tens of dirty paths).
 *
 * @param {string} root
 * @param {string[]} files
 * @returns {Record<string, string | null>}
 */
export function gitHashObjects(root, files) {
  /** @type {Record<string, string | null>} */
  const out = {};
  if (files.length === 0) return out;

  /** @type {string[]} */
  const present = [];
  for (const file of files) {
    try {
      const stat = fs.statSync(path.join(root, file));
      if (stat.isFile()) {
        present.push(file);
        continue;
      }
    } catch {
      // not present — fall through to null entry below
    }
    out[file] = null;
  }
  if (present.length === 0) return out;

  const stdin = `${present.join("\n")}\n`;
  const raw = execFileSync("git", ["hash-object", "--stdin-paths"], {
    cwd: root,
    input: stdin,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });
  const hashes = raw.split("\n").filter(Boolean);
  for (let i = 0; i < present.length; i += 1) {
    out[present[i]] = hashes[i] ?? null;
  }
  return out;
}

/**
 * @typedef {Object} WorkspaceBaseline
 * @property {string} root
 * @property {string | null} head
 * @property {string | null} branch
 * @property {string[]} candidates
 * @property {Record<string, string | null>} hashes
 */

/**
 * Build a per-hook view of the working tree. Path discovery and filtering
 * run eagerly (one `git status`, one filter pass — both cheap). Hashing is
 * lazy: the `hashes` field is only populated when callers materialize the
 * baseline payload via `toBaseline()`. Pause/disabled/budget-exhausted
 * branches never pay for the hash step.
 *
 * @param {string} cwd
 * @param {import("./config.js").Config | null} [config]
 */
export function workspaceContext(cwd, config = null) {
  const root = findGitRoot(cwd);
  const head = runGitOrNull(["rev-parse", "HEAD"], root);
  const branch = runGitOrNull(["branch", "--show-current"], root);
  const allDirty = dirtyFiles(root);
  const candidates = config ? candidateFiles(allDirty, config) : allDirty;

  /** @type {Record<string, string | null> | null} */
  let memoHashes = null;
  const hashes = () => {
    if (memoHashes === null) memoHashes = gitHashObjects(root, candidates);
    return memoHashes;
  };

  return {
    root,
    head,
    branch,
    candidates,
    hashes,
    /**
     * Materialize a JSON-serializable baseline for the event log.
     * @returns {WorkspaceBaseline}
     */
    toBaseline() {
      return { root, head, branch, candidates, hashes: hashes() };
    }
  };
}

/**
 * @param {WorkspaceBaseline} baseline
 * @param {WorkspaceBaseline} current
 * @returns {string[]}
 */
export function changedSinceBaseline(baseline, current) {
  const files = new Set([...baseline.candidates, ...current.candidates]);
  /** @type {string[]} */
  const changed = [];
  for (const file of files) {
    if (baseline.hashes[file] !== current.hashes[file]) {
      changed.push(file);
    }
  }
  return changed.sort();
}

export function diffForFiles(root, files, maxChars) {
  if (files.length === 0 || maxChars === 0) {
    return "";
  }
  const raw = runGit(["diff", "HEAD", "--", ...files], root);
  return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n[diff truncated]\n` : raw;
}

function isTracked(root, file) {
  try {
    runGit(["ls-files", "--error-unmatch", "--", file], root);
    return true;
  } catch {
    return false;
  }
}

export function contextForFiles(root, files, maxChars) {
  if (files.length === 0 || maxChars === 0) {
    return "";
  }

  const diff = diffForFiles(root, files, maxChars);
  if (diff.length >= maxChars) {
    return diff;
  }

  const chunks = diff.trim().length > 0 ? [diff] : [];
  let remaining = maxChars - chunks.join("\n").length;
  for (const file of files) {
    if (remaining <= 0) {
      break;
    }
    if (isTracked(root, file)) {
      continue;
    }
    const fullPath = path.join(root, file);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_CONTEXT_FILE_BYTES) continue;
    const buf = fs.readFileSync(fullPath);
    if (looksBinary(buf)) continue;
    const content = buf.toString("utf8");
    const header = `--- untracked file: ${file} ---\n`;
    const excerpt = `${header}${content.slice(0, Math.max(0, remaining - header.length))}`;
    chunks.push(excerpt);
    remaining -= excerpt.length;
  }

  const raw = chunks.join("\n");
  return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n[context truncated]\n` : raw;
}
