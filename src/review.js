import { createHash } from "node:crypto";
import { createJevClient } from "./jev.js";
import { chunkPayload } from "./review-chunks.js";

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
  if (target === "request") return [{ id: "request", text: String(snapshot.request ?? ""), context: "" }].filter((x) => x.text.trim());
  if (target === "tool_call") {
    const tool = snapshot.currentTool;
    return tool ? [{ id: tool.id ?? "tool-call", text: [tool.tool ?? tool.name, tool.input].filter(Boolean).join("\n"), context: "" }] : [];
  }
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

function missingEvidence(snapshot, requires = []) {
  return requires.filter((key) => !requiredPresent(snapshot, [key]));
}

function coverageAffects(snapshot, policy) {
  const sources = snapshot.coverage?.truncatedSources ?? [];
  if (!sources.length) return snapshot.coverage?.complete === false;
  const required = new Set(policy.requires ?? []);
  if (policy.target.startsWith("response")) required.add("response");
  if (policy.target === "request") required.add("request");
  if (policy.target === "tool_call") required.add("receipts");
  if (policy.target.startsWith("thinking")) required.add("thinking");
  if (policy.target === "code_change") required.add("changes");
  return sources.some((source) => source === "unknown" || source === "request" && required.has("request") || source === "response" && required.has("response") || source.startsWith("receipt:") && (required.has("receipts") || required.has("tool_calls")) || source.startsWith("change:") && ["changes", "code", "diff"].some((x) => required.has(x)) || source.startsWith("thinking:") && required.has("thinking"));
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

function uncertainDiagnostic(answer, policy) {
  const q = policy.detector?.question ?? {};
  const d = policy.detector?.decision ?? {};
  if (q.type === "choice") {
    if ((d.unknown_options ?? []).includes(answer?.choice)) return { code: "unknown_choice", message: `The classifier selected the policy's inconclusive option (${answer.choice}).`, decision: d };
    return { code: "below_threshold", message: "The winning classification did not meet the policy's confidence threshold.", decision: d };
  }
  if (q.type === "noul") return { code: "between_thresholds", message: "The score fell between the policy's clear and violation thresholds.", decision: d };
  if (q.type === "score") return { code: "below_threshold", message: "Neither the clear nor violation score mass met the policy's confidence threshold.", decision: d };
  return { code: "inconclusive", message: "The classification did not support a clear or violation finding.", decision: d };
}

function sourceEvidence(snapshot, policy, candidate) {
  const out = [{ id: candidate.id, text: redact(candidate.text) }];
  if (policy.requires?.includes("request") && snapshot.request && candidate.id !== "request") out.push({ id: "request", text: redact(snapshot.request) });
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

export function createReviewer({ client = createJevClient(), model = "jev-1.13.0", deadlineMs = 2000, maxReviewRequests = 4 } = {}) {
  return {
    async review(snapshot, policies, { signal } = {}) {
      const started = Date.now();
      const findings = [];
      const tasks = [];
      for (const policy of policies ?? []) {
        if (policy.events?.length && !policy.events.includes(snapshot.eventKind)) continue;
        const candidates = spans(snapshot, policy.target);
        if (missingEvidence(snapshot, policy.requires).length || candidates.length === 0) {
          const missing = missingEvidence(snapshot, policy.requires);
          const diagnostic = missing.length
            ? { code: "missing_evidence", message: `Required evidence is missing or incomplete: ${missing.join(", ")}.`, missingEvidence: missing }
            : { code: "no_candidate", message: `No non-empty text was available for target ${policy.target}.` };
          findings.push({ id: hash(`${policy.id}|unknown`).slice(0, 20), ruleId: policy.id, status: "unknown", diagnostic, evidence: [], judgment: null, policyHash: policy.hash, correction: policy.correction, description: policy.description, priority: policy.priority, mode: policy.mode });
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
      let answers = {}, usage, actualModel, requestUnavailable = false, transportDiagnostic;
      const omittedTaskIndexes = new Set();
      const chunkJudgments = new Map();
      const expectedChunks = new Map();
      const taskFailures = new Map();
      if (tasks.length) {
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason);
        if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
        let timer, deadlineExpired = false;
        try {
          const timeout = new Promise((_, reject) => { timer = setTimeout(() => { deadlineExpired = true; controller.abort(); reject(new Error("review deadline exceeded")); }, deadlineMs); });
          const buildPayload = (selected) => {
            const required = new Set(selected.flatMap(({ policy }) => policy.requires ?? []));
            const state = {
              ...(required.has("request") ? { request: redact(snapshot.request) } : {}),
              ...(required.has("response") || selected.some(({ policy }) => policy.target.startsWith("response")) ? { response: redact(snapshot.response) } : {}),
              ...(required.has("receipts") || required.has("tool_calls") ? { receipts: (snapshot.receipts ?? []).map((r) => ({ id: r.id, tool: r.tool ?? r.name, input: redactAny(r.input), result: redactAny(r.result), status: r.status })) } : {}),
              ...(["changes", "code", "diff"].some((k) => required.has(k)) ? { changes: (snapshot.changes ?? []).map((c) => ({ path: redact(c.path), text: redact(c.text), context: redact(c.context) })) } : {}),
              ...(required.has("thinking") ? { thinking: (snapshot.thinking ?? []).filter((t) => t.completeness === "complete_segment").map((t) => ({ id: t.id, text: redact(t.text), kind: t.kind, completeness: t.completeness })) } : {}),
              ...(required.has("constraints") ? { constraints: redactAny(snapshot.constraints) } : {}),
              ...(Object.keys(snapshot.coverage ?? {}).length ? { coverage: redactAny(snapshot.coverage) } : {}),
              candidates: selected.map(({ policy, candidate }) => ({ id: candidate.id, text: redact(candidate.text), context: redact(candidate.context), rule: policy.id })),
            };
            const questions = Object.fromEntries(selected.map(({ policy }, i) => {
              const question = policy.detector.question;
              const reference = `state.candidates[${i}]`;
              const instructions = typeof question.instructions === "string"
                ? question.instructions.replaceAll("state.candidates[index]", reference).includes(reference)
                  ? question.instructions.replaceAll("state.candidates[index]", reference)
                  : `${question.instructions}\nFor this question, evaluate only ${reference}.`
                : { ...question.instructions, candidate_index_to_evaluate: i };
              return [`q${i}`, { ...question, instructions }];
            }));
            return { state, questions };
          };
          const selected = [];
          const oversized = [];
          for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
            const trial = [...selected, tasks[taskIndex]];
            const { state, questions } = buildPayload(trial);
            if (JSON.stringify({ state, questions, model }).length <= MAX_REVIEW_CHARS) selected.push(tasks[taskIndex]);
            else oversized.push(taskIndex);
          }
          const requests = [];
          if (selected.length) requests.push({ tasks: selected, ...buildPayload(selected), chunkInfo: null });
          for (const taskIndex of oversized) {
            if (requests.length >= maxReviewRequests) { omittedTaskIndexes.add(taskIndex); continue; }
            const built = buildPayload([tasks[taskIndex]]);
            const remaining = maxReviewRequests - requests.length;
            const pieces = chunkPayload({ state: built.state, questions: built.questions, model }, { maxChars: MAX_REVIEW_CHARS - 512, maxChunks: remaining });
            if (!pieces.length) { omittedTaskIndexes.add(taskIndex); continue; }
            expectedChunks.set(taskIndex, pieces.length);
            pieces.forEach((piece) => requests.push({ tasks: [tasks[taskIndex]], ...piece.payload, chunkInfo: piece.coverage }));
          }
          let nextRequest = 0;
          const worker = async () => {
            while (nextRequest < requests.length && !controller.signal.aborted) {
              const request = requests[nextRequest++];
              try {
                const response = await Promise.race([client.evaluate({ state: request.state, questions: request.questions, model, signal: controller.signal }), timeout]);
                const reqUsage = response?.usage ?? {};
                usage ??= {};
                for (const [key, value] of Object.entries(reqUsage)) if (typeof value === "number") usage[key] = (usage[key] ?? 0) + value;
                actualModel = response?.model ?? actualModel;
                for (let i = 0; i < request.tasks.length; i++) {
                  const task = request.tasks[i];
                  const taskIndex = tasks.indexOf(task);
                  const answer = response?.answers?.[`q${i}`];
                  if (request.chunkInfo) {
                    const existing = chunkJudgments.get(taskIndex) ?? [];
                    existing.push({ answer, coverage: request.chunkInfo });
                    chunkJudgments.set(taskIndex, existing);
                  } else answers[`q${taskIndex}`] = answer;
                }
              } catch (error) {
                if (deadlineExpired || controller.signal.aborted) throw error;
                for (const task of request.tasks) taskFailures.set(tasks.indexOf(task), { code: "transport_failure", message: "The classifier request could not be completed." });
              }
            }
          };
          await Promise.allSettled([worker(), worker()]);
          if (deadlineExpired) {
            requestUnavailable = true;
            transportDiagnostic = { code: "deadline_exceeded", message: "The classifier did not respond before the review deadline." };
          }
        } catch (error) { requestUnavailable = true; transportDiagnostic = error?.message === "review deadline exceeded"
          ? { code: "deadline_exceeded", message: "The classifier did not respond before the review deadline." }
          : { code: "transport_failure", message: "The classifier request could not be completed." }; }
        finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
      }
      for (const [taskIndex, chunks] of chunkJudgments) {
        const statuses = chunks.map(({ answer }) => classify(answer, tasks[taskIndex].policy));
        const complete = chunks.length === expectedChunks.get(taskIndex) && chunks.every(({ answer }) => answer);
        const status = complete && statuses.every((s) => s === "clear") ? "clear"
          : complete && statuses.every((s) => s === "violation") ? "violation" : "unknown";
        answers[`q${taskIndex}`] = { type: "chunk_aggregate", status, complete, chunks: chunks.map(({ answer, coverage }) => ({ answer, coverage })) };
      }
      tasks.forEach(({ policy, candidate }, i) => {
        const key = `q${i}`;
        const answer = answers[key];
        const overBudget = (omittedTaskIndexes.has(i) && !chunkJudgments.has(i)) || answer?.type === "budget_exceeded";
        const incompleteSnapshot = coverageAffects(snapshot, policy);
        const status = overBudget ? "unknown" : incompleteSnapshot ? "unknown" : answer?.type === "chunk_aggregate" ? answer.status : requestUnavailable && !answer ? "unavailable" : !answer ? "unavailable" : classify(answer, policy);
        const evidence = sourceEvidence(snapshot, policy, candidate);
        const shownEvidence = overBudget ? evidence.map(({ id }) => ({ id, text: "[omitted: review evidence exceeded the character budget]" })) : evidence;
        const diagnostic = overBudget ? { code: "input_budget_exceeded", message: `This policy's evidence exceeded the ${MAX_REVIEW_CHARS}-character request limit; it was omitted from the classifier call.` }
          : incompleteSnapshot ? { code: "partial_review", message: "The snapshot reports truncated source evidence; the review cannot support a complete finding.", truncatedSources: snapshot.coverage.truncatedSources ?? [] }
          : answer?.type === "chunk_aggregate" && !answer.complete ? { code: "partial_review", message: "Not all evidence chunks received a complete judgment." }
          : answer?.type === "chunk_aggregate" && status === "unknown" ? { code: "chunk_conflict", message: "Evidence chunks produced mixed or inconclusive judgments." }
          : taskFailures.has(i) ? taskFailures.get(i)
          : requestUnavailable && !answer ? transportDiagnostic
          : !answer ? { code: "missing_answer", message: "The classifier returned no answer for this policy." }
          : status === "unavailable" ? { code: "malformed_answer", message: "The classifier answer did not match the policy's declared question format." }
          : status === "unknown" ? answer?.type === "chunk_aggregate" ? { code: "chunk_conflict", message: "Evidence chunks produced mixed or inconclusive judgments." } : uncertainDiagnostic(answer, policy)
          : { code: status, message: status === "clear" ? "The classification met the policy's clear threshold." : "The classification met the policy's violation threshold.", decision: policy.detector.decision };
        findings.push({ id: hash(`${policy.id}|${policy.hash ?? ""}|${JSON.stringify(evidence)}`).slice(0, 20), ruleId: policy.id, status, diagnostic, evidence: shownEvidence, judgment: overBudget ? { reason: "evidence_budget_exceeded", truncated: true, limitChars: MAX_REVIEW_CHARS } : answer ?? null, policyHash: policy.hash, correction: policy.correction, description: policy.description, priority: policy.priority, mode: policy.mode });
      });
      return { findings, usage, model: actualModel ?? model, elapsedMs: Date.now() - started };
    },
  };
}
