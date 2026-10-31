// @ts-check
import path from "node:path";
import { pathExists } from "./file-utils.js";
import { runGit } from "./git.js";
import { configPath } from "./paths.js";

/**
 * Where a hook keeps its records and where it looks for changes.
 *
 * - `dataRoot`: the checkout where `learning-moments init` ran; config,
 *   prompts, and logs live in its `.learning-moments/`.
 * - `workRoot`: the working tree Claude is editing. It differs from
 *   `dataRoot` in a linked worktree of the same repository, such as a
 *   Claude Code worktree session.
 *
 * @typedef {{ dataRoot: string, workRoot: string }} ProjectRoots
 */

/** @param {string} dir */
function gitRootOrNull(dir) {
  try {
    return runGit(["rev-parse", "--show-toplevel"], dir).trim();
  } catch {
    return null;
  }
}

/** @param {string} root */
function commonDir(root) {
  return runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], root).trim();
}

/**
 * The main checkout of a linked worktree, or null when `root` is the main
 * checkout or the repository's `.git` is not a plain directory.
 *
 * @param {string} root
 */
function mainCheckout(root) {
  const common = commonDir(root);
  if (path.basename(common) !== ".git") return null;
  const main = path.dirname(common);
  return main === root ? null : main;
}

/**
 * Resolve the initialized project a hook or command should act on, or
 * null when there is none. A null result means "do nothing": hooks run in
 * every directory a session visits, including clones and repositories
 * where `init` never ran, and must not create `.learning-moments/` there.
 *
 * Candidates, in order: the session's project directory
 * (`CLAUDE_PROJECT_DIR`, which stays put when Claude runs `cd`), the
 * repository containing `cwd`, and that repository's main checkout. When
 * `cwd` is in a different repository from the initialized one, changes
 * are still read from the initialized checkout, so a clone Claude cd's
 * into never feeds this project's questions.
 *
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<ProjectRoots | null>}
 */
export async function resolveProject(cwd, env = process.env) {
  const cwdRoot = gitRootOrNull(cwd);
  const projectDirRoot = env.CLAUDE_PROJECT_DIR ? gitRootOrNull(env.CLAUDE_PROJECT_DIR) : null;

  /** @type {string[]} */
  const candidates = [];
  if (projectDirRoot) {
    candidates.push(projectDirRoot);
    const main = mainCheckout(projectDirRoot);
    if (main) candidates.push(main);
  }
  if (cwdRoot) {
    candidates.push(cwdRoot);
    const main = mainCheckout(cwdRoot);
    if (main) candidates.push(main);
  }

  for (const dataRoot of new Set(candidates)) {
    if (!(await pathExists(configPath(dataRoot)))) continue;
    const dataCommon = commonDir(dataRoot);
    /** @param {string | null} root */
    const inProject = (root) => root !== null && (root === dataRoot || commonDir(root) === dataCommon);
    // Prefer the checkout Claude is in, then the session's own checkout,
    // so a worktree session keeps reading its worktree after a cd.
    const workRoot = inProject(cwdRoot) ? cwdRoot : inProject(projectDirRoot) ? projectDirRoot : dataRoot;
    return { dataRoot, workRoot: /** @type {string} */ (workRoot) };
  }
  return null;
}

/**
 * The initialized project for a CLI command run from `cwd`.
 *
 * @param {string} [cwd]
 * @returns {Promise<ProjectRoots>}
 */
export async function requireProject(cwd = process.cwd()) {
  const roots = await resolveProject(cwd);
  if (!roots) {
    const root = gitRootOrNull(cwd);
    throw new Error(
      root
        ? `Learning Moments is not initialized in ${root}. Run \`learning-moments init\` there first.`
        : "Learning Moments needs a Git repository. Run this inside one."
    );
  }
  return roots;
}
