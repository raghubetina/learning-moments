import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { candidateFiles } from "./filter.js";

// Read budgets for hot-path file operations. fileHash and contextForFiles
// previously trusted whatever was on disk; both could be tricked into
// reading 100+ MB build artifacts or untracked binaries. The size cap
// keeps single-file work cheap; the NUL-byte probe is the same trick
// lefthook uses to short-circuit binary content before decoding as UTF-8.
const MAX_HASH_BYTES = 1024 * 1024;
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

export function fileHash(root, relativePath) {
  const fullPath = path.join(root, relativePath);
  let stat;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_HASH_BYTES) return null;
  const buf = fs.readFileSync(fullPath);
  if (looksBinary(buf)) return null;
  return createHash("sha256").update(buf).digest("hex");
}

export function snapshot(cwd = process.cwd(), config = null) {
  const root = findGitRoot(cwd);
  // Filter dirty files through the candidate gate before we open any of them
  // for hashing. Without this we hash node_modules/foo.bin and every other
  // ignored or generated file in the working tree, which is the cost path
  // feedback_3 #1 identified. With a null config (e.g. tests calling
  // snapshot() directly), keep the old behavior: hash everything.
  const allDirty = dirtyFiles(root);
  const files = config ? candidateFiles(allDirty, config) : allDirty;
  const hashes = Object.fromEntries(files.map((file) => [file, fileHash(root, file)]));
  return {
    root,
    head: runGitOrNull(["rev-parse", "HEAD"], root),
    branch: runGitOrNull(["branch", "--show-current"], root),
    dirtyFiles: files,
    hashes
  };
}

export function changedSinceBaseline(baseline, current) {
  const files = new Set([...baseline.dirtyFiles, ...current.dirtyFiles]);
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
