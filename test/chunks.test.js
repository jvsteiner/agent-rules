import assert from "node:assert/strict";
import test from "node:test";
import { createReviewer } from "../src/review.js";

const p = (id, target = "response", requires = ["response"]) => ({ id, description: id, events: ["response_end"], target, requires, detector: { type: "jev", question: { type: "choice", instructions: "Classify candidate.text using the evidence.", criteria: { supported: "Supported", contradicted: "Contradicted" } }, decision: { violation: { option: "contradicted", min_probability: .9 }, min_winner_probability: .9 } } });
const answer = (choice = "supported") => ({ type: "choice", choice, probabilities: { supported: choice === "supported" ? .99 : .01, contradicted: choice === "contradicted" ? .99 : .01 } });
const snap = (response, receipts = []) => ({ eventKind: "response_end", request: "Check the result.", response, receipts, changes: [], thinking: [], coverage: {} });

test("oversized response is chunked with offsets and all clear chunks can aggregate", async () => {
  const calls = [];
  const reviewer = createReviewer({ client: { evaluate: async (arg) => { calls.push(arg); return { answers: { q0: answer() }, usage: { input_tokens: 3 } }; } } });
  const finding = (await reviewer.review(snap("start " + "x".repeat(27000) + " tail-marker"), [p("large")])).findings[0];
  assert.ok(calls.length > 1);
  assert.ok(calls.every((c) => JSON.stringify({ state: c.state, questions: c.questions, model: c.model }).length <= 24000));
  assert.ok(calls.some((c) => c.state.candidates[0].text.includes("tail-marker")));
  assert.equal(finding.status, "clear");
  assert.ok(finding.judgment.chunks.length > 1);
  assert.ok(finding.judgment.chunks.every((c) => c.coverage.sources.every((s) => s.start <= s.end && s.end <= s.total)));
});

test("mixed chunk judgments abstain and retain raw judgments", async () => {
  let n = 0;
  const reviewer = createReviewer({ client: { evaluate: async () => ({ answers: { q0: answer(n++ ? "contradicted" : "supported") } }) } });
  const finding = (await reviewer.review(snap("y".repeat(27000)), [p("mixed")])).findings[0];
  assert.equal(finding.status, "unknown");
  assert.equal(finding.diagnostic.code, "chunk_conflict");
  assert.ok(finding.judgment.chunks.length > 1);
});

test("a later chunk failure retains completed chunk judgments and abstains", async () => {
  let n = 0;
  const reviewer = createReviewer({ client: { evaluate: async () => {
    if (n++ > 0) throw new Error("offline");
    return { answers: { q0: answer() } };
  } } });
  const finding = (await reviewer.review(snap("x".repeat(27000)), [p("failed-later")])).findings[0];
  assert.equal(finding.status, "unknown");
  assert.equal(finding.diagnostic.code, "partial_review");
  assert.equal(finding.judgment.chunks.length, 1);
});

test("request cap preserves a small review and marks overflow unknown", async () => {
  let calls = 0;
  const reviewer = createReviewer({ maxReviewRequests: 1, client: { evaluate: async () => {
    calls++;
    return { answers: { q0: answer() } };
  } } });
  const snapshot = snap("short and clear");
  snapshot.changes = [{ path: "file.js", text: "z".repeat(27000), context: "" }];
  const findings = (await reviewer.review(snapshot, [p("small"), p("large", "code_change", ["changes"])])).findings;
  assert.equal(calls, 1);
  assert.equal(findings.find((f) => f.ruleId === "small").status, "clear");
  assert.equal(findings.find((f) => f.ruleId === "large").status, "unknown");
});

test("chunk requests share one deadline and do not launch after it expires", async () => {
  let calls = 0;
  const reviewer = createReviewer({ deadlineMs: 15, client: { evaluate: async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { answers: { q0: answer() } };
  } } });
  const started = Date.now();
  const finding = (await reviewer.review(snap("x".repeat(35000)), [p("deadline")])).findings[0];
  assert.ok(Date.now() - started < 100);
  assert.ok(calls <= 2);
  assert.equal(finding.status, "unavailable");
  assert.equal(finding.diagnostic.code, "deadline_exceeded");
});

test("multiple large receipt results remain bounded and keep short candidate context", async () => {
  const calls = [];
  const receipts = Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, tool: "shell", input: "short input", result: "z".repeat(3000), status: "complete" }));
  const reviewer = createReviewer({ client: { evaluate: async (arg) => { calls.push(arg); return { answers: { q0: answer() } }; } } });
  const finding = (await reviewer.review(snap("brief conclusion", receipts), [p("receipts", "response", ["response", "receipts"])])).findings[0];
  assert.equal(finding.status, "clear");
  assert.ok(calls.length <= 4);
  assert.ok(calls.every((c) => JSON.stringify({ state: c.state, questions: c.questions, model: c.model }).length <= 24000));
  assert.ok(calls.every((c) => c.state.candidates[0].text === "brief conclusion"));
});
