import path from "node:path";

const UNSUPPORTED_GLOB = [
  { re: /[?+@!]\(/, label: "extglob (e.g. ?(...), *(...), !(...))" },
  { re: /\{[^{}]*,[^{}]*\}/, label: "brace expansion (e.g. {a,b})" },
  { re: /\[[^\]]+\]/, label: "character class (e.g. [a-z])" },
  { re: /(?:^|[^*])\?/, label: "single-character wildcard '?'" }
];

export function unsupportedGlobFeature(pattern) {
  for (const { re, label } of UNSUPPORTED_GLOB) {
    if (re.test(pattern)) return label;
  }
  return null;
}

function escapeRegex(str) {
  return str.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function segmentMatches(pattern, segment) {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === segment;
  const re = new RegExp("^" + pattern.split("*").map(escapeRegex).join("[^/]*") + "$");
  return re.test(segment);
}

function walk(patterns, parts, pi, fi) {
  while (pi < patterns.length) {
    const pp = patterns[pi];
    if (pp === "**") {
      if (pi === patterns.length - 1) {
        return fi < parts.length;
      }
      for (let j = fi; j <= parts.length; j += 1) {
        if (walk(patterns, parts, pi + 1, j)) return true;
      }
      return false;
    }
    if (fi >= parts.length) return false;
    if (!segmentMatches(pp, parts[fi])) return false;
    pi += 1;
    fi += 1;
  }
  return fi === parts.length;
}

export function matchGlob(pattern, file) {
  return walk(pattern.split("/"), file.split("/"), 0, 0);
}

export function candidateFiles(files, config) {
  return files.filter((file) => {
    const extension = path.extname(file);
    if (config.ignore.extensions.includes(extension)) {
      return false;
    }
    return !config.ignore.paths.some((pattern) => matchGlob(pattern, file));
  });
}
