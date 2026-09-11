# agent-rules — design

> Date: 2026-09-11
> Status: §12 steps 1-3 done. Step 4, the installer, is next.
> Decisions taken: Node (not Rust); global symlink only; omp's format as-is

One set of rule files. Two readers: **omp** reads them natively, and a **Claude
Code plugin** reads the same files and behaves the same way.

---

## 1. What this is

A rule is a markdown file saying "do not write this, write that instead". When
an agent is about to write code that matches it, the agent gets told, in the
same turn, before the mistake reaches a pull request.

omp already does this. It calls the feature TTSR — Time Traveling Stream Rules.
Claude Code has no equivalent, but its hooks can reproduce the behaviour that
matters.

**This repository holds the rules and the Claude side. It does not change omp.**

---

## 2. The rule format

omp's own format, unchanged. Verified by reading
`/Users/jamie/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`
— function `QRe` is the frontmatter normaliser.

```yaml
---
description: "Do not use `await import()` — use static imports unless dynamic loading is unavoidable"
condition: "await import\\("
scope: "tool:edit(*.ts), tool:edit(*.tsx), tool:write(*.ts), tool:write(*.tsx)"
interruptMode: never
---

Use static imports for modules known at author time.

## Why
- Static imports fail during build, not under load.

## Avoid
```typescript
const { createClient } = await import("some-sdk");
```

## Use
```typescript
import { createClient } from "some-sdk";
```
```

### Field behaviour, as omp implements it

| Field | Behaviour |
|---|---|
| `description` | One line. Shown when the rule fires. |
| `condition` | A regex. Aliases `ttsr_trigger` and `ttsrTrigger` are accepted. |
| `condition` that looks like a glob | If it contains `/` or matches `^\*\.[^\s/]+$`, omp converts it into `tool:edit(<glob>)` **and** `tool:write(<glob>)` scopes, and sets the condition to `.*`. |
| `astCondition` | An ast-grep pattern. **Out of scope for v1** — see §10. |
| `scope` | A list. Entries look like `tool:edit(<glob>)`. Only the `edit` and `write` tools are ever watched. |
| `interruptMode` | `never` (the default in all 27 omp builtins) or interrupting. Drives §6. |

Inline regex flags are supported: a `condition` starting with `(?i)`, `(?m)` or
`(?s)` has those flags lifted onto the compiled regex. omp does this in function
`oA`. The Claude side must do the same or the two readers disagree.

**The body is the payload.** When a rule fires, the body is what the agent is
told. Write it for a reader who has to fix the line right now.

---

## 3. Where rules live

omp reads exactly two directories. Confirmed from its own UI strings:

- `"This project (.omp/rules)"` → `<cwd>/.omp/rules/<name>.md`
- `"Global — all projects (~/.omp/agent/rules)"` → `~/.omp/agent/rules/<name>.md`

The Claude plugin reads **both, in the same order**, so a rule behaves
identically whichever agent is running.

| Level | Path | Scope |
|---|---|---|
| Global | `~/.omp/agent/rules/*.md` | Every repo on this machine |
| Project | `<repo>/.omp/rules/*.md` | That repo only |

Project rules win. A project file with the same basename as a global one
replaces it — same as omp's name-based dedup.

### Keeping it invisible to other people

Global rules live outside every repo, so there is nothing to hide.

Project rules sit inside the repo. They must not be committed, because
colleagues do not have this plugin and should not receive an unexplained
`.omp/` folder.

**Use `.git/info/exclude`, not `.gitignore`.** `.gitignore` is itself a tracked
file, so adding a line to it is a change other people see. `.git/info/exclude`
lives inside `.git/`, is never committed, and is invisible to everybody else.

The line to add is:

```
.omp/rules/
```

---

## 4. Install

One command. One symlink. Nothing else touches the machine.

```
~/Code/agent-rules/rules/   ->   ~/.omp/agent/rules/
```

A symlink, not a copy, so editing a rule in this repository takes effect
everywhere immediately with no re-install.

The installer does **not** write into any repo. Project rules are hand-authored
when someone actually wants one, and the `.git/info/exclude` line is added at
that point by a separate small command.

---

## 5. The Claude plugin

A standard Claude Code plugin. Node, no build step, so it installs by clone.

**The repository root is the plugin.** Claude Code copies a plugin into
`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, so anything outside
the plugin directory is gone at run time. A `plugin/` subdirectory holding only
the hook would lose `src/` on install. The marketplace entry therefore uses
`"source": "./"`.

```
.claude-plugin/marketplace.json
hooks/hooks.json
bin/agent-rules-hook.js
src/                  the loader and matcher
rules/                the rules themselves
tools/dryrun.mjs      count what a rule would fire on, before shipping it
```

`hooks.json` wires two events:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "node",
                    "args": ["${CLAUDE_PLUGIN_ROOT}/bin/agent-rules-hook.js", "pre"],
                    "timeout": 5 }] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "node",
                    "args": ["${CLAUDE_PLUGIN_ROOT}/bin/agent-rules-hook.js", "post"],
                    "timeout": 10 }] }
    ]
  }
}
```

---

## 6. Why two hooks, and which rule uses which

**This is the decision that matters.**

The obvious design is to deny the write and hand the model the reason. Do not.
A denial with a reason attached is an invitation to argue, and the model takes
it: every false positive becomes a negotiation, in the middle of the work, with
something that does not get tired of negotiating. `ask` avoids that by putting a
person in front of the finding instead — but asking on every rule hit is its own
way of getting the tool switched off.

So the rule file chooses, using the `interruptMode` field omp already has:

| `interruptMode` | Hook | What happens |
|---|---|---|
| `never` — the default, and what all 27 omp builtins use | `PostToolUse` | The edit lands. The agent is handed the rule body as `additionalContext` and fixes it in the same turn. |
| interrupting | `PreToolUse` | The write is stopped with `permissionDecision: "ask"`, and a person decides. |

`deny` is not used. It is reserved for a case this tool does not have.

**All ten starter rules use `never`,** matching omp's own defaults.

### Wire shapes

Taken from payloads recorded during real Claude Code sessions rather than from
the documentation — the hook contract has moved more than once, and a recording
is how you find that out instead of a user. The recordings live in
`test/fixtures/hooks/`.

Input arrives on stdin:

```json
{ "session_id": "...", "cwd": "...", "hook_event_name": "PreToolUse",
  "tool_name": "Edit",
  "tool_input": { "file_path": "...", "old_string": "...", "new_string": "..." } }
```

Output for a `PostToolUse` finding:

```json
{ "hookSpecificOutput": { "hookEventName": "PostToolUse",
                          "additionalContext": "<rule body>" } }
```

Output for a `PreToolUse` interrupt:

```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse",
                          "permissionDecision": "ask",
                          "permissionDecisionReason": "<rule body>" } }
```

**Exit 0 with no output means "no decision".** It is not approval. Every failure
path — unreadable rule, bad regex, missing directory — returns silence. A
broken rule file must never block the person using it.

---

## 7. What text gets matched

Only text the agent is **adding**. Never the file already on disk, and never
text being removed.

| Tool | Field matched |
|---|---|
| `Edit` | `tool_input.new_string` |
| `Write` | `tool_input.content` |
| `MultiEdit` | every `tool_input.edits[].new_string`, joined |

This mirrors omp, and it is why an existing `await import(...)` elsewhere in a
file does not fire the rule while the agent's new line does.

The `scope` glob is matched against `tool_input.file_path`, made relative to
`cwd`.

---

## 8. Once per session

A rule fires at most once per session, like omp's default `repeatMode: once`. A
rule that fires on every edit gets the whole plugin switched off.

State lives in one small JSON file per session:

```
~/.cache/agent-rules/<session_id>.json
```

It holds the list of rule names already fired. Nothing else. If the file cannot
be read or written, the rule fires — being told twice is better than being told
never.

---

## 9. The ten starter rules

Chosen because each one is already written as advice in
`~/.claude/CLAUDE.md` or is a habit worth breaking. A rule earns a check only
after the advice has been ignored.

| Name | `condition` | `scope` |
|---|---|---|
| `py-no-ruff-format` | `ruff format` | `*.py`, `*.toml`, `Makefile` |
| `py-no-bare-except` | `except\s*:` | `*.py` |
| `py-no-print-in-lib` | `^\s*print\(` | `*.py` |
| `rs-no-unwrap` | `\.unwrap\(\)` | `*.rs` |
| `rs-no-panic` | `panic!\(` | `*.rs` |
| `ts-no-any` | `: any\|as any` | `*.ts`, `*.tsx` |
| `ts-no-dynamic-import` | `await import\(` | `*.ts`, `*.tsx` |
| `ts-no-console-log` | `console\.log\(` | `*.ts`, `*.tsx` |
| `md-no-bare-todo` | `TODO(?!\()` | `*.md`, `*.ts`, `*.rs`, `*.py` |
| `no-hardcoded-secret` | `(api_key\|secret\|token)\s*=\s*["'][A-Za-z0-9_\-]{16,}` | all |

`py-no-ruff-format` is the one with a real incident behind it: a session once
ran `ruff format` at 100 characters across 122 files while Zed was set to
`black --line-length 80`.

Each rule needs a body explaining why, what to avoid, and what to use instead.
These regexes are a starting point and will produce false positives; §11 says
what to do about that.

---

## 10. Out of scope for v1

- **`astCondition`.** ast-grep patterns need the ast-grep binary and a language
  map. Regex covers all ten starter rules. Add it when a rule genuinely needs it.
- **Bash rules.** omp only watches `edit` and `write`, so watching Bash would
  make the two readers disagree. Revisit separately.
- **Org scope.** A third level, above global, distributed from somewhere shared.
  Real, but it needs a distribution answer first. Nothing here blocks adding it.
- **Compliance and policy.** Nothing here knows about approvals, evidence or
  audit. A governance tool could compile its own rules down into this format;
  that is its decision, not this tool's.

---

## 11. Where this goes wrong

**False positives are the failure mode.** Ten regexes over every edit will fire
on strings, comments, tests and generated files. The tool gets disabled the
first week if it nags.

Three cheap defences, in order:

1. `interruptMode: never` everywhere, so a wrong rule costs a sentence rather
   than a blocked write.
2. Once per session, so a wrong rule costs that sentence exactly once.
3. Every rule body ends with an `## Exceptions` section naming when it does not
   apply, so the agent can judge rather than obey.

**The second failure is drift.** If omp and the Claude plugin read the same file
differently — flags, glob conversion, which text is matched — then a rule means
two things. §2 and §7 list every place the two must agree. Each one needs a test
against a fixture.

---

## 12. Build order

1. The rule loader and matcher, against payloads recorded from real sessions.
   No hook, no plugin — just "given this payload and these rules, which fire?"
2. The ten rule files. Run the matcher over real recent edits and count false
   positives before wiring anything up.
3. The hook binary and `hooks.json`.
4. The installer symlink.
5. Point omp at the same rules and confirm both agents behave the same.
