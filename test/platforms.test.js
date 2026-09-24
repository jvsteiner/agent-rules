import assert from "node:assert/strict";
import test from "node:test";
import { decode, encode } from "../src/platforms.js";

test("Claude decodes prompt, tool edits, stop response, and failed receipts", () => {
  assert.deepEqual(decode("claude", { hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "do it" }).userText, "do it");
  const edit = decode("claude", { hook_event_name: "PostToolUse", session_id: "s", tool_name: "Edit", tool_input: { file_path: "x", new_string: "new" }, tool_response: "ok" });
  assert.equal(edit.kind, "tool_result"); assert.equal(edit.changes[0].text, "new");
  assert.equal(decode("claude", { hook_event_name: "PostToolUseFailure", tool_name: "Bash" }).tool.status, "failure");
  const stop = decode("claude", { hook_event_name: "Stop", last_assistant_message: "done", stop_hook_active: true });
  assert.equal(stop.response, "done"); assert.equal(stop.stopHookActive, true);
  assert.equal(decode("claude", { hook_event_name: "FutureEvent" }), null);
  assert.equal(decode("claude", { hook_event_name: "Notification" }), null);
  assert.equal(decode("claude", { hook_event_name: "PostToolUse", tool_name: "MultiEdit", tool_input: { edits: [{ file_path: "x", new_string: "a" }, { file_path: "y", new_string: "b" }] } }).changes.length, 2);
});

test("Codex explicitly extracts apply_patch and only exposes supplied thinking", () => {
  const event = decode("codex", { type: "PostToolUse", session_id: "s", payload: { tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Add File: a.js\n+const x = 1;\n*** End Patch" }, tool_use_id: "t1", tool_response: "applied" } });
  assert.equal(event.changes[0].path, "a.js"); assert.equal(event.changes[0].text, "const x = 1;");
  assert.equal(event.tool.id, "t1"); assert.equal(event.tool.result, "applied");
  assert.equal(event.thinking, undefined);
  const codexReceipt = decode("codex", { type: "PostToolUse", session_id: "s", tool_name: "Bash", tool_use_id: "t", tool_input: { command: "npm test" }, tool_response: "SYNTHETIC TEST RESULT: 2 failed, 0 passed\n" });
  assert.equal(codexReceipt.tool.id, "t"); assert.equal(codexReceipt.tool.result, "SYNTHETIC TEST RESULT: 2 failed, 0 passed\n");
  assert.equal(codexReceipt.tool.status, "completed");
  assert.equal(decode("codex", { type: "PostToolUse", tool_name: "Bash", tool_input: {}, tool_response: "bad", exit_code: 1 }).tool.status, "failure");
  assert.deepEqual(decode("codex", { type: "Stop", thinking: [{ id: "r1", text: "visible", completeness: "partial" }] }).thinking[0], { id: "r1", text: "visible", kind: "exposed", completeness: "partial" });
  assert.equal(decode("codex", { type: "UserPromptSubmit", payload: { prompt: "go" } }).source, "host_user");
});

test("encoders use Stop continuation and PostToolUse advisory context", () => {
  assert.equal(encode("claude", { action: "continue_turn", feedback: "fix", notice: "notice" }).decision, "block");
  assert.equal(encode("codex", { action: "add_context", feedback: "keep", notice: "seen" }).hookSpecificOutput.additionalContext, "keep");
  assert.deepEqual(encode("codex", { action: "none" }), {});
  assert.deepEqual(encode("codex", { action: "none", notice: "resolved" }), { systemMessage: "resolved" });
});
