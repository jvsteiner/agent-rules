//! The YAML subset an omp rule file actually uses.
//
// A full YAML parser is a dependency, and this plugin installs by clone with no
// build step. The rule schema is six known keys holding strings, lists of
// strings, or booleans, so the subset is small enough to own.
//
// Anything outside the subset throws. A rule file that cannot be read is a
// rule that silently stops firing, which is the failure this whole tool exists
// to prevent — so it is loud here and skipped by the caller.

/** Split on `delim`, ignoring delimiters inside quotes, brackets or parens. */
export function splitTopLevel(s, delim = ",") {
  const out = [];
  let buf = "";
  let quote = null;
  let depth = 0;
  for (const ch of s) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === "[" || ch === "(" || ch === "{") depth++;
    if (ch === "]" || ch === ")" || ch === "}") depth--;
    if (ch === delim && depth === 0) { out.push(buf); buf = ""; continue; }
    buf += ch;
  }
  out.push(buf);
  return out.map((x) => x.trim()).filter((x) => x !== "");
}

function unquoteDouble(raw) {
  let out = "";
  let i = 1;
  for (; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\") {
      const next = raw[++i];
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else out += next; // covers \\ and \"
      continue;
    }
    if (ch === '"') return out;
    out += ch;
  }
  throw new Error("unterminated double-quoted string");
}

function unquoteSingle(raw) {
  let out = "";
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] === "'") {
      if (raw[i + 1] === "'") { out += "'"; i++; continue; }
      return out;
    }
    out += raw[i];
  }
  throw new Error("unterminated single-quoted string");
}

export function parseScalar(raw) {
  const t = raw.trim();
  if (t === "") return "";
  if (t[0] === '"') return unquoteDouble(t);
  if (t[0] === "'") return unquoteSingle(t);
  if (t[0] === "[") {
    if (!t.endsWith("]")) throw new Error("unterminated inline list");
    return splitTopLevel(t.slice(1, -1)).map(parseScalar);
  }
  if (t === "true") return true;
  if (t === "false") return false;
  // A bare scalar may carry a trailing comment.
  const hash = t.indexOf(" #");
  return (hash >= 0 ? t.slice(0, hash) : t).trim();
}

/**
 * Split a rule file into its front matter and its body.
 * @returns {{front: Record<string, unknown>, body: string}}
 */
export function parseFrontMatter(src) {
  const text = src.replace(/^﻿/, "");
  if (!text.startsWith("---\n")) throw new Error("no front matter");
  const end = text.indexOf("\n---", 3);
  if (end === -1) throw new Error("front matter is not closed");

  const yaml = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n/, "");
  const front = {};
  const lines = yaml.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) throw new Error(`unexpected indent: ${line.trim()}`);

    const colon = line.indexOf(":");
    if (colon === -1) throw new Error(`not a key: ${line.trim()}`);
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();

    if (rest !== "") { front[key] = parseScalar(rest); continue; }

    // A block list: the following indented `- item` lines.
    const items = [];
    while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) {
      items.push(parseScalar(lines[++i].trim().slice(1)));
    }
    front[key] = items;
  }

  return { front, body };
}
