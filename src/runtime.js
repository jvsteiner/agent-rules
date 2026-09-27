import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_TEXT = 12000;
const MAX_CAPTURE_TEXT = 96000;
const MAX_REVIEW_CAPTURE = 512000;
const MAX_ITEMS = 80;
const MAX_HISTORY = 40;
const MAX_HISTORY_BYTES = 1024 * 1024;
const scrubText = (s, limit = MAX_TEXT) => String(s ?? "")
  .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9._~-]{12,})\b/g, "[REDACTED]").slice(0, limit);
const secretScrub = (s) => scrubText(s, MAX_TEXT);
const scrubEvidence = (e, limit = MAX_CAPTURE_TEXT) => Array.isArray(e) ? e.map((x) => scrubEvidence(x, limit)) : e && typeof e === "object"
  ? Object.fromEntries(Object.entries(e).map(([k, v]) => [k, scrubEvidence(v, limit)]))
  : typeof e === "string" ? scrubText(e, limit) : e;
const captureText = (s) => {
  const scrubbed = scrubText(s, Number.MAX_SAFE_INTEGER);
  return { text: scrubbed.slice(0, MAX_CAPTURE_TEXT), truncated: scrubbed.length > MAX_CAPTURE_TEXT };
};
const shownEvidence = (e) => Array.isArray(e) ? e.map(shownEvidence).join("\n")
  : e && typeof e === "object" ? JSON.stringify(e) : e;
const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const empty = () => ({ version: 1, episodeId: 0, generation: 0, correctionsDelivered: 0,
  pendingContinuation: false, pendingContinuationText: "", originatingUserEvent: null, currentRequest: "", receipts: [], changes: [],
  thinking: [], response: "", findings: {}, history: [], sequence: 0, recoveryRequired: false });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeFinding(f) {
  return { id: f.id ?? hash([f.ruleId, f.description, f.evidence]), ruleId: f.ruleId,
    status: f.status, description: secretScrub(f.description), correction: secretScrub(f.correction),
    evidence: scrubEvidence(f.evidence), judgment: scrubEvidence(f.judgment), diagnostic: scrubEvidence(f.diagnostic, MAX_TEXT),
    decision: scrubEvidence(f.decision), policyHash: f.policyHash,
    model: f.model, mode: f.mode, priority: f.priority };
}

function appendHistory(state, { episodeId, sequence }, findings, outcome, timestamp = new Date().toISOString()) {
  if (!findings.length) return;
  state.history ??= [];
  const compact = (finding) => {
    const evidence = JSON.stringify(finding.evidence ?? null);
    const bounded = (value) => {
      const serialized = JSON.stringify(value ?? null);
      return serialized.length > 1600 ? { reason: "audit_detail_truncated", preview: `${serialized.slice(0, 1500)}…` } : value;
    };
    const boundedFindingDetail = (value) => {
      const serialized = JSON.stringify(value ?? null);
      return serialized.length > 16000 ? { reason: "audit_detail_truncated", preview: `${serialized.slice(0, 15800)}…` } : value;
    };
    return { ...finding,
      description: secretScrub(finding.description).slice(0, 1000),
      correction: secretScrub(finding.correction).slice(0, 1000),
      evidence: evidence.length > 1600 ? [{ id: "audit-truncated", text: `${evidence.slice(0, 1550)}… [evidence omitted]` }] : finding.evidence,
      judgment: boundedFindingDetail(finding.judgment), diagnostic: bounded(finding.diagnostic), decision: bounded(finding.decision),
      model: secretScrub(finding.model).slice(0, 160),
    };
  };
  const prioritized = [...findings].sort((a, b) => Number(activeFinding(b) && b.mode === "repair") - Number(activeFinding(a) && a.mode === "repair"));
  state.history.push({ episodeId, sequence, timestamp, findings: prioritized.slice(0, MAX_ITEMS).map(compact), outcome });
  state.history = state.history.slice(-MAX_HISTORY);
  while (state.history.length && Buffer.byteLength(JSON.stringify(state.history)) > MAX_HISTORY_BYTES) state.history.shift();
}

async function withLock(file, fn, timeout = 1500) {
  const lock = `${file}.lock`;
  const started = Date.now();
  while (true) {
    try { await mkdir(lock); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      try { if (Date.now() - (await stat(lock)).mtimeMs > 30000) await rm(lock, { recursive: true }); } catch {}
      if (Date.now() - started > timeout) throw new Error("state lock timeout");
      await wait(8 + Math.floor(Math.random() * 15));
    }
  }
  try { return await fn(); } finally { await rm(lock, { recursive: true, force: true }); }
}

async function load(file) {
  try {
    const state = JSON.parse(await readFile(file, "utf8"));
    if (!state || state.version !== 1 || !Number.isInteger(state.generation)) throw new Error("invalid state");
    return state;
  } catch (error) { if (error.code === "ENOENT") return empty(); throw error; }
}

async function save(file, state) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await rename(tmp, file);
}

// The agent must be able to tell a user-installed rule from text injected by a file, page, or tool.
const correctionText = (f, label) => `[Agent Rules: ${f.ruleId ?? "policy"}; ${label}]
This message comes from Agent Rules, a plugin the user installed to enforce rules they wrote. It is not part of the request, a file, or a tool result. Follow it as the user's own instruction.
The user's rule: ${f.description ?? "(no description)"}
Evidence: ${shownEvidence(f.evidence) || "(none provided)"}
Correction: ${f.correction}`;
const REVIEWED = ["user_prompt", "tool_start", "tool_result", "response_end"];
const activeFinding = (f) => ["finding", "violation", "fail", "failed", "noncompliant"].includes(String(f.status).toLowerCase());
const findingKey = (f) => hash([f.ruleId, f.id, f.evidence, activeFinding(f) ? "active" : String(f.status).toLowerCase()]);

/** Process one normalized host event. A reviewer with no applicable policies is never called. */
export async function handleEvent(event, { reviewer, policies = [], stateDir, config = {} } = {}) {
  const neutral = { action: "none" };
  if (!event || !event.platform || !event.sessionId || !stateDir || (event.actorId && event.actorId !== "main")) return neutral;
  let file;
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    file = join(stateDir, `${hash([event.platform, event.sessionId])}.json`);
  } catch { return { action: "none", notice: "Agent Rules state storage is unavailable; review is observe-only." }; }
  let captured;
  try {
    captured = await withLock(file, async () => {
      const state = await load(file);
      const missingState = state.sequence === 0 && event.kind === "response_end" && event.stopHookActive;
      const isContinuation = event.kind === "user_prompt" && state.pendingContinuation &&
        (event.source === "plugin_continuation" || (event.source === "host_user" && state.pendingContinuationText &&
          String(event.userText ?? "").includes(state.pendingContinuationText.slice(0, 80))));
      const genuine = event.kind === "user_prompt" && event.source === "host_user" && !isContinuation && !event.stopHookActive;
      if (genuine) {
        state.history ??= [];
        if (Object.keys(state.findings ?? {}).length && !state.history.some((entry) => entry.episodeId === state.episodeId)) {
          appendHistory(state, { episodeId: state.episodeId, sequence: state.sequence }, Object.values(state.findings),
            { action: "unknown", legacy: true });
        }
        state.episodeId++; state.generation++; state.correctionsDelivered = 0;
        state.sessionId = event.sessionId;
        state.originatingUserEvent = event.eventId ?? `local-${state.sequence + 1}`;
        const request = captureText(event.userText);
        state.currentRequest = request.text; state.requestTruncated = request.truncated; state.receipts = []; state.changes = [];
        state.thinking = []; state.response = ""; state.responseTruncated = false; state.droppedSources = []; state.findings = {}; state.pendingContinuation = false;
        state.interrupted = false;
        state.recoveryRequired = false;
      } else if (event.kind === "user_prompt" && (event.source === "unknown" || isContinuation) && state.episodeId === 0) {
        const request = captureText(event.userText);
        state.episodeId = 1; state.generation++; state.currentRequest = request.text; state.requestTruncated = request.truncated; state.sessionId = event.sessionId;
      }
      if (!state.sessionId) state.sessionId = event.sessionId;
      if (missingState) state.recoveryRequired = true;
      state.sequence++;
      if (event.tool) {
        const input = captureText(JSON.stringify(event.tool.input ?? {}));
        const result = captureText(event.tool.result);
        if (event.kind === "tool_start") {
          state.receipts.push({ id: event.tool.id, tool: event.tool.name, name: event.tool.name, input: input.text, inputTruncated: input.truncated,
            result: result.text, resultTruncated: result.truncated, status: "pending" });
        } else if (event.kind === "tool_result") {
          const pending = state.receipts.filter((r) => r.status === "pending" &&
            (event.tool.id ? r.id === event.tool.id : r.tool === event.tool.name &&
              (input.text === "{}" ? state.receipts.filter((x) => x.status === "pending" && x.tool === event.tool.name).length === 1 : r.input === input.text)));
          if (pending.length === 1) {
            pending[0].result = result.text; pending[0].resultTruncated = result.truncated;
            pending[0].status = event.tool.status === "failure" ? "failure" : "completed";
          } else {
            state.receipts.push({ id: event.tool.id, tool: event.tool.name, name: event.tool.name, input: input.text, inputTruncated: input.truncated,
              result: result.text, resultTruncated: result.truncated, status: event.tool.status === "failure" ? "failure" : "completed" });
          }
        }
        if (state.receipts.length > MAX_ITEMS) {
          for (const dropped of state.receipts.slice(0, state.receipts.length - MAX_ITEMS)) state.droppedSources = [...new Set([...(state.droppedSources ?? []), `receipt:${dropped.id ?? "unknown"}`])];
          state.receipts = state.receipts.slice(-MAX_ITEMS);
        }
      }
      if (event.kind === "tool_result" && event.tool && event.tool.status !== "failure" && Array.isArray(event.changes)) {
        const byPath = new Map(state.changes.map((change) => [change.path, change]));
        for (const change of event.changes) {
          const pathCapture = captureText(change.path), textCapture = captureText(change.text), contextCapture = captureText(change.context);
          const normalized = { path: pathCapture.text, text: textCapture.text, context: contextCapture.text,
            truncated: { path: pathCapture.truncated, text: textCapture.truncated, context: contextCapture.truncated } };
          if (normalized.path) byPath.set(normalized.path, normalized);
        }
        const changes = [...byPath.values()];
        if (changes.length > MAX_ITEMS) {
          for (const dropped of changes.slice(0, changes.length - MAX_ITEMS)) state.droppedSources = [...new Set([...(state.droppedSources ?? []), `change:${dropped.path || "unknown"}`])];
          state.changes = changes.slice(-MAX_ITEMS);
        } else state.changes = changes;
      }
      if (Array.isArray(event.thinking)) state.thinking.push(...event.thinking.map((x, i) => {
        const captured = captureText(x.text);
        return { ...x, text: captured.text, truncated: Boolean(x.truncated || captured.truncated), id: x.id ?? `thinking-${state.sequence}-${i}` };
      }));
      if (state.thinking.length > MAX_ITEMS) {
        for (const dropped of state.thinking.slice(0, state.thinking.length - MAX_ITEMS)) state.droppedSources = [...new Set([...(state.droppedSources ?? []), `thinking:${dropped.id ?? "unknown"}`])];
        state.thinking = state.thinking.slice(-MAX_ITEMS);
      }
      if (event.response !== undefined) {
        const response = captureText(event.response); state.response = response.text; state.responseTruncated = response.truncated;
      }
      if (event.kind === "interrupt") { state.interrupted = true; state.pendingContinuation = false; state.pendingContinuationText = ""; }
      if (event.kind === "session_end") { state.pendingContinuation = false; state.pendingContinuationText = ""; }
      const snapshot = { eventKind: event.kind, request: state.currentRequest, response: state.response,
        receipts: state.receipts.slice(), changes: state.changes.slice(), thinking: state.thinking.slice(), coverage: {} };
      // The tool call about to run, for tool_call policies checked before execution.
      if (event.kind === "tool_start" && event.tool) snapshot.currentTool = state.receipts.findLast((r) => r.status === "pending" && (!event.tool.id || r.id === event.tool.id));
      const truncatedSources = [];
      truncatedSources.push(...(state.droppedSources ?? []));
      if (state.requestTruncated) truncatedSources.push("request");
      if (state.responseTruncated) truncatedSources.push("response");
      const budgetCapture = (value, id) => {
        if (typeof value !== "string") return value;
        const remaining = Math.max(0, MAX_REVIEW_CAPTURE - budgetCapture.used);
        const kept = value.slice(0, remaining); budgetCapture.used += kept.length;
        if (kept.length < value.length && !truncatedSources.includes(id)) truncatedSources.push(id);
        return kept;
      };
      budgetCapture.used = 0;
      snapshot.request = budgetCapture(snapshot.request, "request"); snapshot.response = budgetCapture(snapshot.response, "response");
      if (snapshot.currentTool) snapshot.currentTool = { ...snapshot.currentTool, input: budgetCapture(snapshot.currentTool.input, `receipt:${snapshot.currentTool.id ?? "current"}:input`) };
      snapshot.receipts = snapshot.receipts.map((receipt, i) => {
        const id = receipt.id ?? i;
        if (receipt.inputTruncated) truncatedSources.push(`receipt:${id}:input`);
        if (receipt.resultTruncated) truncatedSources.push(`receipt:${id}:result`);
        return { ...receipt, input: budgetCapture(receipt.input, `receipt:${id}:input`), result: budgetCapture(receipt.result, `receipt:${id}:result`) };
      });
      snapshot.changes = snapshot.changes.map((change) => {
        const id = change.path || "unknown";
        for (const key of Object.keys(change.truncated ?? {})) if (change.truncated[key]) truncatedSources.push(`change:${id}:${key}`);
        return { ...change, path: budgetCapture(change.path, `change:${id}:path`), text: budgetCapture(change.text, `change:${id}:text`), context: budgetCapture(change.context, `change:${id}:context`) };
      });
      snapshot.thinking = snapshot.thinking.map((thought, i) => {
        const id = `thinking:${thought.id ?? i}`;
        if (thought.truncated) truncatedSources.push(id);
        return { ...thought, text: budgetCapture(thought.text, id) };
      });
      snapshot.coverage = { complete: truncatedSources.length === 0, truncatedSources: [...new Set(truncatedSources)] };
      await save(file, state);
      return { generation: state.generation, sequence: state.sequence, episodeId: state.episodeId, sessionId: state.sessionId,
        interrupted: state.interrupted, missingState, recoveryRequired: state.recoveryRequired, snapshot };
    });
  } catch { return { action: "none", notice: "Agent Rules state storage is unavailable; review is observe-only." }; }

  if (!reviewer || !Array.isArray(policies) || !policies.length || !REVIEWED.includes(event.kind)) return neutral;
  // Prompt and pre-tool checks add latency, so they run only when a policy asks for them.
  if (["user_prompt", "tool_start"].includes(event.kind) && !policies.some((p) => p.events?.includes(event.kind))) return neutral;
  if (captured.interrupted) return neutral;
  if (captured.recoveryRequired) return { action: "none", notice: "Agent Rules session state is missing; review is observe-only to preserve the correction limit." };
  let result;
  try { result = await reviewer.review(captured.snapshot, policies); }
  catch { result = { status: "unavailable", findings: [] }; }
  const findings = (Array.isArray(result?.findings) ? result.findings : []).map((f) => normalizeFinding({ ...f, model: f.model ?? result?.model }));
  let outcome;
  try {
    outcome = await withLock(file, async () => {
      const state = await load(file);
      if (state.generation !== captured.generation || state.sequence !== captured.sequence) return { stale: true };
      state.history ??= [];
      const complete = (effect = neutral, correction = undefined) => {
        const outcome = { action: effect.action ?? "none", ...(effect.notice ? { notice: secretScrub(effect.notice) } : {}),
          ...(correction ? { correction: secretScrub(correction) } : {}) };
        appendHistory(state, captured, findings, outcome);
        return effect;
      };
      const reviewStatus = String(result?.status ?? "").toLowerCase();
      const statuses = findings.map((f) => String(f.status).toLowerCase());
      const health = ["unknown", "unavailable"].includes(reviewStatus) ? reviewStatus
        : statuses.length && statuses.every((s) => ["unknown", "unavailable"].includes(s))
          ? statuses.includes("unavailable") ? "unavailable" : "unknown" : "healthy";
      const priorHealth = state.healthStatus;
      state.healthStatus = health;
      if (health === "unknown" || health === "unavailable") {
        for (const finding of findings) {
          const key = findingKey(finding); const old = state.findings[key];
          state.findings[key] = { ...finding, attempts: old?.attempts ?? 0, lastSeen: state.sequence,
            unchanged: hash(old?.evidence ?? null) === hash(finding.evidence ?? null) };
        }
        state.findings = Object.fromEntries(Object.entries(state.findings)
          .sort((a, b) => (a[1].lastSeen ?? 0) - (b[1].lastSeen ?? 0)).slice(-MAX_ITEMS));
        const details = [...new Set(findings.filter((f) => f.status === health || f.status === "unknown" || f.status === "unavailable")
          .map((f) => `${f.ruleId ?? "policy"}: ${f.diagnostic?.message ?? f.diagnostic?.code ?? (f.judgment?.reason === "evidence_budget_exceeded" ? "evidence exceeded the review budget" : "review was inconclusive")}`))];
        const effect = priorHealth === health ? neutral : { action: "none", notice: health === "unknown"
          ? `Agent Rules could not complete review${details.length ? ` (${details.join("; ")}; evidence may be missing or inconclusive)` : "; evidence is missing or inconclusive"}.`
          : `Agent Rules review is temporarily unavailable${details.length ? ` (${details.join("; ")})` : ""}; no correction was issued.` };
        const done = complete(effect); await save(file, state); return done;
      }
      const recovered = Boolean(priorHealth && priorHealth !== "healthy");
      const newOnes = []; let resolved = false; let unchangedActive = false;
      const clearStatuses = new Set(["clear", "resolved", "pass", "compliant"]);
      const nonClearRules = new Set(findings.filter((f) => !clearStatuses.has(String(f.status).toLowerCase())).map((f) => f.ruleId));
      const clearRules = new Set(findings.filter((f) => clearStatuses.has(String(f.status).toLowerCase()) && f.evidence && shownEvidence(f.evidence).length && !nonClearRules.has(f.ruleId)).map((f) => f.ruleId));
      for (const old of Object.values(state.findings)) if (activeFinding(old) && clearRules.has(old.ruleId)) { old.status = "resolved"; resolved = true; }
      for (const finding of findings) {
        const key = findingKey(finding); const old = state.findings[key];
        state.findings[key] = { ...finding, attempts: old?.attempts ?? 0, lastSeen: state.sequence,
          unchanged: old?.evidence === finding.evidence };
        if (activeFinding(finding) && (!old || hash(old.evidence ?? null) !== hash(finding.evidence ?? null) || old.mode !== finding.mode)) newOnes.push(finding);
        else if (activeFinding(finding) && ["repair", "block"].includes(finding.mode)) unchangedActive = true;
      }
      // Observe findings reach the user as a notice; the agent never sees them.
      const observed = [...new Set(newOnes.filter((f) => f.mode === "observe").map((f) => f.ruleId ?? "policy"))];
      const withObserved = (notice) => [notice, observed.length ? `Agent Rules (observe): ${observed.join(", ")} would have fired.` : ""].filter(Boolean).join(" ") || undefined;
      const findingEntries = Object.entries(state.findings).sort((a, b) => (a[1].lastSeen ?? 0) - (b[1].lastSeen ?? 0)).slice(-MAX_ITEMS);
      state.findings = Object.fromEntries(findingEntries);
      const cap = Math.max(0, Number(config.maxCorrectionsPerEpisode ?? 2));
      // A block stops the prompt or the tool call rather than asking for a rewrite, so it cannot loop: it
      // applies to every match, repeats included, and does not use up the correction limit.
      // Tool calls are blocked in repair and block mode; prompts only in block mode.
      const rejectPrompt = event.kind === "user_prompt" && findings.some((f) => activeFinding(f) && f.mode === "block");
      const blocking = event.kind === "tool_start" || rejectPrompt;
      const actionable = [...new Map((blocking ? findings.filter(activeFinding) : newOnes).filter((f) => ["repair", "block"].includes(f.mode) && f.correction && f.correction !== "undefined")
        .filter((f) => !rejectPrompt || f.mode === "block")
        .map((f) => [findingKey(f), f])).values()]
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || String(a.ruleId).localeCompare(String(b.ruleId))).slice(0, 3);
      if (actionable.length && (blocking || state.correctionsDelivered < cap)) {
        const label = blocking ? "blocked" : `attempt ${++state.correctionsDelivered}/${cap}`;
        if (event.kind === "response_end") {
          state.pendingContinuation = event.platform === "codex" || event.platform === "claude";
        }
        for (const f of actionable) state.findings[findingKey(f)].attempts++;
        const feedback = actionable.map((f) => correctionText(f, label)).join("\n\n");
        if (event.kind === "response_end") state.pendingContinuationText = feedback;
        const effect = { action: event.kind === "response_end" ? "continue_turn" : rejectPrompt ? "block_prompt" : blocking ? "deny_tool" : "add_context",
          event: event.kind, feedback: rejectPrompt ? `Agent Rules blocked this request. ${actionable.map((f) => `${f.ruleId}: ${f.description}`).join(" ")}` : feedback,
          notice: withObserved(`Agent Rules: ${actionable.map((f) => f.ruleId ?? "policy").join(", ")} (${blocking ? "blocked" : label.replace("attempt ", "")}).`) };
        const done = complete(effect, feedback); await save(file, state); return done;
      }
      if (actionable.length && state.correctionsDelivered >= cap) {
        const done = complete({ action: "none", notice: withObserved("Behavior review reached the correction limit for this request.") });
        await save(file, state); return done;
      }
      let effect = neutral;
      if (resolved) effect = neutral;
      else if (unchangedActive && state.correctionsDelivered >= cap) effect = { action: "none", notice: "Behavior review reached the correction limit for this request." };
      else if (unchangedActive) effect = { action: "none", notice: "No progress was observed on the previously reported issue." };
      else if (recovered) effect = { action: "none", notice: "Agent Rules review coverage has recovered." };
      const notice = withObserved(effect.notice);
      if (notice) effect = { ...effect, action: effect.action ?? "none", notice };
      const done = complete(effect); await save(file, state); return done;
    });
  } catch { return { action: "none", notice: "Agent Rules state storage is unavailable; review is observe-only." }; }
  return outcome?.stale ? neutral : outcome ?? neutral;
}

export const __runtimeInternals = { withLock, load, save };
