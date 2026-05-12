import { randomBytes } from "node:crypto";

export function utcStamp(date = new Date()) {
  const iso = date.toISOString();
  return iso
    .slice(0, 19)
    .replaceAll("-", "")
    .replace("T", "_")
    .replaceAll(":", "");
}

export function createId(kind, date = new Date()) {
  return `lm_${kind}_${utcStamp(date)}_${randomBytes(2).toString("hex")}`;
}

export function shortId(id) {
  const suffix = id.split("_").at(-1);
  return suffix ? `lm_${suffix}` : id;
}
