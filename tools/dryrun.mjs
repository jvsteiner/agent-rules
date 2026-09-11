#!/usr/bin/env node
// Count what the rules would have fired on, over real recent commits.
//
// Run this before shipping a new rule. It is how `no-hardcoded-secret` was
// caught matching all 1,044 file-changes in the corpus rather than the four it
// meant to: a `/` inside its character class turned the whole regex into a file
// glob (see `src/rules.js`).
//
//   node tools/dryrun.mjs ~/Code/one ~/Code/two
//   node tools/dryrun.mjs --commits 200 ~/Code/one
//
// Defaults to the rules in this repository and the current directory.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRules } from "../src/rules.js";
import { matchPayload } from "../src/match.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
let commits = 60;
const repos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--commits") { commits = Number(argv[++i]); continue; }
  if (argv[i] === "--rules") { continue; }
  repos.push(argv[i]);
}
if (repos.length === 0) repos.push(process.cwd());

const ruleDir = process.env.AGENT_RULES_DIR ?? join(root, "rules");
const { rules, warnings } = loadRules([ruleDir]);
for (const w of warnings) console.error(`WARNING ${w}`);
console.log(`${rules.length} rules from ${ruleDir}\n`);

const counts = new Map(rules.map((r) => [r.name, 0]));
const samples = new Map();
let changes = 0;

/** Rebuild a RegExp from its `String()` form, to find the line that matched. */
const reFromString = (s) => {
  const end = s.lastIndexOf("/");
  return new RegExp(s.slice(1, end), s.slice(end + 1));
};

for (const repo of repos) {
  let raw;
  try {
    raw = execFileSync(
      "git",
      ["-C", repo, "log", "-p", "-n", String(commits), "--no-color", "--unified=0", "--no-merges"],
      { encoding: "utf8", maxBuffer: 512e6 },
    );
  } catch {
    console.error(`skipped (not a git repository): ${repo}`);
    continue;
  }

  let path = null;
  let added = [];

  const flush = () => {
    if (path && added.length > 0) {
      changes++;
      const fired = matchPayload(
        {
          cwd: repo,
          tool_name: "Edit",
          tool_input: { file_path: join(repo, path), old_string: "", new_string: added.join("\n") },
        },
        rules,
      );
      for (const f of fired) {
        counts.set(f.name, counts.get(f.name) + 1);
        if (!samples.has(f.name)) {
          const line = added.find((l) => reFromString(f.matched).test(l)) ?? "";
          samples.set(f.name, `${path}: ${line.trim().slice(0, 80)}`);
        }
      }
    }
    added = [];
  };

  for (const line of raw.split("\n")) {
    if (line.startsWith("+++ b/")) { flush(); path = line.slice(6); continue; }
    if (line.startsWith("--- ") || line.startsWith("diff --git")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
  }
  flush();
}

console.log(`${changes} file-changes across ${repos.length} repositories\n`);
let total = 0;
for (const [name, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  total += n;
  console.log(`${String(n).padStart(6)}  ${name.padEnd(22)} ${n ? samples.get(name) : ""}`);
}
console.log(`\n${total} hits. Read every one: a rule nobody trusts gets switched off.`);
