#!/usr/bin/env node
//! The Claude Code side. Reads the same rule files omp reads.
//
// Two modes, chosen by argv:
//
//   pre   PreToolUse   — rules with an interrupting `interruptMode`. Stops the
//                        write with `ask`, so a person decides.
//   post  PostToolUse  — rules with `interruptMode: never`, which is all of
//                        them by default. The write lands and the agent is
//                        handed the rule body, so it fixes the line in the
//                        same turn.
//
// **Every failure path is silent.** Exit 0 with no output means "no decision",
// which is not approval — the normal permission flow continues. A broken rule
// file, an unreadable cache, a payload shape nobody has seen: none of those are
// the developer's problem, and none of them may block a write.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRules } from "../src/rules.js";
import { matchPayload } from "../src/match.js";

/** The two directories omp reads, in omp's order: project wins. */
export function ruleDirs(cwd) {
  const override = process.env.AGENT_RULES_DIRS;
  if (override) return override.split(":").filter(Boolean);
  return [join(homedir(), ".omp", "agent", "rules"), join(cwd || ".", ".omp", "rules")];
}

const cacheDir = () =>
  process.env.AGENT_RULES_CACHE ?? join(homedir(), ".cache", "agent-rules");

const stateFile = (sessionId) =>
  join(cacheDir(), `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

/**
 * Which rules have already fired this session.
 *
 * An unreadable cache returns empty, so the rule fires. Being told twice is a
 * nuisance; being told never is the failure this tool exists to prevent.
 */
function alreadyFired(sessionId) {
  if (!sessionId) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(stateFile(sessionId), "utf8")).fired);
  } catch {
    return new Set();
  }
}

function recordFired(sessionId, names) {
  if (!sessionId) return;
  try {
    const file = stateFile(sessionId);
    mkdirSync(dirname(file), { recursive: true });
    const fired = [...new Set([...alreadyFired(sessionId), ...names])];
    writeFileSync(file, JSON.stringify({ fired }));
  } catch {
    // A cache we cannot write just means the rule may fire again. Not fatal.
  }
}

export function render(fired, path) {
  return fired
    .map((f) => `[agent-rules] ${f.name} — ${f.description}\n${path}\n\n${f.body}`)
    .join("\n\n---\n\n");
}

export function decide(payload, rules, mode) {
  const fired = matchPayload(payload, rules).filter((f) => f.delivery === mode);
  if (fired.length === 0) return { reply: null, names: [] };

  const seen = alreadyFired(payload.session_id);
  const fresh = fired.filter((f) => !seen.has(f.name));
  if (fresh.length === 0) return { reply: null, names: [] };

  const text = render(fresh, payload?.tool_input?.file_path ?? "");
  const names = fresh.map((f) => f.name);

  if (mode === "pre") {
    return {
      reply: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: text,
        },
      },
      names,
    };
  }
  return {
    reply: {
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text },
    },
    names,
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const mode = process.argv[2] === "pre" ? "pre" : "post";
  const payload = JSON.parse(await readStdin());

  const { rules } = loadRules(ruleDirs(payload.cwd));
  if (rules.length === 0) return;

  const { reply, names } = decide(payload, rules, mode);
  if (!reply) return;

  process.stdout.write(JSON.stringify(reply));
  recordFired(payload.session_id, names);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Silence. See the note at the top of this file.
  });
}
