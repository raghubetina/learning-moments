#!/usr/bin/env node
// Writes the Claude Code plugin's hooks and skills from the same hook specs
// and command templates that `learning-moments init` installs, so the two
// install paths cannot drift. A test fails when the committed files differ
// from what this produces.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hookSpecs, makeHookEntry } from "../src/core/claude-settings.js";
import { commandPrompts, renderCommandPrompt } from "../src/core/defaults.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_CLI = "${CLAUDE_PLUGIN_ROOT}/src/cli.js";

export function pluginFiles(pkg) {
  /** @type {Record<string, unknown[]>} */
  const hooks = {};
  for (const spec of hookSpecs) {
    const entry = makeHookEntry(spec, PLUGIN_CLI);
    const group = spec.matcher ? { matcher: spec.matcher, hooks: [entry] } : { hooks: [entry] };
    (hooks[spec.event] ??= []).push(group);
  }
  /** @type {Record<string, string>} */
  const files = {
    ".claude-plugin/plugin.json": `${JSON.stringify(
      {
        name: "learning-moments",
        displayName: "Learning Moments",
        version: pkg.version,
        description: pkg.description,
        author: { name: pkg.author },
        homepage: pkg.homepage,
        repository: "https://github.com/raghubetina/learning-moments",
        license: pkg.license,
        keywords: pkg.keywords,
        types: "./types/index.d.ts",
        userConfig: {
          question_band: {
            type: "boolean",
            title: "Question band (experimental)",
            description:
              "Show questions in a band above the prompt, with a field to answer and a Skip button, instead of having Claude ask them.",
            default: false
          }
        }
      },
      null,
      2
    )}\n`,
    // The experimental question band, a mod; it does nothing unless the
    // question_band option is on.
    "hooks/hooks.json": `${JSON.stringify({ hooks, modules: ["./question-band.tsx"] }, null, 2)}\n`
  };
  // Quoted: the plugin root can contain spaces (a home directory, or a
  // --plugin-dir checkout).
  for (const [name, prompt] of Object.entries(commandPrompts(`node "${PLUGIN_CLI}"`, { plugin: true }))) {
    files[`skills/${name}/SKILL.md`] = renderCommandPrompt(prompt);
  }
  return files;
}

async function main() {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  for (const [rel, content] of Object.entries(pluginFiles(pkg))) {
    await fs.mkdir(path.dirname(path.join(ROOT, rel)), { recursive: true });
    await fs.writeFile(path.join(ROOT, rel), content);
  }
  console.log("Wrote plugin manifest, hooks, and skills.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
