#!/usr/bin/env node
// Is the hook wired up and finding rules? Runs the real hook as a real
// subprocess, the way Claude Code does, against a temporary cache so it always
// fires rather than being deduped by an earlier run.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRules } from "../src/rules.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const global = join(homedir(), ".omp", "agent", "rules");
const project = join(process.cwd(), ".omp", "rules");

console.log("rule directories the hook will read:");
for (const d of [global, project]) {
  console.log(`  ${existsSync(d) ? "found  " : "missing"}  ${d}`);
}

const { rules, warnings } = loadRules([global, project]);
for (const w of warnings) console.error(`WARNING ${w}`);

if (rules.length === 0) {
  console.error("\nno rules found.\n");
  console.error("Link this repository's rules into the global directory:");
  console.error(`  ln -s ${join(root, "rules")} ${global}\n`);
  process.exit(1);
}
console.log(`\n${rules.length} rules loaded\n`);

// The hook resolves its project rule directory from the payload's `cwd`, so
// the payload must carry the same cwd this script just reported on. They used
// to differ, and the report said "10 rules loaded" while the hook found none.
const file = join(process.cwd(), "app.ts");
const out = execFileSync("node", [join(root, "bin", "agent-rules-hook.js"), "post"], {
  input: JSON.stringify({
    session_id: "smoke",
    cwd: process.cwd(),
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: file, old_string: "", new_string: "function handle(p: any) { return p; }" },
  }),
  encoding: "utf8",
  env: { ...process.env, AGENT_RULES_CACHE: mkdtempSync(join(tmpdir(), "smoke-")) },
});

if (out === "") {
  console.error("the hook returned nothing for a line that should trip ts-no-any.");
  console.error("Check that rules/ts-no-any.md is present in the linked directory.");
  process.exit(1);
}

const reply = JSON.parse(out).hookSpecificOutput;
console.log(`event   : ${reply.hookEventName}`);
console.log(`decision: ${reply.permissionDecision ?? "(none — the write lands)"}`);
console.log("\nwhat the agent would be told:\n");
console.log((reply.additionalContext ?? reply.permissionDecisionReason).replace(/^/gm, "  "));
console.log("\nOK");
