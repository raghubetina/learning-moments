import { describe, expect, it } from "vitest";
import { candidateFiles, matchGlob } from "../src/core/filter.js";

const cases = [
  { file: "dist/foo.js", pattern: "dist/**", match: true },
  { file: "dist/sub/bar.js", pattern: "dist/**", match: true },
  { file: "dist", pattern: "dist/**", match: false },
  { file: "dist/", pattern: "dist/**", match: true },
  { file: "src/foo.js", pattern: "dist/**", match: false },
  { file: "node_modules/foo/bar.js", pattern: "node_modules/**", match: true },
  { file: "coverage/index.html", pattern: "coverage/**", match: true },
  { file: "coverage/lcov-report/index.html", pattern: "coverage/**", match: true },
  { file: "foo.log", pattern: "*.log", match: true },
  { file: "sub/foo.log", pattern: "*.log", match: false },
  { file: "sub/foo.log", pattern: "**/*.log", match: true },
  { file: ".env", pattern: "*", match: true },
  { file: ".env", pattern: "**", match: true },
  { file: "dir/.env", pattern: "**/.env", match: true },
  { file: "a/b/c", pattern: "a/**/c", match: true },
  { file: "a/c", pattern: "a/**/c", match: true },
  { file: "a/b/c", pattern: "a/*/c", match: true },
  { file: "a/b/d/c", pattern: "a/*/c", match: false }
];

describe("matchGlob", () => {
  for (const { file, pattern, match } of cases) {
    it(`${pattern} ${match ? "matches" : "does not match"} ${file}`, () => {
      expect(matchGlob(pattern, file)).toBe(match);
    });
  }
});

const baseConfig = {
  ignore: {
    paths: ["dist/**", "coverage/**", "node_modules/**"],
    extensions: [".lock"]
  }
};

describe("candidateFiles", () => {
  it("filters globs and extensions", () => {
    const input = [
      "src/foo.js",
      "dist/bar.js",
      "coverage/index.html",
      "node_modules/x/y.js",
      "package-lock.json",
      "yarn.lock"
    ];
    expect(candidateFiles(input, baseConfig)).toEqual(["src/foo.js", "package-lock.json"]);
  });

  it("filters secret-bearing paths under defaultConfig.ignore", async () => {
    const { defaultConfig } = await import("../src/core/config.js");
    const input = [
      "src/api.js",
      ".env",
      ".env.local",
      ".env.production",
      ".env.example",
      ".npmrc",
      ".pypirc",
      ".netrc",
      ".aws/credentials",
      ".ssh/id_rsa",
      ".config/gcloud/credentials.db",
      "certs/server.pem",
      "certs/server.key",
      "store.p12",
      "store.pfx"
    ];
    expect(candidateFiles(input, defaultConfig)).toEqual(["src/api.js"]);
  });
});
