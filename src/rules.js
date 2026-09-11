//! Load rule files and normalise them exactly the way omp does.
//
// The two readers must agree. Where omp's own normaliser does something
// surprising, this file copies the surprise rather than improving on it — a
// rule that means two different things in two agents is worse than a rule with
// an awkward edge case. Cross-references are to `dist/cli.js` in
// @oh-my-pi/pi-coding-agent, read at version 2026-09-10.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { parseFrontMatter, splitTopLevel } from "./frontmatter.js";

/** The only tools omp ever watches (`F2r`). */
export const WATCHED_TOOLS = ["edit", "write"];

/**
 * Compile a condition, lifting an inline flag prefix onto the regex (omp `oA`).
 * `(?i)foo` becomes /foo/i. Only i, m and s are recognised, matching omp.
 */
export function compileCondition(pattern) {
  const m = /^\(\?([a-z]+)\)/.exec(pattern);
  if (m && /^[ims]+$/.test(m[1])) {
    return new RegExp(pattern.slice(m[0].length), [...new Set(m[1])].join(""));
  }
  return new RegExp(pattern);
}

/**
 * Does a condition entry look like a file glob rather than a regex?
 *
 * omp has one further guard here that the minified source does not reveal, so
 * this implements only the two visible tests. It matters rarely: a rule that
 * sets `scope` explicitly never reaches this path.
 */
export function looksLikeGlob(t) {
  if (t.includes("/")) return true;
  return /^\*\.[^\s/]+$/.test(t);
}

const toList = (v) =>
  v === undefined || v === null || v === ""
    ? []
    : Array.isArray(v)
      ? v.map(String)
      : splitTopLevel(String(v));

/**
 * omp's `QRe`: a condition that is really a glob becomes an edit+write scope,
 * and a rule left with no condition at all matches everything in that scope.
 */
export function normalise(front) {
  const raw = front.condition ?? front.ttsr_trigger ?? front.ttsrTrigger;
  const conditions = [];
  const fromGlob = [];

  for (const entry of toList(raw)) {
    if (looksLikeGlob(entry)) {
      for (const tool of WATCHED_TOOLS) fromGlob.push(`tool:${tool}(${entry})`);
      continue;
    }
    conditions.push(entry);
  }
  if (conditions.length === 0 && fromGlob.length > 0) conditions.push(".*");

  return {
    condition: [...new Set(conditions)],
    scope: [...new Set([...toList(front.scope), ...fromGlob])],
  };
}

/** `tool:edit(*.ts)` -> `{tool: "edit", glob: "*.ts"}`. */
export function parseScope(entry) {
  const m = /^tool:([a-z]+)\((.*)\)$/.exec(entry.trim());
  if (!m) throw new Error(`scope is not tool:<tool>(<glob>): ${entry}`);
  return { tool: m[1], glob: m[2].trim() };
}

/**
 * How a fired rule is delivered.
 *
 * `never` — what every omp builtin uses — lets the write land and tells the
 * agent afterwards. Anything else stops the write and asks a person. Absent
 * means `post`, because the gentle path is the one that survives a false
 * positive (`docs/2026-09-11-agent-rules-design.md` §6).
 */
export function deliveryOf(front) {
  const mode = front.interruptMode;
  return mode === undefined || mode === "never" ? "post" : "pre";
}

export function parseRule(name, src) {
  const { front, body } = parseFrontMatter(src);
  const n = normalise(front);
  if (n.condition.length === 0) throw new Error("no condition");
  return {
    name,
    description: typeof front.description === "string" ? front.description : "",
    body: body.trim(),
    delivery: deliveryOf(front),
    conditions: n.condition.map(compileCondition),
    scopes: n.scope.map(parseScope),
  };
}

const listMarkdown = (dir) => {
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => join(dir, f));
};

/**
 * Load every rule from `dirs`, in order. A later directory wins on a name
 * clash, so callers pass global first and project second — omp dedups by name
 * the same way.
 */
export function loadRules(dirs) {
  const byName = new Map();
  const warnings = [];

  for (const dir of dirs) {
    for (const file of listMarkdown(dir)) {
      const name = basename(file, ".md");
      try {
        byName.set(name, { ...parseRule(name, readFileSync(file, "utf8")), file });
      } catch (e) {
        warnings.push(`${file}: ${e.message}`);
      }
    }
  }

  return { rules: [...byName.values()], warnings };
}
