#!/usr/bin/env node
// Verifies that the packed tarball installs and audits cleanly from a fresh
// project. This is the test the existing `learning-moments audit` cannot
// run against itself: audit on a git checkout proves the working tree is
// internally consistent, but says nothing about whether the tarball that
// would be published actually contains what the manifest claims. This
// script packs, installs into a throwaway project under /tmp, runs the
// CLI's own audit, and exits non-zero if any step fails.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

function log(message) {
  process.stderr.write(`[release-verify] ${message}\n`);
}

async function run(cmd, args, cwd) {
  return execFileAsync(cmd, args, { cwd, encoding: "utf8" });
}

async function main() {
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "learning-moments-release-verify-"));
  const npmCache = path.join(stagingDir, "npm-cache");
  log(`staging dir: ${stagingDir}`);

  try {
    log("packing...");
    const pack = await run(
      "npm",
      ["pack", "--pack-destination", stagingDir, "--ignore-scripts", "--cache", npmCache],
      ROOT
    );
    // npm pack prints the tarball filename on its last non-empty line of stdout.
    const tarballName = pack.stdout.trim().split(/\r?\n/).pop();
    if (!tarballName) {
      throw new Error("npm pack did not report a tarball filename");
    }
    const tarballPath = path.join(stagingDir, tarballName);
    log(`packed: ${tarballName}`);

    const consumerDir = path.join(stagingDir, "consumer");
    await fs.mkdir(consumerDir);
    await run("npm", ["init", "-y", "--cache", npmCache], consumerDir);

    log("installing tarball into consumer project...");
    await run(
      "npm",
      ["install", "--ignore-scripts", tarballPath, "--cache", npmCache],
      consumerDir
    );

    // Exec the installed CLI directly. Going through `npx` is fragile because
    // npx parses flags like `--version` itself before passing them along; the
    // path-based invocation is what a real `bin`-installed CLI would do too.
    const installedCli = path.join(
      consumerDir,
      "node_modules",
      "learning-moments",
      "src",
      "cli.js"
    );
    await fs.access(installedCli);

    log("running --version against installed CLI...");
    const versionOut = await run("node", [installedCli, "--version"], consumerDir);
    const reportedVersion = versionOut.stdout.trim();
    log(`installed version reports: ${reportedVersion}`);
    const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
    if (reportedVersion !== pkg.version) {
      throw new Error(
        `installed CLI version ${reportedVersion} does not match package.json ${pkg.version}`
      );
    }

    log("running audit against installed CLI...");
    const auditOut = await run("node", [installedCli, "audit"], consumerDir);
    if (!/Shipped files \(SHA-256\)/.test(auditOut.stdout)) {
      throw new Error("audit output is missing the expected 'Shipped files (SHA-256)' section");
    }
    if (/MISSING|UNEXPECTED|MISMATCH/.test(auditOut.stdout)) {
      throw new Error(
        "audit reported a failure suffix (MISSING/UNEXPECTED/MISMATCH) on a freshly installed tarball"
      );
    }
    log("audit reports clean.");

    log("OK");
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`[release-verify] FAILED: ${error?.message ?? error}\n`);
  if (error?.stdout) process.stderr.write(`stdout:\n${error.stdout}\n`);
  if (error?.stderr) process.stderr.write(`stderr:\n${error.stderr}\n`);
  process.exitCode = 1;
});
