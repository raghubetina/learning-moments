import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return null;
  }
  return createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex");
}

export function snapshot(cwd = process.cwd()) {
  const root = findGitRoot(cwd);
  const files = dirtyFiles(root);
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
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      continue;
    }
    const content = fs.readFileSync(fullPath, "utf8");
    const header = `--- untracked file: ${file} ---\n`;
    const excerpt = `${header}${content.slice(0, Math.max(0, remaining - header.length))}`;
    chunks.push(excerpt);
    remaining -= excerpt.length;
  }

  const raw = chunks.join("\n");
  return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n[context truncated]\n` : raw;
}
