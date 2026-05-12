import crypto from "node:crypto";

export function candidateFingerprint(files, redactedDiff) {
  const hash = crypto.createHash("sha256");
  hash.update(JSON.stringify([...files].sort()));
  hash.update("\n");
  hash.update(redactedDiff);
  return `sha256:${hash.digest("hex").slice(0, 24)}`;
}
