import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_TEXT = 12000;
const MAX_ITEMS = 80;
const secretScrub = (s) => String(s ?? "").slice(0, MAX_TEXT)
  .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9._~-]{12,})\b/g, "[REDACTED]");
const scrubEvidence = (e) => Array.isArray(e) ? e.map(scrubEvidence) : e && typeof e === "object"
  ? Object.fromEntries(Object.entries(e).map(([k, v]) => [k, scrubEvidence(v)]))
  : typeof e === "string" ? secretScrub(e) : e;
const shownEvidence = (e) => Array.isArray(e) ? e.map(shownEvidence).join("\n")
  : e && typeof e === "object" ? JSON.stringify(e) : e;
const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const empty = () => ({ version: 1, episodeId: 0, generation: 0, correctionsDelivered: 0,
  pendingContinuation: false, pendingContinuationText: "", originatingUserEvent: null, currentRequest: "", receipts: [], changes: [],
  thinking: [], response: "", findings: {}, sequence: 0, recoveryRequired: false });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeFinding(f) {
  return { id: f.id ?? hash([f.ruleId, f.description, f.evidence]), ruleId: f.ruleId,
    status: f.status, description: secretScrub(f.description), correction: secretScrub(f.correction),
    evidence: scrubEvidence(f.evidence), judgment: f.judgment, policyHash: f.policyHash,
    model: f.model, mode: f.mode, priority: f.priority };
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
        state.episodeId++; state.generation++; state.correctionsDelivered = 0;
        state.originatingUserEvent = event.eventId ?? `local-${state.sequence + 1}`;
        state.currentRequest = secretScrub(event.userText); state.receipts = []; state.changes = [];
        state.thinking = []; state.response = ""; state.findings = {}; state.pendingContinuation = false;
        state.interrupted = false;
        state.recoveryRequired = false;
      } else if (event.kind === "user_prompt" && (event.source === "unknown" || isContinuation) && state.episodeId === 0) {
        state.episodeId = 1; state.generation++; state.currentRequest = secretScrub(event.userText);
      }
      if (missingState) state.recoveryRequired = true;
      state.sequence++;
      if (event.tool) {
        const input = secretScrub(JSON.stringify(event.tool.input ?? {}));
        if (event.kind === "tool_start") {
          state.receipts.push({ id: event.tool.id, tool: event.tool.name, name: event.tool.name, input,
            result: secretScrub(event.tool.result), status: "pending" });
        } else if (event.kind === "tool_result") {
          const pending = state.receipts.filter((r) => r.status === "pending" &&
            (event.tool.id ? r.id === event.tool.id : r.tool === event.tool.name &&
              (input === "{}" ? state.receipts.filter((x) => x.status === "pending" && x.tool === event.tool.name).length === 1 : r.input === input)));
          if (pending.length === 1) {
            pending[0].result = secretScrub(event.tool.result);
            pending[0].status = event.tool.status === "failure" ? "failure" : "completed";
          } else {
            state.receipts.push({ id: event.tool.id, tool: event.tool.name, name: event.tool.name, input,
              result: secretScrub(event.tool.result), status: event.tool.status === "failure" ? "failure" : "completed" });
          }
        }
        state.receipts = state.receipts.slice(-MAX_ITEMS);
      }
      if (event.kind === "tool_result" && event.tool && event.tool.status !== "failure" && Array.isArray(event.changes)) {
        const byPath = new Map(state.changes.map((change) => [change.path, change]));
        for (const change of event.changes) {
          const normalized = { path: secretScrub(change.path), text: secretScrub(change.text), context: secretScrub(change.context) };
          if (normalized.path) byPath.set(normalized.path, normalized);
        }
        state.changes = [...byPath.values()].slice(-MAX_ITEMS);
      }
      if (Array.isArray(event.thinking)) state.thinking.push(...event.thinking.map((x) => ({ ...x, text: secretScrub(x.text) })));
      state.thinking = state.thinking.slice(-MAX_ITEMS);
      if (event.response !== undefined) state.response = secretScrub(event.response);
      if (event.kind === "interrupt") { state.interrupted = true; state.pendingContinuation = false; state.pendingContinuationText = ""; }
      if (event.kind === "session_end") { state.pendingContinuation = false; state.pendingContinuationText = ""; }
      await save(file, state);
      return { generation: state.generation, sequence: state.sequence, interrupted: state.interrupted, missingState, recoveryRequired: state.recoveryRequired, snapshot: {
        eventKind: event.kind, request: state.currentRequest, response: state.response,
        receipts: state.receipts.slice(), changes: state.changes.slice(), thinking: state.thinking.slice(), coverage: {},
      } };
    });
  } catch { return { action: "none", notice: "Agent Rules state storage is unavailable; review is observe-only." }; }

  if (!reviewer || !Array.isArray(policies) || !policies.length || !["response_end", "tool_result"].includes(event.kind)) return neutral;
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
        await save(file, state);
        if (priorHealth === health) return neutral;
        return { action: "none", notice: health === "unknown"
          ? "Agent Rules could not review this event because required evidence is missing or inconclusive."
          : "Agent Rules review is temporarily unavailable; no correction was issued." };
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
        else if (activeFinding(finding)) unchangedActive = true;
      }
      const findingEntries = Object.entries(state.findings).sort((a, b) => (a[1].lastSeen ?? 0) - (b[1].lastSeen ?? 0)).slice(-MAX_ITEMS);
      state.findings = Object.fromEntries(findingEntries);
      const cap = Math.max(0, Number(config.maxCorrectionsPerEpisode ?? 2));
      const actionable = [...new Map(newOnes.filter((f) => f.mode === "repair" && f.correction && f.correction !== "undefined")
        .map((f) => [findingKey(f), f])).values()]
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || String(a.ruleId).localeCompare(String(b.ruleId))).slice(0, 3);
      if (actionable.length && state.correctionsDelivered < cap) {
        state.correctionsDelivered++; const attempt = state.correctionsDelivered;
        state.pendingContinuation = event.platform === "codex" || event.platform === "claude";
        for (const f of actionable) state.findings[findingKey(f)].attempts++;
        const feedback = actionable.map((f) => `[Agent Rules: ${f.ruleId ?? "policy"}; attempt ${attempt}/${cap}]\nEvidence: ${shownEvidence(f.evidence) || "(none provided)"}\nCorrection: ${f.correction}`).join("\n\n");
        state.pendingContinuationText = feedback;
        await save(file, state);
        return { action: event.kind === "response_end" ? "continue_turn" : "add_context",
          feedback,
          notice: `Agent Rules: ${actionable.map((f) => f.ruleId ?? "policy").join(", ")} (${attempt}/${cap}).` };
      }
      if (actionable.length && state.correctionsDelivered >= cap) {
        await save(file, state);
        return { action: "none", notice: "Behavior review reached the correction limit for this request." };
      }
      await save(file, state);
      if (resolved) return { action: "none", notice: "A previously reported issue is no longer present in the latest review." };
      if (unchangedActive && state.correctionsDelivered >= cap) return { action: "none", notice: "Behavior review reached the correction limit for this request." };
      if (unchangedActive) return { action: "none", notice: "No progress was observed on the previously reported issue." };
      if (recovered) return { action: "none", notice: "Agent Rules review coverage has recovered." };
      return neutral;
    });
  } catch { return { action: "none", notice: "Agent Rules state storage is unavailable; review is observe-only." }; }
  return outcome?.stale ? neutral : outcome ?? neutral;
}

export const __runtimeInternals = { withLock, load, save };
