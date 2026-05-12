import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(here, "..", "..");

export function packageRoot() {
  return PACKAGE_ROOT;
}

export function cliPath() {
  return path.join(PACKAGE_ROOT, "src", "cli.js");
}

let cachedVersion;
export function version() {
  if (cachedVersion === undefined) {
    const pkgPath = path.join(PACKAGE_ROOT, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    cachedVersion = pkg.version;
  }
  return cachedVersion;
}

export function manifestPath() {
  return path.join(PACKAGE_ROOT, "MANIFEST.json");
}
