import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { handleEvent } from "../src/runtime.js";
import { createReviewer } from "../src/review.js";
import { parsePolicy } from "../src/catalog.js";

const make = async () => ({ stateDir: await mkdtemp(join(tmpdir(), "ar-runtime-")), policies: [{ id: "p" }] });
const event = (kind, extra = {}) => ({ platform: "codex", sessionId: "s", actorId: "main", kind, source: "unknown", ...extra });
const reviewerWith = (findings) => ({ review: async () => ({ findings }) });
const finding = (id = "f", evidence = "e1", mode = "repair") => ({ id, ruleId: "rule", status: "finding", description: "issue", correction: "correct it", evidence, mode });

test("genuine user prompt starts an episode; continuation does not reset the cap", async () => {
  const ctx = await make(); const reviewer = reviewerWith([finding()]);
  await handleEvent(event("user_prompt", { source: "host_user", userText: "task" }), ctx);
  const first = await handleEvent(event("response_end", { response: "bad" }), { ...ctx, reviewer });
  assert.equal(first.action, "continue_turn");
  await handleEvent(event("user_prompt", { source: "plugin_continuation", userText: first.feedback }), ctx);
  const second = await handleEvent(event("response_end", { response: "still bad" }), { ...ctx, reviewer });
  assert.equal(second.action, "none"); assert.match(second.notice, /No progress/);
  await handleEvent(event("user_prompt", { source: "host_user", userText: "new task" }), ctx);
  assert.equal((await handleEvent(event("response_end", { response: "bad again" }), { ...ctx, reviewer })).action, "continue_turn");
});

test("review snapshots preserve long responses and receipts and mark incomplete capture", async () => {
  const ctx = await make(); const response = "r".repeat(18000), receiptText = "x".repeat(22000); let snapshot;
  const reviewer = { review: async (value) => { snapshot = value; return { findings: [] }; } };
  await handleEvent(event("user_prompt", { source: "host_user", userText: "task" }), ctx);
  await handleEvent(event("tool_result", { tool: { id: "one", name: "shell", input: {}, result: receiptText, status: "completed" }, response }), { ...ctx, reviewer });
  assert.equal(snapshot.response.length, response.length);
  assert.equal(snapshot.receipts[0].result.length, receiptText.length);
  assert.equal(snapshot.coverage.complete, true);

  const extreme = { review: async (value) => { snapshot = value; return { findings: [] }; } };
  for (let i = 0; i < 7; i++) {
    await handleEvent(event("tool_result", { tool: { id: `large-${i}`, name: "shell", input: {}, result: "z".repeat(90000), status: "completed" } }), { ...ctx, reviewer: extreme });
  }
  assert.equal(snapshot.coverage.complete, false);
  assert.ok(snapshot.coverage.truncatedSources.length > 0);
  assert.ok(JSON.stringify(snapshot).length < 600000);
});

test("thinking truncation and rolling receipt eviction are reported as incomplete coverage", async () => {
  const ctx = await make(); let snapshot;
  const reviewer = { review: async (value) => { snapshot = value; return { findings: [] }; } };
  await handleEvent(event("user_prompt", { source: "host_user", userText: "task" }), ctx);
  await handleEvent(event("response_end", { thinking: [
    { id: "thought-1", text: "t".repeat(15000) }, { id: "thought-2", text: "t".repeat(100000) },
  ] }), { ...ctx, reviewer });
  assert.equal(snapshot.coverage.complete, false);
  assert.equal(snapshot.thinking[0].text.length, 15000);
  assert.ok(snapshot.coverage.truncatedSources.includes("thinking:thought-2"));
  for (let i = 0; i < 81; i++) {
    await handleEvent(event("tool_result", { tool: { id: `receipt-${i}`, name: "shell", input: {}, result: `result-${i}`, status: "completed" } }), { ...ctx, reviewer });
  }
  assert.equal(snapshot.coverage.complete, false);
  assert.ok(snapshot.coverage.truncatedSources.includes("receipt:receipt-0"));
});

test("unchanged evidence is quiet and updated evidence can use only the remaining cap", async () => {
  const ctx = await make(); let f = finding("f", "same"); const reviewer = { review: async () => ({ findings: [f] }) };
  await handleEvent(event("user_prompt", { source: "host_user", userText: "task" }), ctx);
  assert.equal((await handleEvent(event("response_end"), { ...ctx, reviewer })).action, "continue_turn");
  await handleEvent(event("user_prompt", { source: "plugin_continuation", userText: "repair" }), ctx);
  assert.match((await handleEvent(event("response_end"), { ...ctx, reviewer })).notice, /No progress/);
  f = finding("f", "changed");
  await handleEvent(event("user_prompt", { source: "plugin_continuation", userText: "repair" }), ctx);
  assert.equal((await handleEvent(event("response_end"), { ...ctx, reviewer })).action, "continue_turn");
  f = finding("f", "changed-again");
  await handleEvent(event("user_prompt", { source: "plugin_continuation", userText: "repair" }), ctx);
  assert.match((await handleEvent(event("response_end"), { ...ctx, reviewer })).notice, /limit/);
});

test("a newer event makes an in-flight review stale", async () => {
  const ctx = await make(); let release; const gate = new Promise((r) => { release = r; });
  const reviewer = { review: async () => { await gate; return { findings: [finding()] }; } };
  await handleEvent(event("user_prompt", { source: "host_user", userText: "first" }), ctx);
  const pending = handleEvent(event("response_end"), { ...ctx, reviewer });
  await new Promise((r) => setTimeout(r, 10));
  await handleEvent(event("user_prompt", { source: "host_user", userText: "second" }), ctx);
  release(); assert.equal((await pending).action, "none");
});

test("concurrent review calls serialize and never exceed two corrections", async () => {
  const ctx = await make(); const reviewer = reviewerWith([finding()]);
  await handleEvent(event("user_prompt", { source: "host_user", userText: "task" }), ctx);
  const results = await Promise.all(Array.from({ length: 6 }, () => handleEvent(event("response_end"), { ...ctx, reviewer })));
  assert.ok(results.filter((r) => r.action === "continue_turn").length <= 1);
  const files = await readdir(ctx.stateDir); const data = JSON.parse(await readFile(join(ctx.stateDir, files.find((x) => x.endsWith(".json"))), "utf8"));
  assert.ok(data.correctionsDelivered <= 2);
});

test("state write or corrupt state fails closed as observe-only", async () => {
  const ctx = await make(); const reviewer = reviewerWith([finding()]);
  await handleEvent(event("user_prompt", { source: "host_user", userText: "task" }), ctx);
  const file = join(ctx.stateDir, (await readdir(ctx.stateDir)).find((x) => x.endsWith(".json")));
  const { writeFile } = await import("node:fs/promises"); await writeFile(file, "{");
  assert.deepEqual(await handleEvent(event("response_end"), { ...ctx, reviewer }), { action: "none", notice: "Agent Rules state storage is unavailable; review is observe-only." });
});

test("observe findings never trigger repairs; arrays retain exact evidence and clear requires same-rule evidence", async () => {
  const ctx = await make(); let current = finding("f", ["exact quote", "second line"], "observe");
  const reviewer = { review: async () => ({ findings: [current] }) };
  await handleEvent(event("user_prompt", { source: "host_user", userText: "task" }), ctx);
  const observed = await handleEvent(event("response_end"), { ...ctx, reviewer });
  assert.equal(observed.action, "none"); assert.equal(observed.feedback, undefined);
  assert.equal(observed.notice, "Agent Rules (observe): rule would have fired.");
  const repeated = await handleEvent(event("response_end"), { ...ctx, reviewer });
  assert.equal(repeated.notice, undefined);
  current = finding("f", ["exact quote", "second line"], "repair");
  const repair = await handleEvent(event("response_end"), { ...ctx, reviewer });
  assert.match(repair.feedback, /exact quote\nsecond line/); assert.match(repair.feedback, /attempt 1\/2/);
  current = { ruleId: "other", status: "clear", evidence: "checked" };
  assert.equal((await handleEvent(event("response_end"), { ...ctx, reviewer })).action, "none");
  assert.equal((await handleEvent(event("response_end"), { ...ctx, reviewer })).notice, undefined);
  current = { ruleId: "rule", status: "clear", evidence: "checked all relevant content" };
  assert.deepEqual(await handleEvent(event("response_end"), { ...ctx, reviewer }), { action: "none" });
});

test("user_prompt policies add context before work starts; tool_start policies deny the pending call", async () => {
  const ctx = await make(); let seen;
  const prompt = { ...ctx, policies: [{ id: "req", events: ["user_prompt"] }] };
  const reviewer = { review: async (snapshot) => { seen = snapshot; return { findings: [{ ...finding("r", "blocked topic"), ruleId: "req" }] }; } };
  const added = await handleEvent(event("user_prompt", { source: "host_user", userText: "find cat pictures" }), { ...prompt, reviewer });
  assert.equal(seen.request, "find cat pictures");
  assert.equal(added.action, "add_context"); assert.equal(added.event, "user_prompt"); assert.match(added.feedback, /attempt 1\/2/);

  const tools = { ...ctx, policies: [{ id: "tool", events: ["tool_start"] }] };
  const toolReviewer = { review: async (snapshot) => { seen = snapshot; return { findings: [{ ...finding("t", "search"), ruleId: "tool" }] }; } };
  const denied = await handleEvent(event("tool_start", { tool: { id: "call-1", name: "WebSearch", input: { query: "cat pictures" } } }), { ...tools, reviewer: toolReviewer });
  assert.equal(seen.currentTool.id, "call-1"); assert.match(seen.currentTool.input, /cat pictures/);
  assert.equal(denied.action, "deny_tool"); assert.equal(denied.event, "tool_start");
});

test("tool blocks repeat for identical calls, ignore the correction limit, and say where they came from", async () => {
  const ctx = { ...(await make()), policies: [{ id: "tool", events: ["tool_start"] }], config: { maxCorrectionsPerEpisode: 1 } };
  const reviewer = { review: async () => ({ findings: [{ ...finding("t", "same call"), ruleId: "tool" }] }) };
  await handleEvent(event("user_prompt", { source: "host_user", userText: "task" }), ctx);
  for (let i = 0; i < 3; i++) {
    const denied = await handleEvent(event("tool_start", { tool: { id: `call-${i}`, name: "Bash", input: { command: "same" } } }), { ...ctx, reviewer });
    assert.equal(denied.action, "deny_tool", `call ${i}`);
    assert.match(denied.feedback, /\[Agent Rules: tool; blocked\]\nThis message comes from Agent Rules, a plugin the user installed/);
    assert.match(denied.feedback, /The user's rule: issue/);
  }
});

test("an unsure classifier is silent; missing evidence still notifies", async () => {
  const ctx = await make();
  const unsure = { ruleId: "rule", status: "unknown", diagnostic: { code: "below_threshold", message: "The winning classification did not meet the policy's confidence threshold." }, evidence: [] };
  const missing = { ruleId: "rule", status: "unknown", diagnostic: { code: "missing_evidence", message: "Required evidence is missing or incomplete: changes." }, evidence: [] };
  await handleEvent(event("user_prompt", { source: "host_user", userText: "edited it" }), ctx);
  assert.deepEqual(await handleEvent(event("response_end", { response: "ok" }), { ...ctx, reviewer: reviewerWith([unsure]) }), { action: "none" });
  assert.match((await handleEvent(event("response_end", { response: "ok" }), { ...ctx, reviewer: reviewerWith([missing]) })).notice, /could not complete review/);
});

test("prompt and pre-tool reviews do not run unless a policy asks for that event", async () => {
  const ctx = await make(); let calls = 0;
  const reviewer = { review: async () => { calls++; return { findings: [] }; } };
  await handleEvent(event("user_prompt", { source: "host_user", userText: "task" }), { ...ctx, reviewer });
  await handleEvent(event("tool_start", { tool: { id: "a", name: "Bash", input: {} } }), { ...ctx, reviewer });
  assert.equal(calls, 0);
});

test("interrupt suppresses Stop reviews until a genuine prompt starts a new episode", async () => {
  const ctx = await make(); let calls = 0;
  const reviewer = { review: async () => { calls++; return { findings: [finding()] }; } };
  await handleEvent(event("user_prompt", { source: "host_user", userText: "task" }), ctx);
  await handleEvent(event("interrupt"), ctx);
  assert.equal((await handleEvent(event("response_end"), { ...ctx, reviewer })).action, "none"); assert.equal(calls, 0);
  await handleEvent(event("user_prompt", { source: "host_user", userText: "next" }), ctx);
  assert.equal((await handleEvent(event("response_end"), { ...ctx, reviewer })).action, "continue_turn");
});

test("separate Node processes cannot exceed the episode correction cap", async () => {
  const ctx = await make(); const reviewer = reviewerWith([finding()]);
  await handleEvent(event("user_prompt", { source: "host_user", userText: "task" }), ctx);
  const script = `import {handleEvent} from ${JSON.stringify(new URL("../src/runtime.js", import.meta.url).href)}; const reviewer={review:async()=>({findings:[{id:'f',ruleId:'rule',status:'finding',mode:'repair',correction:'fix',evidence:'ev'}]})}; handleEvent({platform:'codex',sessionId:'s',actorId:'main',kind:'response_end'}, {reviewer,policies:[{}],stateDir:${JSON.stringify(ctx.stateDir)}}).then(x=>process.stdout.write(JSON.stringify(x)));`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script]); let out = "";
    child.stdout.on("data", (d) => out += d); child.on("error", reject); child.on("close", (code) => code ? reject(new Error(`child ${code}`)) : resolve(JSON.parse(out)));
  });
  const results = await Promise.all([run(), run()]);
  assert.ok(results.filter((x) => x.action === "continue_turn").length <= 1);
});

test("tool start and failed result correlate into a complete receipt for the real reviewer", async () => {
  const ctx = await make(); let received;
  const policy = parsePolicy(await readFile(new URL("../policies/test-result-contradiction.md", import.meta.url), "utf8"));
  const reviewer = createReviewer({ client: { evaluate: async ({ state }) => {
    received = state;
    return { answers: { q0: { type: "choice", choice: "contradicted", probabilities: { supported: 0.01, contradicted: 0.98, unknown: 0.005, not_applicable: 0.005 } } } };
  } } });
  await handleEvent(event("user_prompt", { source: "host_user", userText: "Run the tests and report the result." }), ctx);
  await handleEvent(event("tool_start", { tool: { id: "call-1", name: "shell", input: { command: "npm test" }, status: "pending" } }), ctx);
  await handleEvent(event("tool_result", { tool: { id: "call-1", name: "shell", input: { command: "npm test" }, result: "1 test failed", status: "failure" } }), ctx);
  const effect = await handleEvent(event("response_end", { response: "All tests passed." }), { ...ctx, policies: [policy], reviewer });
  assert.equal(received.receipts.length, 1); assert.equal(received.receipts[0].status, "failure");
  assert.match(effect.feedback, /Correct the conflicting test-result claim/);
});

test("unchanged array evidence is deduplicated across persisted state reads", async () => {
  const ctx = await make(); const f = finding("array", [{ id: "response-0", text: "same exact quote" }]); const reviewer = reviewerWith([f]);
  await handleEvent(event("user_prompt", { source: "host_user", userText: "task" }), ctx);
  assert.equal((await handleEvent(event("response_end"), { ...ctx, reviewer })).action, "continue_turn");
  await handleEvent(event("user_prompt", { source: "plugin_continuation", userText: "repair" }), ctx);
  assert.match((await handleEvent(event("response_end"), { ...ctx, reviewer })).notice, /No progress/);
});

test("a clear candidate does not resolve a same-rule finding when another candidate still violates", async () => {
  const ctx = await make(); let findings = [finding("v", "evidence")];
  const reviewer = { review: async () => ({ findings }) };
  await handleEvent(event("user_prompt", { source: "host_user", userText: "task" }), ctx);
  await handleEvent(event("response_end"), { ...ctx, reviewer });
  findings = [{ id: "clear", ruleId: "rule", status: "clear", evidence: "checked evidence" }, finding("v", "evidence")];
  const effect = await handleEvent(event("response_end"), { ...ctx, reviewer });
  assert.match(effect.notice, /No progress/); assert.doesNotMatch(effect.notice, /no longer present/);
  findings = [{ id: "clear", ruleId: "rule", status: "clear", evidence: "checked evidence" },
    { id: "unknown", ruleId: "rule", status: "unknown", evidence: [] }];
  const partialClear = await handleEvent(event("response_end"), { ...ctx, reviewer });
  assert.equal(partialClear.notice, undefined);
  const stateFile = join(ctx.stateDir, (await readdir(ctx.stateDir)).find((x) => x.endsWith(".json")));
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.ok(Object.values(state.findings).some((f) => f.id === "v" && f.status === "finding"));
});

test("a Stop hook with missing state cannot renew the correction budget until a genuine prompt", async () => {
  const ctx = await make(); let calls = 0;
  const reviewer = { review: async () => { calls++; return { findings: [finding()] }; } };
  const stop = event("response_end", { stopHookActive: true });
  assert.match((await handleEvent(stop, { ...ctx, reviewer })).notice, /state is missing/);
  assert.match((await handleEvent(stop, { ...ctx, reviewer })).notice, /state is missing/);
  assert.equal(calls, 0);
  await handleEvent(event("user_prompt", { source: "host_user", userText: "new request" }), ctx);
  assert.equal((await handleEvent(event("response_end"), { ...ctx, reviewer })).action, "continue_turn");
});

test("unknown and unavailable health notices appear once per status and report recovery", async () => {
  const ctx = await make(); let result = { findings: [{ id: "u", ruleId: "r", status: "unknown" }] };
  const reviewer = { review: async () => result };
  await handleEvent(event("user_prompt", { source: "host_user", userText: "task" }), ctx);
  const first = await handleEvent(event("response_end"), { ...ctx, reviewer });
  assert.match(first.notice, /missing or inconclusive/);
  assert.equal((await handleEvent(event("response_end"), { ...ctx, reviewer })).notice, undefined);
  result = { findings: [{ id: "c", ruleId: "r", status: "clear", evidence: "enough evidence" }] };
  assert.match((await handleEvent(event("response_end"), { ...ctx, reviewer })).notice, /coverage has recovered/);
});

test("recovered review processes a violation immediately and keeps prior unknown judgments inspectable", async () => {
  const ctx = await make(); let status = "unknown";
  const reviewer = { review: async () => ({ model: "test-model", findings: [{
    id: "finding-1", ruleId: "rule", status, mode: "repair", correction: "fix it",
    evidence: [{ id: "response-0", text: "exact evidence" }], judgment: { choice: status }, policyHash: "policy-hash",
  }] }) };
  await handleEvent(event("user_prompt", { source: "host_user", userText: "task" }), ctx);
  assert.match((await handleEvent(event("response_end"), { ...ctx, reviewer })).notice, /inconclusive/);
  const file = join(ctx.stateDir, (await readdir(ctx.stateDir)).find((x) => x.endsWith(".json")));
  let state = JSON.parse(await readFile(file, "utf8"));
  assert.ok(Object.values(state.findings).some((f) => f.status === "unknown" && f.judgment.choice === "unknown"));
  status = "violation";
  const effect = await handleEvent(event("response_end"), { ...ctx, reviewer });
  assert.equal(effect.action, "continue_turn");
  assert.match(effect.feedback, /fix it/);
  assert.doesNotMatch(effect.notice, /coverage has recovered/);
  state = JSON.parse(await readFile(file, "utf8"));
  assert.ok(Object.values(state.findings).some((f) => f.status === "unknown"));
  assert.ok(Object.values(state.findings).some((f) => f.status === "violation" && f.policyHash === "policy-hash" && f.model === "test-model"));
});

test("only successful tool results update current code evidence, replacing prior text by path", async () => {
  const ctx = await make(); const snapshots = [];
  const reviewer = { review: async (snapshot) => { snapshots.push(snapshot); return { findings: [] }; } };
  const rules = [{ id: "code" }];
  await handleEvent(event("user_prompt", { source: "host_user", userText: "Fix the function." }), ctx);
  await handleEvent(event("tool_start", { tool: { id: "bad", name: "Edit", input: {}, status: "pending" }, changes: [{ path: "src/f.js", text: "bad implementation" }] }), { ...ctx, policies: rules, reviewer });
  await handleEvent(event("tool_result", { tool: { id: "bad", name: "Edit", input: {}, result: "failed", status: "failure" }, changes: [{ path: "src/f.js", text: "bad implementation" }] }), { ...ctx, policies: rules, reviewer });
  assert.deepEqual(snapshots.at(-1).changes, []);
  await handleEvent(event("tool_start", { tool: { id: "good", name: "Edit", input: {}, status: "pending" }, changes: [{ path: "src/f.js", text: "corrected implementation" }] }), { ...ctx, policies: rules, reviewer });
  await handleEvent(event("tool_result", { tool: { id: "good", name: "Edit", input: {}, result: "written", status: "completed" }, changes: [{ path: "src/f.js", text: "corrected implementation" }] }), { ...ctx, policies: rules, reviewer });
  await handleEvent(event("response_end"), { ...ctx, policies: rules, reviewer });
  assert.equal(snapshots.at(-1).changes.length, 1);
  assert.equal(snapshots.at(-1).changes[0].text, "corrected implementation");
  assert.doesNotMatch(JSON.stringify(snapshots.at(-1).changes), /bad implementation/);
});

test("duplicate actionable findings in one result emit only one correction", async () => {
  const ctx = await make(); const duplicated = finding("duplicate", "same evidence");
  const reviewer = reviewerWith([duplicated, { ...duplicated }]);
  await handleEvent(event("user_prompt", { source: "host_user", userText: "task" }), ctx);
  const effect = await handleEvent(event("response_end"), { ...ctx, reviewer });
  assert.equal(effect.feedback.match(/Correction:/g).length, 1);
});

test("finding inspection metadata is retained, history is bounded, and corrections sort by priority", async () => {
  const ctx = await make();
  const findings = Array.from({ length: 90 }, (_, i) => ({ ...finding(`f${i}`, `e${i}`),
    ruleId: `rule-${i}`, priority: i, judgment: { choice: "bad" }, policyHash: `hash-${i}` }));
  const reviewer = reviewerWith(findings);
  await handleEvent(event("user_prompt", { source: "host_user", userText: "task" }), ctx);
  const effect = await handleEvent(event("response_end"), { ...ctx, reviewer, config: { maxCorrectionsPerEpisode: 2 } });
  assert.ok(effect.feedback.indexOf("rule-89") < effect.feedback.indexOf("rule-88"));
  const file = join(ctx.stateDir, (await readdir(ctx.stateDir)).find((x) => x.endsWith(".json")));
  const state = JSON.parse(await readFile(file, "utf8"));
  assert.equal(Object.keys(state.findings).length, 80);
  assert.deepEqual(state.findings[Object.keys(state.findings).find((k) => state.findings[k].ruleId === "rule-89")].judgment, { choice: "bad" });
  assert.equal(state.findings[Object.keys(state.findings).find((k) => state.findings[k].ruleId === "rule-89")].policyHash, "hash-89");
});

test("completed review history survives new episodes and records correction and clear outcomes", async () => {
  const ctx = await make(); let findings = [finding("f", "quoted cat-picture text")];
  const reviewer = { review: async () => ({ findings }) };
  await handleEvent(event("user_prompt", { source: "host_user", userText: "first" }), ctx);
  const correction = await handleEvent(event("response_end", { response: "bad" }), { ...ctx, reviewer });
  assert.equal(correction.action, "continue_turn");
  await handleEvent(event("user_prompt", { source: "host_user", userText: "second" }), ctx);
  findings = [{ id: "clear", ruleId: "rule", status: "clear", evidence: "checked" }];
  await handleEvent(event("response_end", { response: "good" }), { ...ctx, reviewer });
  const file = join(ctx.stateDir, (await readdir(ctx.stateDir)).find((x) => x.endsWith(".json")));
  const state = JSON.parse(await readFile(file, "utf8"));
  assert.equal(state.episodeId, 2);
  assert.equal(state.history.length, 2);
  assert.equal(state.history[0].episodeId, 1);
  assert.equal(state.history[0].outcome.action, "continue_turn");
  assert.match(state.history[0].outcome.correction, /Correct it|correct it/);
  assert.equal(state.history[0].findings[0].status, "finding");
  assert.equal(state.history[1].episodeId, 2);
  assert.equal(state.history[1].outcome.action, "none");
});

test("unknown finding diagnostic is named in the notice and audit record", async () => {
  const ctx = await make(); const reviewer = reviewerWith([{ id: "u", ruleId: "specific.rule", status: "unknown",
    diagnostic: { code: "missing_evidence", message: "A completed tool receipt is required.", missingEvidence: ["receipts"] } }]);
  await handleEvent(event("user_prompt", { source: "host_user", userText: "task" }), ctx);
  const result = await handleEvent(event("response_end"), { ...ctx, reviewer });
  assert.match(result.notice, /specific\.rule/);
  assert.match(result.notice, /completed tool receipt/);
  const file = join(ctx.stateDir, (await readdir(ctx.stateDir)).find((x) => x.endsWith(".json")));
  const state = JSON.parse(await readFile(file, "utf8"));
  assert.equal(state.history[0].findings[0].diagnostic.code, "missing_evidence");
});

test("legacy findings migrate before episode reset and review history remains bounded", async () => {
  const ctx = await make(); let index = 0;
  const reviewer = { review: async () => ({ findings: [{ id: `clear-${index}`, ruleId: "rule", status: "clear",
    evidence: `review-${index++}`, judgment: { choice: "clear" } }] }) };
  await handleEvent(event("user_prompt", { source: "host_user", userText: "legacy episode" }), ctx);
  await handleEvent(event("response_end"), { ...ctx, reviewer });
  const file = join(ctx.stateDir, (await readdir(ctx.stateDir)).find((x) => x.endsWith(".json")));
  let state = JSON.parse(await readFile(file, "utf8"));
  state.history = []; await (await import("node:fs/promises")).writeFile(file, JSON.stringify(state));
  await handleEvent(event("user_prompt", { source: "host_user", userText: "next episode" }), ctx);
  state = JSON.parse(await readFile(file, "utf8"));
  assert.equal(state.history[0].episodeId, 1);
  assert.equal(state.history[0].outcome.legacy, true);
  for (let i = 0; i < 45; i++) await handleEvent(event("response_end"), { ...ctx, reviewer });
  state = JSON.parse(await readFile(file, "utf8"));
  assert.equal(state.history.length, 40);
  assert.ok(Buffer.byteLength(JSON.stringify(state.history)) <= 1024 * 1024);
});
