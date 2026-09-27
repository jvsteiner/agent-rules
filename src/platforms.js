const str = (v) => typeof v === "string" && v.length ? v : undefined;
const obj = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : {};
const clean = (v) => typeof v === "string" ? v : v == null ? undefined : JSON.stringify(v);

function common(platform, p, kind, source = "unknown") {
  return { platform, sessionId: str(p.session_id ?? p.sessionId), actorId: str(p.agent_id ?? p.actor_id) ?? "main", kind,
    eventId: str(p.event_id ?? p.eventId), hostTurnId: str(p.turn_id ?? p.turnId),
    cwd: str(p.cwd), source };
}

function parsePatch(command) {
  if (typeof command !== "string") return [];
  const changes = [];
  const re = /\*\*\*(?: Begin Patch\n)?\s*(?:Update|Add|Delete) File: ([^\n]+)\n([\s\S]*?)(?=\n\*\*\*(?: Update| Add| Delete) File:|\n\*\*\* End Patch|$)/g;
  let m;
  while ((m = re.exec(command))) {
    const text = m[2].split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1)).join("\n");
    changes.push({ path: m[1].trim(), text, context: m[2].slice(0, 1800) });
  }
  return changes;
}

export function decode(platform, payload) {
  const p = obj(payload);
  if (platform === "claude") {
    const name = p.hook_event_name;
    const e = {
      SessionStart: "session_start", UserPromptSubmit: "user_prompt", PreToolUse: "tool_start",
      PostToolUse: "tool_result", PostToolUseFailure: "tool_result", Stop: "response_end",
      SessionEnd: "session_end",
    }[name];
    if (!e) return null;
    const event = common(platform, p, e, p.source === "plugin_continuation" ? "plugin_continuation" : "unknown");
    if (e === "user_prompt") { event.userText = str(p.prompt); event.source = p.source === "plugin_continuation" ? "plugin_continuation" : "host_user"; }
    if (e === "tool_start" || e === "tool_result") {
      const input = obj(p.tool_input);
      event.tool = { id: str(p.tool_use_id ?? p.tool_id), name: str(p.tool_name), input,
        result: clean(p.tool_response), status: name === "PostToolUseFailure" ? "failure" : e === "tool_result" ? "success" : "pending" };
      const path = str(input.file_path ?? input.path);
      const text = str(input.new_string ?? input.content ?? input.file_text);
      if (path && text !== undefined && ["Edit", "Write"].includes(event.tool.name)) event.changes = [{ path, text, context: clean(input.old_string) }];
      if (event.tool.name === "MultiEdit" && Array.isArray(input.edits)) event.changes = input.edits.map((edit) => ({ path: str(edit.file_path ?? path), text: str(edit.new_string) ?? "", context: clean(edit.old_string) })).filter((c) => c.path);
    }
    if (e === "response_end") { event.response = str(p.last_assistant_message); event.stopHookActive = Boolean(p.stop_hook_active); }
    if (Array.isArray(p.thinking)) event.thinking = p.thinking.filter((x) => typeof x?.text === "string").map((x) => ({ id: str(x.id), text: x.text, kind: str(x.kind) ?? "exposed", completeness: str(x.completeness) }));
    if (e === "session_start" || e === "session_end") event.source = "unknown";
    return event;
  }
  if (platform === "codex") {
    const name = p.type ?? p.hook_event_name;
    const e = { SessionStart: "session_start", UserPromptSubmit: "user_prompt", PreToolUse: "tool_start",
      PostToolUse: "tool_result", Stop: "response_end", Interrupt: "interrupt", SessionEnd: "session_end" }[name];
    if (!e) return null;
    const event = common(platform, p, e, p.source === "plugin_continuation" ? "plugin_continuation" : "unknown");
    const d = obj(p["payload"]);
    if (e === "user_prompt") { event.userText = str(d.prompt ?? p.prompt); event.source = p.source === "plugin_continuation" ? "plugin_continuation" : "host_user"; }
    if (e === "tool_start" || e === "tool_result") {
      const name = str(d.tool_name ?? p.tool_name);
      const input = d.tool_input ?? p.tool_input ?? (name === "apply_patch" ? { command: d.command ?? p.command } : {});
      const exitCode = d.exit_code ?? p.exit_code;
      const resultStatus = e === "tool_result" ? (typeof exitCode === "number" && exitCode !== 0 ? "failure" : "completed") : "pending";
      event.tool = { id: str(d.tool_call_id ?? p.tool_call_id ?? d.tool_use_id ?? p.tool_use_id), name, input: obj(input), result: clean(d.tool_output ?? p.tool_output ?? d.tool_response ?? p.tool_response), status: resultStatus };
      if (name === "apply_patch") event.changes = parsePatch(event.tool.input.command);
    }
    if (e === "response_end") { event.response = str(d.last_assistant_message ?? p.last_assistant_message); event.stopHookActive = Boolean(p.stop_hook_active ?? d.stop_hook_active); }
    if (Array.isArray(p.thinking)) event.thinking = p.thinking.filter((x) => typeof x?.text === "string").map((x) => ({ id: str(x.id), text: x.text, kind: str(x.kind) ?? "exposed", completeness: str(x.completeness) }));
    return event;
  }
  return null;
}

export function encode(platform, effect = {}) {
  const action = effect.action ?? "none";
  const message = [effect.notice, effect.feedback].filter(Boolean).join("\n\n");
  if (!message) return {};
  if (action === "none") return effect.notice ? { systemMessage: effect.notice } : {};
  if (!["claude", "codex"].includes(platform)) return {};
  // Claude Code and Codex accept the same hook output shapes.
  if (action === "block_prompt") return { decision: "block", reason: effect.feedback ?? effect.notice, systemMessage: effect.notice };
  if (action === "deny_tool") return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: effect.feedback ?? effect.notice }, systemMessage: effect.notice };
  const hookEventName = { user_prompt: "UserPromptSubmit", tool_start: "PreToolUse" }[effect.event] ?? "PostToolUse";
  if (action === "continue_turn") return { decision: "block", reason: effect.feedback ?? effect.notice, systemMessage: effect.notice };
  return { hookSpecificOutput: { hookEventName, additionalContext: effect.feedback ?? effect.notice }, systemMessage: effect.notice };
}

export const claude = { decode: (payload) => decode("claude", payload), encode: (effect) => encode("claude", effect) };
export const codex = { decode: (payload) => decode("codex", payload), encode: (effect) => encode("codex", effect) };
