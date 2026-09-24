/** Small, injectable Jev HTTP transport. endpoint is the full System One URL; exactly one request is made. */
export function createJevClient({ apiKey = process.env.TYPESAFE_API_KEY, model = "jev-1.13.0", endpoint = "https://api.typesafe.ai/v1/systemone", fetchImpl = globalThis.fetch } = {}) {
  return {
    async evaluate({ state, questions, model: requestedModel, signal } = {}) {
      if (!apiKey) throw new Error("TYPESAFE_API_KEY is not configured");
      if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ model: requestedModel ?? model, state, questions: Object.fromEntries(Object.entries(questions ?? {}).map(([id, question]) => [id, { type: question.type, instructions: question.instructions, ...(question.criteria ? { criteria: question.criteria } : {}) }])) }),
        signal,
      });
      if (!response.ok) throw new Error(`Jev request failed with HTTP ${response.status}`);
      let data;
      try { data = await response.json(); } catch { throw new Error("Jev returned malformed JSON"); }
      if (!data || typeof data !== "object" || !data.answers || typeof data.answers !== "object") throw new Error("Jev response is missing answers");
      return { model: data.model, answers: data.answers, usage: data.usage };
    },
  };
}
