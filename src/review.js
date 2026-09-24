import { createHash } from "node:crypto";
import { createJevClient } from "./jev.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const MAX_REVIEW_CHARS = 24000;
const redact = (value) => String(value ?? "")
  .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
  .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
  .replace(/(\b(?:api[_-]?key|token|password|secret)\b\s*[:=]\s*)([^\s,;]+)/ig, "$1[REDACTED]")
  .replace(/(\bauthorization\s*:\s*bearer\s+)[^\s]+/ig, "$1[REDACTED]")
  .replace(/(\bbearer\s+)[A-Za-z0-9._~+/-]{16,}/ig, "$1[REDACTED]");

const redactAny = (value) => {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactAny);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactAny(child)]));
  return value;
};

function spans(snapshot, target) {
  if (target === "response") return [{ id: "response", text: String(snapshot.response ?? ""), context: "" }].filter((x) => x.text.trim());
  if (target === "response_span") {
    const lines = String(snapshot.response ?? "").split(/\n\s*\n/).map((text) => text.trim()).filter(Boolean);
    return lines.map((text, i) => ({ id: `response-${i}`, text, context: "" }));
  }
  if (target === "thinking" || target === "thinking_span") return (snapshot.thinking ?? []).filter((x) => x.completeness === "complete_segment").map((x) => ({ id: x.id, text: x.text, context: x.kind }));
  if (target === "code_change") return (snapshot.changes ?? []).map((x, i) => ({ id: x.id ?? `change-${i}`, text: `${x.path}\n${x.text}`, context: x.context ?? "" }));
  return [{ id: "response", text: String(snapshot.response ?? ""), context: "" }];
}

function requiredPresent(snapshot, requires = []) {
  return requires.every((key) => {
    if (key === "request") return Boolean(snapshot.request);
    if (key === "response") return Boolean(snapshot.response);
    if (key === "receipts" || key === "tool_calls") return (snapshot.receipts ?? []).length > 0 && !(snapshot.receipts ?? []).some((r) => r.status === "pending");
    if (key === "thinking") return (snapshot.thinking ?? []).some((t) => t.completeness === "complete_segment");
    if (["changes", "code", "diff"].includes(key)) return (snapshot.changes ?? []).length > 0;
    if (key === "constraints") return snapshot.constraints !== undefined && snapshot.constraints !== null;
    return snapshot[key] !== undefined && snapshot[key] !== null;
  });
}

function classify(answer, policy) {
  const q = policy.detector?.question ?? {};
  const d = policy.detector?.decision ?? {};
  if (!answer || answer.type !== q.type) return "unavailable";
  if (q.type === "choice") {
    const probs = answer.probabilities;
    if (!probs || typeof probs !== "object" || Object.values(probs).some((n) => typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1)) return "unavailable";
    const total = Object.values(probs).reduce((a, b) => a + b, 0);
    if (Math.abs(total - 1) > 0.02) return "unavailable";
    const options = Object.keys(q.criteria ?? {});
    if (options.length !== Object.keys(probs).length || options.some((option) => !(option in probs))) return "unavailable";
    const winner = answer.choice;
    if (!(winner in probs) || probs[winner] !== Math.max(...Object.values(probs))) return "unavailable";
    if (d.violation?.option === winner) return probs[winner] >= (d.violation.min_probability ?? 1) ? "violation" : "unknown";
    if ((d.unknown_options ?? []).includes(winner)) return "unknown";
    const max = Math.max(...Object.values(probs));
    return max >= (d.min_winner_probability ?? 1) ? "clear" : "unknown";
  }
  if (q.type === "noul") {
    const value = answer.noul;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return "unavailable";
    if (value >= d.violation_at_or_above) return "violation";
    if (value <= d.clear_at_or_below) return "clear";
    return "unknown";
  }
  if (q.type === "score") {
    const probabilities = answer.probabilities;
    if (!probabilities || typeof probabilities !== "object") return "unavailable";
    const levels = (q.criteria ?? []).map((_, i) => String(i));
    if (levels.length !== Object.keys(probabilities).length || levels.some((level) => !(level in probabilities))) return "unavailable";
    const total = Object.values(probabilities).reduce((sum, p) => sum + (typeof p === "number" ? p : NaN), 0);
    if (!Number.isFinite(total) || Math.abs(total - 1) > 0.02 || Object.values(probabilities).some((p) => p < 0 || p > 1)) return "unavailable";
    const massFor = (levels) => {
      let mass = 0;
      for (const level of levels ?? []) {
        const probability = probabilities[String(level)];
        if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) return null;
        mass += probability;
      }
      return mass;
    };
    const violationMass = massFor(d.violation_levels);
    const clearMass = massFor(d.clear_levels);
    if (violationMass === null || clearMass === null) return "unavailable";
    if (violationMass >= (d.min_probability ?? 1)) return "violation";
    if (clearMass >= (d.min_probability ?? 1)) return "clear";
  }
  return "unknown";
}

function sourceEvidence(snapshot, policy, candidate) {
  const out = [{ id: candidate.id, text: redact(candidate.text) }];
  if (policy.requires?.includes("request") && snapshot.request) out.push({ id: "request", text: redact(snapshot.request) });
  if (policy.requires?.some((x) => ["receipts", "tool_calls"].includes(x))) {
    for (const receipt of snapshot.receipts ?? []) out.push({ id: receipt.id, text: redact([receipt.tool ?? receipt.name, receipt.input, receipt.result, receipt.status].filter(Boolean).join("\n")) });
  }
  if (policy.requires?.some((x) => ["changes", "code", "diff"].includes(x))) {
    for (const [i, change] of (snapshot.changes ?? []).entries()) out.push({ id: change.id ?? `change-${i}`, text: redact([change.path, change.text, change.context].filter(Boolean).join("\n")) });
  }
  if (policy.requires?.includes("thinking")) {
    for (const item of snapshot.thinking ?? []) if (item.completeness === "complete_segment") out.push({ id: item.id, text: redact(item.text) });
  }
  if (policy.requires?.includes("constraints")) out.push({ id: "constraints", text: JSON.stringify(redactAny(snapshot.constraints)) });
  return out;
}

export function createReviewer({ client = createJevClient(), model = "jev-1.13.0", deadlineMs = 2000 } = {}) {
  return {
    async review(snapshot, policies, { signal } = {}) {
      const started = Date.now();
      const findings = [];
      const tasks = [];
      for (const policy of policies ?? []) {
        if (policy.events?.length && !policy.events.includes(snapshot.eventKind)) continue;
        const candidates = spans(snapshot, policy.target);
        if (!requiredPresent(snapshot, policy.requires) || candidates.length === 0) {
          findings.push({ id: hash(`${policy.id}|unknown`).slice(0, 20), ruleId: policy.id, status: "unknown", evidence: [], judgment: null, policyHash: policy.hash, correction: policy.correction, description: policy.description, priority: policy.priority, mode: policy.mode });
          continue;
        }
        if (policy.detector?.type === "regex") {
          let pattern;
          try { pattern = new RegExp(policy.detector.pattern, policy.detector.flags ?? ""); } catch {
            findings.push({ id: hash(`${policy.id}|invalid-regex`).slice(0, 20), ruleId: policy.id, status: "unavailable", evidence: [], judgment: null, policyHash: policy.hash, correction: policy.correction, description: policy.description, priority: policy.priority, mode: policy.mode });
            continue;
          }
          for (const candidate of candidates) {
            const evidence = sourceEvidence(snapshot, policy, candidate);
            const status = pattern.test(candidate.text) ? "violation" : "clear";
            findings.push({ id: hash(`${policy.id}|${policy.hash ?? ""}|${JSON.stringify(evidence)}`).slice(0, 20), ruleId: policy.id, status, evidence, judgment: { matched: status === "violation" }, policyHash: policy.hash, correction: policy.correction, description: policy.description, priority: policy.priority, mode: policy.mode });
            pattern.lastIndex = 0;
          }
          continue;
        }
        if (policy.detector?.type !== "jev") {
          for (const candidate of candidates) findings.push({ id: hash(`${policy.id}|${candidate.id}`).slice(0, 20), ruleId: policy.id, status: "unknown", evidence: [{ id: candidate.id, text: redact(candidate.text) }], judgment: null, policyHash: policy.hash, correction: policy.correction, description: policy.description, priority: policy.priority, mode: policy.mode });
          continue;
        }
        for (const candidate of candidates) tasks.push({ policy, candidate });
      }
      let answers = {}, usage, actualModel, requestUnavailable = false;
      if (tasks.length) {
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason);
        if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
        let timer;
        try {
          const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("review deadline exceeded")); }, deadlineMs); });
          const required = new Set(tasks.flatMap(({ policy }) => policy.requires ?? []));
          const state = {
            ...(required.has("request") ? { request: redact(snapshot.request) } : {}),
            ...(required.has("response") || tasks.some(({ policy }) => policy.target.startsWith("response")) ? { response: redact(snapshot.response) } : {}),
            ...(required.has("receipts") || required.has("tool_calls") ? { receipts: (snapshot.receipts ?? []).map((r) => ({ id: r.id, tool: r.tool ?? r.name, input: redactAny(r.input), result: redactAny(r.result), status: r.status })) } : {}),
            ...(required.has("changes") || required.has("code") || required.has("diff") ? { changes: (snapshot.changes ?? []).map((c) => ({ path: redact(c.path), text: redact(c.text), context: redact(c.context) })) } : {}),
            ...(required.has("thinking") ? { thinking: (snapshot.thinking ?? []).filter((t) => t.completeness === "complete_segment").map((t) => ({ id: t.id, text: redact(t.text), kind: t.kind, completeness: t.completeness })) } : {}),
            ...(required.has("constraints") ? { constraints: redactAny(snapshot.constraints) } : {}),
            ...(Object.keys(snapshot.coverage ?? {}).length ? { coverage: redactAny(snapshot.coverage) } : {}),
            candidates: tasks.map(({ policy, candidate }) => ({ id: candidate.id, text: redact(candidate.text), context: redact(candidate.context), rule: policy.id })),
          };
          const questions = Object.fromEntries(tasks.map(({ policy, candidate }, i) => {
            const question = policy.detector.question;
            const reference = `state.candidates[${i}]`;
            const instructions = typeof question.instructions === "string"
              ? question.instructions.replaceAll("state.candidates[index]", reference).includes(reference)
                ? question.instructions.replaceAll("state.candidates[index]", reference)
                : `${question.instructions}\nFor this question, evaluate only ${reference}.`
              : { ...question.instructions, candidate_index_to_evaluate: i };
            return [`q${i}`, { ...question, instructions }];
          }));
          if (JSON.stringify({ state, questions, model }).length > MAX_REVIEW_CHARS) {
            requestUnavailable = false;
            answers = Object.fromEntries(tasks.map((_, i) => [`q${i}`, { type: "budget_exceeded" }]));
          } else {
          const response = await Promise.race([client.evaluate({ state, questions, model, signal: controller.signal }), timeout]);
          answers = response?.answers ?? {}; usage = response?.usage; actualModel = response?.model;
          }
        } catch { answers = {}; requestUnavailable = true; }
        finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
      }
      tasks.forEach(({ policy, candidate }, i) => {
        const key = `q${i}`;
        const answer = answers[key];
        const overBudget = answer?.type === "budget_exceeded";
        const status = requestUnavailable ? "unavailable" : overBudget ? "unknown" : classify(answer, policy);
        const evidence = sourceEvidence(snapshot, policy, candidate);
        const shownEvidence = overBudget ? evidence.map(({ id }) => ({ id, text: "[omitted: review evidence exceeded the character budget]" })) : evidence;
        findings.push({ id: hash(`${policy.id}|${policy.hash ?? ""}|${JSON.stringify(evidence)}`).slice(0, 20), ruleId: policy.id, status, evidence: shownEvidence, judgment: overBudget ? { reason: "evidence_budget_exceeded", truncated: true, limitChars: MAX_REVIEW_CHARS } : answer ?? null, policyHash: policy.hash, correction: policy.correction, description: policy.description, priority: policy.priority, mode: policy.mode });
      });
      return { findings, usage, model: actualModel ?? model, elapsedMs: Date.now() - started };
    },
  };
}
