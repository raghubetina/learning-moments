import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { settingsPath } from "../core/claude-settings.js";
import { pathExists, readJsonFile } from "../core/file-utils.js";
import { findGitRoot } from "../core/git.js";
import { dataDir, promptsDir } from "../core/paths.js";
import { cliPath, manifestPath, packageRoot, version } from "../core/path-self.js";

const LIFECYCLE_KEYS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
  "prepublish",
  "prepublishOnly",
  "prepack",
  "postpack",
  "publish",
  "postpublish"
]);

async function detectInstallMode(root) {
  if (await pathExists(path.join(root, ".git"))) {
    return "git-checkout";
  }
  if (root.includes(`${path.sep}node_modules${path.sep}`)) {
    if (/(?:^|\/)lib(?:\/node_modules)?\//.test(root.replace(/\\/g, "/"))) {
      return "npm-global";
    }
    return "npm-local";
  }
  return "unknown";
}

async function listFiles(root, entries) {
  const out = [];
  for (const entry of entries) {
    const trimmed = entry.replace(/\/$/, "");
    const abs = path.join(root, trimmed);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) {
      const walked = await walkDir(abs);
      for (const file of walked) {
        out.push(path.relative(root, file));
      }
    } else if (stat.isFile()) {
      out.push(trimmed);
    }
  }
  return out.sort();
}

async function walkDir(dir) {
  const result = [];
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of dirents) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await walkDir(full)));
    } else if (entry.isFile()) {
      result.push(full);
    }
  }
  return result;
}

async function hashFile(absPath) {
  const buf = await fs.readFile(absPath);
  return createHash("sha256").update(buf).digest("hex");
}

async function loadPackageJson(root) {
  return readJsonFile(path.join(root, "package.json"));
}

async function readManifest() {
  const target = manifestPath();
  if (!(await pathExists(target))) return null;
  try {
    return await readJsonFile(target);
  } catch {
    return null;
  }
}

function ourHookEntries(settings) {
  const out = [];
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== "object") return out;
  const cliSuffix = path.join("src", "cli.js");
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) continue;
      for (const entry of group.hooks) {
        if (!entry || entry.type !== "command") continue;
        if (entry.command === "node" && Array.isArray(entry.args)) {
          const [cli] = entry.args;
          if (typeof cli === "string" && cli.endsWith(cliSuffix)) {
            out.push({ event, matcher: group.matcher, command: entry.command, args: entry.args });
          }
        } else if (typeof entry.command === "string" && entry.command.startsWith("learning-moments hook")) {
          out.push({ event, matcher: group.matcher, command: entry.command, args: [] });
        }
      }
    }
  }
  return out;
}

async function projectInfo() {
  try {
    const root = findGitRoot(process.cwd());
    const localSettings = settingsPath(root, false);
    const sharedSettings = settingsPath(root, true);
    const localExists = await pathExists(localSettings);
    const sharedExists = await pathExists(sharedSettings);
    const local = localExists ? await readJsonFile(localSettings) : null;
    const shared = sharedExists ? await readJsonFile(sharedSettings) : null;
    const promptFiles = (await pathExists(promptsDir(root)))
      ? (await fs.readdir(promptsDir(root))).map((name) => path.join(promptsDir(root), name))
      : [];
    return {
      projectRoot: root,
      dataDir: dataDir(root),
      settings: [
        ...(localExists
          ? [{ path: localSettings, hookEntries: ourHookEntries(local) }]
          : []),
        ...(sharedExists
          ? [{ path: sharedSettings, hookEntries: ourHookEntries(shared) }]
          : [])
      ],
      promptFiles
    };
  } catch {
    return null;
  }
}

export async function auditCommand(options = {}) {
  const root = packageRoot();
  const installMode = await detectInstallMode(root);
  const pkg = await loadPackageJson(root);
  const dependencies = Object.keys(pkg.dependencies ?? {});
  const installScripts = Object.entries(pkg.scripts ?? {})
    .filter(([name]) => LIFECYCLE_KEYS.has(name))
    .map(([name, value]) => ({ name, value }));

  const shippedEntries = pkg.files ?? [];
  const files = await listFiles(root, shippedEntries);
  const hashes = {};
  for (const rel of files) {
    hashes[rel] = await hashFile(path.join(root, rel));
  }

  const manifest = await readManifest();
  const verification = manifest
    ? files.map((rel) => ({
        path: rel,
        match: manifest.files?.[rel] === hashes[rel],
        actual: hashes[rel],
        expected: manifest.files?.[rel] ?? null
      }))
    : null;

  const project = await projectInfo();

  const report = {
    name: pkg.name,
    version: version(),
    installMode,
    packageRoot: root,
    cliEntrypoint: cliPath(),
    runtimeDependencies: dependencies,
    installTimeScripts: installScripts,
    manifest: manifest
      ? { present: true, generatedAt: manifest.generatedAt ?? null, files: manifest.files }
      : { present: false },
    fileHashes: hashes,
    verification,
    project
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(`Learning Moments audit\n\n`);
  process.stdout.write(`Name:          ${report.name}\n`);
  process.stdout.write(`Version:       ${report.version}\n`);
  process.stdout.write(`Install mode:  ${report.installMode}\n`);
  process.stdout.write(`Package root:  ${report.packageRoot}\n`);
  process.stdout.write(`CLI entry:     ${report.cliEntrypoint}\n\n`);

  process.stdout.write(`Runtime dependencies: ${dependencies.length === 0 ? "none" : dependencies.join(", ")}\n`);
  process.stdout.write(
    `Install-time scripts: ${installScripts.length === 0 ? "none" : installScripts.map((s) => s.name).join(", ")}\n\n`
  );

  if (project) {
    process.stdout.write(`Project: ${project.projectRoot}\n`);
    for (const { path: settingsFile, hookEntries } of project.settings) {
      process.stdout.write(`  Settings file: ${settingsFile}\n`);
      if (hookEntries.length === 0) {
        process.stdout.write(`    (no Learning Moments hook entries)\n`);
      }
      for (const entry of hookEntries) {
        const argsRepr = entry.args.length > 0 ? entry.args.join(" ") : "";
        const matcher = entry.matcher ? ` matcher=${entry.matcher}` : "";
        process.stdout.write(`    ${entry.event}${matcher}\n`);
        process.stdout.write(`      command: ${entry.command}${argsRepr ? ` ${argsRepr}` : ""}\n`);
      }
    }
    if (project.promptFiles.length > 0) {
      process.stdout.write(`  Prompt files:\n`);
      for (const file of project.promptFiles) {
        process.stdout.write(`    ${file}\n`);
      }
    }
    process.stdout.write(`\n`);
  } else {
    process.stdout.write(`Project: (not in a Git repo)\n\n`);
  }

  process.stdout.write(`Shipped files (SHA-256):\n`);
  for (const rel of files) {
    let suffix = "";
    if (verification) {
      const row = verification.find((v) => v.path === rel);
      if (!row.expected) suffix = " (not in manifest)";
      else if (!row.match) suffix = " MISMATCH";
    } else {
      suffix = " (no manifest)";
    }
    process.stdout.write(`  ${hashes[rel]}  ${rel}${suffix}\n`);
  }

  if (verification) {
    const mismatches = verification.filter((v) => v.expected && !v.match);
    if (mismatches.length > 0) {
      process.stdout.write(`\n${mismatches.length} file(s) differ from MANIFEST.json.\n`);
      process.exitCode = 1;
    }
  }
}
