import fs from "node:fs/promises";

export async function pathExists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile(path) {
  return JSON.parse(await fs.readFile(path, "utf8"));
}

export async function writeJsonFile(path, value) {
  await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
