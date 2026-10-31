import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { candidateFiles } from "./filter.js";
import { redactSecrets } from "./redaction.js";

// Read budget for context excerpts. contextForFiles reads file content
// directly to embed in classifier prompts; we cap that work so a stray
// 100MB log doesn't blow up a single hook. The NUL-byte probe is the
// same trick lefthook uses to short-circuit binary content before
// decoding as UTF-8.
const MAX_CONTEXT_FILE_BYTES = 1024 * 1024;
const BINARY_PROBE_BYTES = 8192;
// Files larger than this skip `git hash-object` entirely and use a
// (size, mtime) metadata fingerprint instead. `git hash-object` still has
// to read the whole file even though we never look at its contents — a
// 100 MB untracked file that escapes config.ignore would otherwise pay
// the full read cost on every hook fire. The fingerprint is stable
// enough that `changedSinceBaseline` still detects edits via stat alone.
const MAX_HASH_BYTES = 1024 * 1024;

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

// Filenames come from the working tree, so Git must never read them as
// pathspec patterns: a file literally named `*` would otherwise widen a
// diff to files the candidate filter excluded. Git refuses literal mode
// alongside the glob or icase modes, so inherited settings are cleared.
function gitEnv() {
  return {
    ...process.env,
    GIT_LITERAL_PATHSPECS: "1",
    GIT_GLOB_PATHSPECS: "0",
    GIT_NOGLOB_PATHSPECS: "0",
    GIT_ICASE_PATHSPECS: "0"
  };
}

export function runGit(args, cwd = process.cwd()) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnv(),
    maxBuffer: 32 * 1024 * 1024,
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

/**
 * Working-tree paths with any pending change (index or worktree, tracked
 * or untracked).
 *
 * Uses `--untracked-files=all` so that a brand-new directory expands into
 * its individual files rather than collapsing to the directory entry —
 * otherwise candidates inside a newly-created folder never reach the
 * classifier. For rename/copy entries (X = R or C), git's `-z` format is
 * `<XY> <new>\0<old>\0`; we record the NEW path because that's where the
 * current content lives. The OLD path is implicitly tracked via its
 * deletion-side status when present.
 *
 * @param {string} [cwd]
 * @returns {string[]}
 */
export function dirtyFiles(cwd = process.cwd()) {
  const root = findGitRoot(cwd);
  const status = splitNul(
    runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root)
  );
  const files = new Set();

  for (let index = 0; index < status.length; index += 1) {
    const entry = status[index];
    if (!entry) {
      continue;
    }
    const pathPart = entry.slice(3);
    const x = entry[0];
    if (x === "R" || x === "C") {
      // `entry.slice(3)` is the new path; the next NUL-separated chunk is
      // the old path — skip it.
      files.add(pathPart);
      index += 1;
    } else {
      files.add(pathPart);
    }
  }

  return [...files].sort();
}

/**
 * Hash a batch of working-tree paths via `git hash-object --stdin-paths`.
 * Returns a path → fingerprint map. Three fingerprint shapes:
 *   - a 40-char git blob SHA-1 for files <= MAX_HASH_BYTES,
 *   - a `meta:<size>:<mtimeMs>` string for files over the size cap (skips
 *     the read, which `git hash-object` would otherwise perform in full),
 *   - `null` for paths that don't exist on disk (e.g. a deletion still
 *     appearing in `git status`) — `changedSinceBaseline` reads the null
 *     as "absent" and detects the change.
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
      // Never follow symlinks while building model context. An untracked
      // symlink can point outside the repository; statSync/readFileSync would
      // otherwise follow it and could send unrelated local data to Claude.
      const stat = fs.lstatSync(path.join(root, file));
      if (!stat.isFile()) {
        out[file] = null;
        continue;
      }
      if (stat.size > MAX_HASH_BYTES) {
        out[file] = `meta:${stat.size}:${Math.floor(stat.mtimeMs)}`;
        continue;
      }
      present.push(file);
    } catch {
      out[file] = null;
    }
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

/**
 * The commit to diff against: HEAD, or Git's empty tree in a repository
 * with no commits yet, where `git diff HEAD` fails.
 *
 * @param {string} root
 */
function diffBase(root) {
  const head = runGitOrNull(["rev-parse", "--verify", "--quiet", "HEAD"], root);
  if (head) return head;
  return execFileSync("git", ["hash-object", "-t", "tree", "--stdin"], {
    cwd: root,
    input: "",
    encoding: "utf8",
    env: gitEnv(),
    stdio: ["pipe", "pipe", "pipe"]
  }).trim();
}

function isTracked(root, file) {
  try {
    runGit(["ls-files", "--error-unmatch", "--", file], root);
    return true;
  } catch {
    return false;
  }
}

/**
 * Raw (unredacted) context for one candidate file: its diff against
 * `base`, or the content of an untracked text file.
 *
 * @param {string} root
 * @param {string} file
 * @param {string} base
 * @returns {string | null}
 */
function fileContext(root, file, base) {
  /** @type {fs.Stats | null} */
  let stat = null;
  try {
    // lstat so an untracked symlink is treated as a non-file. Following
    // it here could read arbitrary content outside the project root.
    stat = fs.lstatSync(path.join(root, file));
  } catch {
    // Deleted in the working tree; the diff below shows the removal.
  }
  if (stat && !stat.isFile()) return null;
  if (stat && stat.size > MAX_CONTEXT_FILE_BYTES) {
    return `--- ${file}: changed, too large to include (${stat.size} bytes) ---\n`;
  }

  // --no-ext-diff and --no-textconv keep Git from running external
  // programs configured for diffs while hooks build model context.
  const diff = runGit(["diff", "--no-color", "--no-ext-diff", "--no-textconv", base, "--", file], root);
  if (diff.trim().length > 0) return diff;
  if (!stat || isTracked(root, file)) return null;

  const buf = fs.readFileSync(path.join(root, file));
  if (looksBinary(buf)) return null;
  return `--- untracked file: ${file} ---\n${buf.toString("utf8")}\n`;
}

/**
 * Bounded, redacted model context for candidate files, in the order given.
 * Each file's context is redacted whole before the character budget cuts
 * it, so truncation can never separate a secret from the markers that let
 * the redactor recognize it.
 *
 * @param {string} root
 * @param {string[]} files
 * @param {number} maxChars
 * @returns {import("./redaction.js").RedactionResult}
 */
export function contextForFiles(root, files, maxChars) {
  /** @type {import("./redaction.js").RedactionFinding[]} */
  const findings = [];
  if (files.length === 0 || maxChars === 0) {
    return { text: "", findings };
  }

  const base = diffBase(root);
  const chunks = [];
  let remaining = maxChars;
  for (const file of files) {
    if (remaining <= 0) break;
    const raw = fileContext(root, file, base);
    if (raw === null) continue;
    const redacted = redactSecrets(raw);
    findings.push(...redacted.findings);
    const chunk =
      redacted.text.length > remaining
        ? `${redacted.text.slice(0, remaining)}\n[context truncated]\n`
        : redacted.text;
    chunks.push(chunk);
    remaining -= chunk.length;
  }
  return { text: chunks.join(""), findings };
}
