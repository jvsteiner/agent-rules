import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createReviewer } from "../src/review.js";
import { parsePolicy } from "../src/catalog.js";

const policy = (id, extra = {}) => ({ id, description: id, events: ["response_end"], target: "response_span", requires: ["request", "response", "receipts"], priority: 50, detector: { type: "jev", question: { type: "choice", instructions: "Classify candidate.text against receipts.", criteria: { supported: "Supported", contradicted: "Contradicted", unknown: "Insufficient evidence" } }, decision: { violation: { option: "contradicted", min_probability: 0.9 }, unknown_options: ["unknown"], min_winner_probability: 0.7 } }, correction: "Correct the claim.", hash: `hash-${id}`, mode: "repair", ...extra });
const snapshot = (response = "All tests passed.") => ({ eventKind: "response_end", request: "Run tests.", response, receipts: [{ id: "test-1", tool: "shell", input: "npm test", result: "failed", status: "complete" }], changes: [], thinking: [], coverage: {} });

test("review batches eligible candidates, keeps source spans, and validates an actionable violation", async () => {
  let sent;
  const reviewer = createReviewer({ client: { evaluate: async (arg) => { sent = arg; return { answers: { "q0": { type: "choice", choice: "contradicted", probabilities: { contradicted: 0.94, supported: 0.04, unknown: 0.02 } } }, usage: { input_tokens: 7, output_tokens: 2 } }; } } });
  const result = await reviewer.review(snapshot(), [policy("test-result-contradiction")]);
  assert.equal(Object.keys(sent.questions).length, 1);
  assert.match(sent.questions.q0.instructions, /candidate\.text/);
  assert.equal(result.findings[0].status, "violation");
  assert.deepEqual(result.findings[0].evidence.map((e) => e.id), ["response-0", "request", "test-1"]);
  assert.equal(result.findings[0].policyHash, "hash-test-result-contradiction");
});

test("missing required evidence and partial thinking never trigger a Jev violation", async () => {
  let calls = 0;
  const reviewer = createReviewer({ maxReviewRequests: 1, client: { evaluate: async () => { calls++; return { answers: {} }; } } });
  const noReceipt = snapshot(); noReceipt.receipts = [];
  const missing = await reviewer.review(noReceipt, [policy("a")]);
  assert.equal(calls, 0);
  assert.equal(missing.findings[0].status, "unknown");
  const partialPolicy = policy("thinking", { target: "thinking", requires: ["thinking"] });
  const partial = snapshot(); partial.thinking = [{ id: "t1", text: "I could omit this", kind: "exposed", completeness: "partial" }];
  const ignored = await reviewer.review(partial, [partialPolicy]);
  assert.equal(calls, 0);
  assert.equal(ignored.findings[0].status, "unknown");
});

test("unknown, low confidence, malformed, missing answers and deadline failures stay conservative", async () => {
  const responses = [
    { answers: { q0: { type: "choice", choice: "unknown", probabilities: { contradicted: 0.005, supported: 0.005, unknown: 0.99 } } } },
    { answers: { q0: { type: "choice", choice: "contradicted", probabilities: { contradicted: 0.65, supported: 0.3, unknown: 0.05 } } } },
    { answers: { q0: { type: "choice", choice: "contradicted", probabilities: { contradicted: 4, supported: -3, unknown: 0 } } } },
    { answers: {} },
  ];
  const reviewer = createReviewer({ client: { evaluate: async () => responses.shift() }, deadlineMs: 20 });
  const checked = [];
  for (let i = 0; i < 4; i++) checked.push((await reviewer.review(snapshot(), [policy("a")] )).findings[0]);
  const statuses = checked.map((finding) => finding.status);
  assert.deepEqual(statuses, ["unknown", "unknown", "unavailable", "unavailable"]);
  assert.equal(checked[0].diagnostic.code, "unknown_choice");
  assert.equal(checked[1].diagnostic.code, "below_threshold");
  assert.equal(checked[2].diagnostic.code, "malformed_answer");
  assert.equal(checked[3].diagnostic.code, "missing_answer");
  const slow = createReviewer({ client: { evaluate: (_arg) => new Promise((resolve) => setTimeout(() => resolve({ answers: {} }), 50)) }, deadlineMs: 5 });
  const timedOut = (await slow.review(snapshot(), [policy("a")] )).findings[0];
  assert.equal(timedOut.status, "unavailable");
  assert.equal(timedOut.diagnostic.code, "deadline_exceeded");
});

test("noul and score answers use their declared probability thresholds", async () => {
  const base = { id: "threshold", description: "threshold", events: ["response_end"], target: "response", requires: ["request", "response"], priority: 10, hash: "h", mode: "observe" };
  const noulPolicy = { ...base, detector: { type: "jev", question: { type: "noul", instructions: "Is the statement present?", criteria: { true: "Present", false: "Absent" } }, decision: { violation_at_or_above: 0.9, clear_at_or_below: 0.1 } } };
  const scorePolicy = { ...base, detector: { type: "jev", question: { type: "score", instructions: "Rate severity.", criteria: ["none", "minor", "severe"] }, decision: { violation_levels: ["2"], clear_levels: ["0"], min_probability: 0.9 } } };
  const answers = [{ answers: { q0: { type: "noul", noul: 0.91 } } }, { answers: { q0: { type: "score", score: 1.9, legend: { "0": "none", "1": "minor", "2": "severe" }, probabilities: { "0": 0.01, "1": 0.02, "2": 0.97 }, confidence: 0.95 } } }];
  for (const p of [noulPolicy, scorePolicy]) {
    const reviewer = createReviewer({ client: { evaluate: async () => answers.shift() } });
    assert.equal((await reviewer.review(snapshot(), [p])).findings[0].status, "violation");
  }
});

test("regex policies are evaluated locally and response target keeps one whole-answer candidate", async () => {
  let calls = 0;
  const reviewer = createReviewer({ client: { evaluate: async () => { calls++; return { answers: {} }; } } });
  const regex = { id: "regex", description: "regex", events: ["response_end"], target: "response", requires: ["response"], priority: 1, detector: { type: "regex", pattern: "must not", flags: "i" }, hash: "r", mode: "observe" };
  const result = await reviewer.review(snapshot("First paragraph.\n\nIt must not happen."), [regex]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].evidence[0].id, "response");
  assert.equal(result.findings[0].status, "violation");
  assert.equal(calls, 0);
});

test("oversized evidence skips transport, marks the result unknown, and records truncation", async () => {
  let calls = 0;
  const reviewer = createReviewer({ maxReviewRequests: 1, client: { evaluate: async () => { calls++; return { answers: {} }; } } });
  const huge = snapshot("All tests passed.");
  huge.receipts[0].result = "x".repeat(30000);
  const finding = (await reviewer.review(huge, [policy("a")])).findings[0];
  assert.equal(calls, 0);
  assert.equal(finding.status, "unknown");
  assert.equal(finding.judgment.truncated, true);
  assert.match(finding.evidence[2].text, /omitted/);
});

test("redacts obvious credentials before the client receives evidence", async () => {
  let sent;
  const reviewer = createReviewer({ client: { evaluate: async (arg) => { sent = arg; return { answers: {} }; } } });
  const s = snapshot("token: ghp_abcdefghijklmnopqrstuvwxyz1234567890 all good");
  s.request = "Authorization: Bearer abcdefghijklmnop123456";
  await reviewer.review(s, [policy("a")]);
  const json = JSON.stringify(sent.state);
  assert.doesNotMatch(json, /ghp_abcdefghijklmnopqrstuvwxyz1234567890/);
  assert.doesNotMatch(json, /abcdefghijklmnop123456/);
  assert.match(json, /REDACTED/);
});

test("starter policies parse through PolicyCatalog and their cases use the shared case contract", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "policies");
  for (const file of ["test-result-contradiction", "unexplained-jargon", "premature-completion", "swallowed-error"]) {
    const parsed = parsePolicy(readFileSync(join(root, `${file}.md`), "utf8"), { file });
    assert.equal(typeof parsed.hash, "string");
    const cases = readFileSync(join(root, `${file}.cases.jsonl`), "utf8").trim().split("\n").map(JSON.parse);
    for (const example of cases) {
      assert.equal(example.labelSource, "generated");
      assert.ok(["development", "holdout"].includes(example.split));
      assert.ok(["violation", "clear", "unknown"].includes(example.expected));
      assert.ok(example.snapshot);
    }
  }
});

test("unknown and unavailable findings include useful sanitized diagnostics and decision thresholds", async () => {
  const reviewer = createReviewer({ client: { evaluate: async () => { throw new Error("token: TOPSECRET upstream"); } } });
  const failed = (await reviewer.review(snapshot(), [policy("a")])).findings[0];
  assert.equal(failed.diagnostic.code, "transport_failure");
  assert.match(failed.diagnostic.message, /could not be completed/);
  assert.doesNotMatch(JSON.stringify(failed), /TOPSECRET/);

  const absent = snapshot(); absent.receipts = [];
  const missing = (await createReviewer().review(absent, [policy("needs-receipts")])).findings[0];
  assert.equal(missing.diagnostic.code, "missing_evidence");
  assert.deepEqual(missing.diagnostic.missingEvidence, ["receipts"]);

  const uncertainReviewer = createReviewer({ client: { evaluate: async () => ({ answers: { q0: { type: "choice", choice: "contradicted", probabilities: { contradicted: .65, supported: .3, unknown: .05 } } } }) } });
  const uncertain = (await uncertainReviewer.review(snapshot(), [policy("a")])).findings[0];
  assert.equal(uncertain.diagnostic.code, "below_threshold");
  assert.deepEqual(uncertain.diagnostic.decision, policy("a").detector.decision);
});

test("oversized candidates are omitted individually while a small candidate is still reviewed", async () => {
  let sent;
  const reviewer = createReviewer({ maxReviewRequests: 1, client: { evaluate: async (arg) => {
    sent = arg;
    return { answers: { q0: { type: "choice", choice: "supported", probabilities: { contradicted: .01, supported: .99 } } } };
  } } });
  const small = { ...policy("small"), target: "response", requires: ["response"], detector: { type: "jev", question: { type: "choice", instructions: "Classify state.candidates[index]", criteria: { supported: "Supported", contradicted: "Contradicted" } }, decision: { violation: { option: "contradicted", min_probability: .9 }, min_winner_probability: .9 } } };
  const huge = { ...policy("huge"), target: "response", requires: ["response", "receipts"] };
  const s = snapshot("small answer"); s.receipts[0].result = "x".repeat(26000);
  for (const policies of [[small, huge], [huge, small]]) {
    const result = await reviewer.review(s, policies);
    assert.equal(Object.keys(sent.questions).length, 1);
    assert.equal(result.findings.find((x) => x.ruleId === "small").status, "clear");
    assert.equal(result.findings.find((x) => x.ruleId === "huge").diagnostic.code, "input_budget_exceeded");
  }
});
