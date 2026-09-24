import assert from "node:assert/strict";
import test from "node:test";
import { createJevClient } from "../src/jev.js";

test("Jev client sends one authenticated typed evaluation and returns answer map", async () => {
  let request;
  const client = createJevClient({ apiKey: "secret-key", fetchImpl: async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { q1: { type: "choice", choice: "clear", probabilities: { clear: 0.96 }, confidence: 0.96 } }, usage: { input_tokens: 10, output_tokens: 7 } }), { status: 200 });
  } });
  const out = await client.evaluate({ state: { candidate: "text" }, questions: { q1: { type: "choice", instructions: "Classify the candidate.", criteria: { clear: "No issue", violation: "Issue" } } } });
  assert.equal(request.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(request.init.headers.authorization, "Bearer secret-key");
  assert.equal(request.init.headers["content-type"], "application/json");
  const sent = JSON.parse(request.init.body);
  assert.deepEqual(sent.questions, { q1: { type: "choice", instructions: "Classify the candidate.", criteria: { clear: "No issue", violation: "Issue" } } });
  assert.equal(sent.state.candidate, "text");
  assert.equal(out.answers.q1.choice, "clear");
  assert.equal(out.model, "jev-1.13.0");
});

test("Jev client uses abort signal and rejects non-success responses", async () => {
  let seenSignal;
  const client = createJevClient({ apiKey: "k", fetchImpl: async (_url, init) => { seenSignal = init.signal; return new Response("unauthorized", { status: 401 }); } });
  const controller = new AbortController();
  await assert.rejects(client.evaluate({ state: {}, questions: [], signal: controller.signal }), /401/);
  assert.equal(seenSignal, controller.signal);
});
