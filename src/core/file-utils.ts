import fs from "node:fs/promises";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path, "utf8"));
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
