//! Given one hook payload and the loaded rules, decide which rules fire.
//
// No I/O, no state, no hook wiring. That keeps the part most likely to be
// wrong — the matching — testable against recorded payloads on its own.

import { basename } from "node:path";

/** Claude Code tool names, mapped onto the two tools omp watches. */
const TOOL_MAP = { Edit: "edit", MultiEdit: "edit", Write: "write" };

export function globToRegExp(glob) {
  let re = "";
  let brace = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else {
        re += "[^/]*";
      }
      continue;
    }
    if (c === "?") { re += "[^/]"; continue; }
    if (c === "{") { brace++; re += "(?:"; continue; }
    if (c === "}") { brace--; re += ")"; continue; }
    if (c === "," && brace > 0) { re += "|"; continue; }
    re += c.replace(/[.+^${}()|[\]\\,]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** A glob with no slash matches the file name; otherwise the relative path. */
export function pathMatches(glob, relPath) {
  const target = glob.includes("/") ? relPath : basename(relPath);
  return globToRegExp(glob).test(target);
}

export function relativeTo(cwd, path) {
  if (!cwd || !path.startsWith(cwd)) return path;
  return path.slice(cwd.length).replace(/^\//, "");
}

export function targetPath(payload) {
  const p = payload?.tool_input?.file_path;
  return typeof p === "string" ? p : null;
}

/**
 * Only the text the agent is adding. Never the file on disk, and never the
 * text being removed — that is why an existing violation elsewhere in a file
 * does not fire the rule while a newly written line does.
 */
export function addedText(payload) {
  const tool = payload?.tool_name;
  const input = payload?.tool_input ?? {};
  if (tool === "Edit") return typeof input.new_string === "string" ? input.new_string : null;
  if (tool === "Write") return typeof input.content === "string" ? input.content : null;
  if (tool === "MultiEdit") {
    if (!Array.isArray(input.edits)) return null;
    const parts = input.edits
      .map((e) => e?.new_string)
      .filter((s) => typeof s === "string");
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

const inScope = (rule, tool, relPath) =>
  rule.scopes.length === 0 ||
  rule.scopes.some((s) => s.tool === tool && pathMatches(s.glob, relPath));

/**
 * @returns {Array<{name: string, delivery: "pre"|"post", description: string,
 *                  body: string, matched: string}>} in rule order.
 */
export function matchPayload(payload, rules, { cwd = payload?.cwd ?? "" } = {}) {
  const tool = TOOL_MAP[payload?.tool_name];
  if (!tool) return [];

  const path = targetPath(payload);
  const text = addedText(payload);
  if (path === null || text === null) return [];

  const relPath = relativeTo(cwd, path);
  const fired = [];

  for (const rule of rules) {
    if (!inScope(rule, tool, relPath)) continue;
    const hit = rule.conditions.find((re) => re.test(text));
    if (!hit) continue;
    fired.push({
      name: rule.name,
      delivery: rule.delivery,
      description: rule.description,
      body: rule.body,
      matched: String(hit),
    });
  }

  return fired;
}
