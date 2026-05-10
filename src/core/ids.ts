import { randomBytes } from "node:crypto";

export type IdKind =
  | "change"
  | "moment"
  | "recall"
  | "grade"
  | "baseline"
  | "event";

export function utcStamp(date = new Date()): string {
  const iso = date.toISOString();
  return iso
    .slice(0, 19)
    .replaceAll("-", "")
    .replace("T", "_")
    .replaceAll(":", "");
}

export function createId(kind: IdKind, date = new Date()): string {
  return `lm_${kind}_${utcStamp(date)}_${randomBytes(2).toString("hex")}`;
}

export function shortId(id: string): string {
  const suffix = id.split("_").at(-1);
  return suffix ? `lm_${suffix}` : id;
}
