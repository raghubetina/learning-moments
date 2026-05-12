#!/usr/bin/env node
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

async function walkDir(dir) {
  const result = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await walkDir(full)));
    } else if (entry.isFile()) {
      result.push(full);
    }
  }
  return result;
}

async function listFiles(entries) {
  const out = [];
  for (const entry of entries) {
    const trimmed = entry.replace(/\/$/, "");
    const abs = path.join(ROOT, trimmed);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) {
      const walked = await walkDir(abs);
      for (const file of walked) {
        out.push(path.relative(ROOT, file));
      }
    } else if (stat.isFile()) {
      out.push(trimmed);
    }
  }
  return out.sort();
}

async function hashFile(absPath) {
  const buf = await fs.readFile(absPath);
  return createHash("sha256").update(buf).digest("hex");
}

async function main() {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  const entries = (pkg.files ?? []).filter((entry) => entry !== "MANIFEST.json");

  const files = await listFiles(entries);
  const fileHashes = {};
  for (const rel of files) {
    fileHashes[rel] = await hashFile(path.join(ROOT, rel));
  }

  const manifest = {
    name: pkg.name,
    version: pkg.version,
    generatedAt: new Date().toISOString(),
    files: fileHashes
  };

  const target = path.join(ROOT, "MANIFEST.json");
  await fs.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`Wrote ${target} (${files.length} files)\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message ?? error}\n`);
  process.exitCode = 1;
});
