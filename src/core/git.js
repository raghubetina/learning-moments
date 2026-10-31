import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { candidateFiles } from "./filter.js";
import { redactSecrets } from "./redaction.js";

// The NUL-byte probe is the same trick lefthook uses to short-circuit
// binary content before decoding as UTF-8.
const BINARY_PROBE_BYTES = 8192;
// Files larger than this skip `git hash-object` entirely and use a
// (size, mtime) metadata fingerprint instead. `git hash-object` still has
// to read the whole file even though we never look at its contents — a
// 100 MB untracked file that escapes config.ignore would otherwise pay
// the full read cost on every hook fire. The fingerprint is stable
// enough that `changedSinceBaseline` still detects edits via stat alone,
// and such files are never stored or sent as model context.
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
 * Hash a batch of working-tree paths with `git hash-object`.
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
export function gitHashObjects(root, files, { write = false } = {}) {
  /** @type {Record<string, string | null>} */
  const out = {};
  if (files.length === 0) return out;

  /** @type {string[]} */
  const present = [];
  const realRoot = fs.realpathSync(root);
  for (const file of files) {
    try {
      // Never follow symlinks while building model context. An untracked
      // symlink can point outside the repository; statSync/readFileSync would
      // otherwise follow it and could send unrelated local data to Claude.
      const stat = fs.lstatSync(path.join(root, file));
      // lstat checks only the last component. A directory on the path that
      // is a symlink could lead outside the repository, or to an excluded
      // directory inside it under a name the filter allows, so the parent
      // must resolve to exactly the path it is named by.
      const parent = fs.realpathSync(path.dirname(path.join(root, file)));
      if (parent !== path.join(realRoot, path.dirname(file))) {
        out[file] = "nonfile:symlinked-parent";
        continue;
      }
      if (!stat.isFile()) {
        // Distinct from null (deleted): a file replaced by a symlink must
        // not read as a deletion whose old content becomes context.
        out[file] = `nonfile:${stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "other"}`;
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

  // Filenames go as arguments after `--`, never on stdin: --stdin-paths
  // decodes C-style quoting, so a file named "..\057x" would be read as ../x.
  for (let start = 0; start < present.length; start += 200) {
    const batch = present.slice(start, start + 200);
    const raw = execFileSync("git", ["hash-object", ...(write ? ["-w"] : []), "--", ...batch], {
      cwd: root,
      encoding: "utf8",
      env: gitEnv(),
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const hashes = raw.split("\n").filter(Boolean);
    for (let i = 0; i < batch.length; i += 1) {
      out[batch[i]] = hashes[i] ?? null;
    }
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
    toBaseline({ write = false } = {}) {
      return {
        root,
        head,
        branch,
        candidates,
        hashes: write ? gitHashObjects(root, candidates, { write: true }) : hashes()
      };
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

const BLOB_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** @param {string} root */
function emptyBlob(root) {
  return execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: root,
    input: "",
    encoding: "utf8",
    env: gitEnv(),
    stdio: ["pipe", "pipe", "pipe"]
  }).trim();
}

/**
 * The blob and file mode a path has in `base`, or null when the path is
 * not a file there.
 *
 * @param {string} root
 * @param {string} base
 * @param {string} file
 * @returns {{ id: string, mode: string } | null}
 */
function entryInTree(root, base, file) {
  const line = runGitOrNull(["ls-tree", "-z", base, "--", file], root);
  if (!line) return null;
  const match = /^(\d{6}) blob ([0-9a-f]+)\t/.exec(line);
  return match && BLOB_ID.test(match[2]) ? { mode: match[1], id: match[2] } : null;
}

/**
 * The size of a stored blob, or null when it is no longer in the object
 * store (unreferenced blobs written for snapshots can be pruned).
 *
 * @param {string} root
 * @param {string} id
 */
function blobSize(root, id) {
  const size = runGitOrNull(["cat-file", "-s", id], root);
  return size === null ? null : Number(size);
}

/** The mode Git would record for the working-tree file, or null. */
function workingMode(root, file) {
  try {
    const stat = fs.lstatSync(path.join(root, file));
    return stat.isFile() ? (stat.mode & 0o111 ? "100755" : "100644") : null;
  } catch {
    return null;
  }
}

/**
 * Unified diff between two stored blobs, labeled with the file's path.
 * Null when either is no longer in the object store.
 *
 * @param {string} root
 * @param {string} file
 * @param {string} from
 * @param {string} to
 */
function diffBlobs(root, file, from, to) {
  let diff;
  try {
    diff = runGit(["diff", "--no-color", "--no-ext-diff", "--no-textconv", from, to], root);
  } catch {
    return null;
  }
  return diff.replaceAll(`a/${from}`, `a/${file}`).replaceAll(`b/${to}`, `b/${file}`);
}

/**
 * Raw (unredacted) context for one file version: a diff from `since` (a
 * version already seen) or from the file in `base`, or the whole content
 * when the file is new. Everything is read from stored blobs, never from
 * the working tree, so the context matches `version` exactly even if the
 * file changes while a hook waits.
 *
 * @param {string} root
 * @param {string} file
 * @param {string} base commit or tree to diff a first look against
 * @param {string | null | undefined} version blob id; null when deleted
 * @param {string | null | undefined} since blob id of the version already seen
 * @returns {string | null}
 */
function fileContext(root, file, base, version, since) {
  if (typeof version === "string" && version.startsWith("meta:")) {
    return `--- ${file}: changed, too large to include (${version.split(":")[1]} bytes) ---\n`;
  }
  // Non-files (a symlink, a directory) are never read, and neither is
  // what they replaced.
  if (version !== null && (typeof version !== "string" || !BLOB_ID.test(version))) return null;
  const to = version ?? emptyBlob(root);
  // The version already seen, or else the file in the base tree. A seen
  // version that has since been pruned falls back to the base tree.
  const seen = since && BLOB_ID.test(since) && blobSize(root, since) !== null ? since : null;
  const entry = seen ? null : entryInTree(root, base, file);
  const from = seen ?? entry?.id;
  if (from) {
    if (Number(blobSize(root, from)) > MAX_HASH_BYTES) {
      return `--- ${file}: changed, previous version too large to include ---\n`;
    }
    const diff = diffBlobs(root, file, from, to);
    if (diff !== null) {
      // Blobs carry no file mode, so a chmod +x shows up only here.
      const mode = workingMode(root, file);
      if (entry && version !== null && mode && mode !== entry.mode) {
        const header = `diff --git a/${file} b/${file}\nold mode ${entry.mode}\nnew mode ${mode}\n`;
        return diff.trim().length > 0 ? diff.replace(/^diff --git [^\n]*\n/, header) : header;
      }
      return diff.trim().length > 0 ? diff : null;
    }
  }
  if (version === null) return null;
  const buf = execFileSync("git", ["cat-file", "blob", to], {
    cwd: root,
    env: gitEnv(),
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (looksBinary(buf)) return null;
  return `--- new file: ${file} ---\n${buf.toString("utf8")}\n`;
}

/**
 * @typedef {import("./redaction.js").RedactionResult & { complete: string[] }} FileContext
 *   `complete` lists the files whose context fit whole within the budget
 */

/**
 * Bounded, redacted model context for candidate files, in the order given.
 * Each file's context is redacted whole before the character budget cuts
 * it, so truncation can never separate a secret from the markers that let
 * the redactor recognize it.
 *
 * @param {string} root
 * @param {string[]} files
 * @param {number} maxChars
 * @param {{ versions?: Record<string, string | null>, since?: Record<string, string | null> }} [options]
 *   `versions`: per file, the blob to describe (from gitHashObjects with
 *   `write`); captured now when omitted. `since`: per file, a version
 *   already seen, so the diff shows only what changed after it.
 * @returns {FileContext}
 */
export function contextForFiles(root, files, maxChars, options = {}) {
  /** @type {import("./redaction.js").RedactionFinding[]} */
  const findings = [];
  /** @type {string[]} */
  const complete = [];
  if (files.length === 0 || maxChars === 0) {
    return { text: "", findings, complete };
  }

  const versions = options.versions ?? gitHashObjects(root, files, { write: true });
  const since = options.since ?? {};
  const base = diffBase(root);
  const chunks = [];
  let remaining = maxChars;
  for (const file of files) {
    if (remaining <= 0) break;
    const raw = fileContext(root, file, base, versions[file], since[file]);
    if (raw === null) {
      complete.push(file);
      continue;
    }
    const redacted = redactSecrets(raw);
    findings.push(...redacted.findings);
    if (redacted.text.length > remaining) {
      chunks.push(`${redacted.text.slice(0, remaining)}\n[context truncated]\n`);
      remaining = 0;
    } else {
      chunks.push(redacted.text);
      remaining -= redacted.text.length;
      complete.push(file);
    }
  }
  return { text: chunks.join(""), findings, complete };
}
