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

// Paths excluded before any file is read, at every directory depth and
// regardless of config.ignore. They are built in rather than defaulted
// into config.json because `init` keeps an existing valid config, so a
// changed default would never reach upgraded installations.
//
// Credentials: dotenv files (`.env.example` is a false positive accepted
// on purpose), package-manager and cloud credentials, SSH and GPG keys,
// and Terraform state. Lockfiles are not secret, but their churn would
// crowd real code out of the bounded context. `.learning-moments/` holds
// earlier questions and their hidden answer outlines.
export const BUILTIN_IGNORED_PATHS = Object.freeze([
  "**/.env",
  "**/.env.*",
  "**/.envrc",
  "**/.npmrc",
  "**/.yarnrc.yml",
  "**/.pypirc",
  "**/.netrc",
  "**/.pgpass",
  "**/.git-credentials",
  "**/.aws/**",
  "**/.azure/**",
  "**/.ssh/**",
  "**/.gnupg/**",
  "**/.config/gcloud/**",
  "**/.docker/config.json",
  "**/.kube/config",
  "**/id_rsa",
  "**/id_dsa",
  "**/id_ecdsa",
  "**/id_ed25519",
  "**/*.tfstate",
  "**/*.tfstate.*",
  "**/*.tfvars",
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/pnpm-lock.yaml",
  "**/bun.lock",
  "**/go.sum",
  "**/packages.lock.json",
  "**/.learning-moments/**"
]);

export const BUILTIN_IGNORED_EXTENSIONS = Object.freeze([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".kdbx",
  ".lock",
  ".lockb"
]);

/**
 * @param {string[]} files
 * @param {{ ignore: { paths: string[], extensions: string[] } }} config
 */
export function candidateFiles(files, config) {
  return files.filter((file) => {
    const extension = path.extname(file);
    if (BUILTIN_IGNORED_EXTENSIONS.includes(extension) || config.ignore.extensions.includes(extension)) {
      return false;
    }
    return ![...BUILTIN_IGNORED_PATHS, ...config.ignore.paths].some((pattern) => matchGlob(pattern, file));
  });
}
