// The hook, end to end: a payload on stdin, a decision on stdout.
//
// Spawned as a real process rather than imported, because the contract being
// tested is the process one — argv, stdin, stdout, exit code — and that is
// what Claude Code actually invokes.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hook = join(root, "bin", "agent-rules-hook.js");
const rulesDir = join(root, "rules");

let sessions = 0;
const freshSession = () => `test-session-${process.pid}-${++sessions}`;

function run(mode, payload, { dirs = rulesDir, cache = mkdtempSync(join(tmpdir(), "ar-cache-")) } = {}) {
  const out = execFileSync("node", [hook, mode], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, AGENT_RULES_DIRS: dirs, AGENT_RULES_CACHE: cache },
  });
  return { out, cache };
}

const editing = (text, file = "a.ts") => ({
  session_id: freshSession(),
  cwd: "/repo",
  hook_event_name: "PostToolUse",
  tool_name: "Edit",
  tool_input: { file_path: `/repo/${file}`, old_string: "", new_string: text },
});

test("a violating write is reported as additionalContext, not a block", () => {
  const { out } = run("post", editing("function f(x: any) {}"));
  const reply = JSON.parse(out);
  assert.equal(reply.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(reply.hookSpecificOutput.additionalContext, /ts-no-any/);
  assert.match(reply.hookSpecificOutput.additionalContext, /unknown/);
  assert.equal(reply.hookSpecificOutput.permissionDecision, undefined);
});

test("clean code produces no output at all", () => {
  assert.equal(run("post", editing("function f(x: unknown) {}")).out, "");
});

test("pre mode is silent, because every shipped rule delivers post", () => {
  assert.equal(run("pre", editing("function f(x: any) {}")).out, "");
});

test("an interrupting rule asks a person instead", () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-rules-"));
  writeFileSync(
    join(dir, "no-fixme.md"),
    '---\ndescription: "No FIXME"\ncondition: "FIXME"\ninterruptMode: always\n---\n\nRemove it.\n',
  );
  const reply = JSON.parse(run("pre", editing("// FIXME"), { dirs: dir }).out);
  assert.equal(reply.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(reply.hookSpecificOutput.permissionDecision, "ask");
  assert.match(reply.hookSpecificOutput.permissionDecisionReason, /no-fixme/);
});

test("a rule fires once per session and then stays quiet", () => {
  const payload = editing("function f(x: any) {}");
  const first = run("post", payload);
  assert.notEqual(first.out, "");
  // Same cache, same session, same rule — the first call recorded it.
  assert.equal(run("post", payload, { cache: first.cache }).out, "");
});

test("a different session is told again", () => {
  const cache = mkdtempSync(join(tmpdir(), "ar-cache-"));
  run("post", editing("function f(x: any) {}"), { cache });
  assert.notEqual(run("post", editing("function f(x: any) {}"), { cache }).out, "");
});

// --- nothing may block a write ----------------------------------------------

test("malformed stdin exits 0 with no output", () => {
  const out = execFileSync("node", [hook, "post"], { input: "not json", encoding: "utf8" });
  assert.equal(out, "");
});

test("an empty payload exits 0 with no output", () => {
  assert.equal(run("post", {}).out, "");
});

test("a missing rules directory exits 0 with no output", () => {
  const gone = join(tmpdir(), "agent-rules-not-here");
  assert.equal(run("post", editing("function f(x: any) {}"), { dirs: gone }).out, "");
});

test("an unwatched tool exits 0 with no output", () => {
  const p = { ...editing("any"), tool_name: "Bash", tool_input: { command: "ls" } };
  assert.equal(run("post", p).out, "");
});
