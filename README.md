# agent-rules

One set of rule files. Two readers.

A rule says "do not write this, write that instead". When a coding agent is
about to write code that matches it, the agent gets told — in the same turn,
before the mistake reaches a pull request.

[omp](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent) has this
built in and calls it TTSR. Claude Code does not, but its hooks can reproduce
the part that matters. This repository holds the rules, and the Claude Code
plugin that reads them.

**The format is omp's, unchanged.** So omp needs nothing from this repository
beyond the files themselves.

---

## State

| | |
|---|---|
| Rule loader and matcher | **Built** |
| The ten starter rules | **Written**, each with a firing case and a quiet case |
| Claude Code plugin and hooks | **Built**, ~29 ms per write |
| Installer | Not built — one symlink, see below |
| Live test harness | **Built** — `live-test/` |

56 tests.

The design is [`docs/2026-09-11-agent-rules-design.md`](docs/2026-09-11-agent-rules-design.md).

```sh
npm test                                  # 56 tests
node tools/smoke.mjs                      # is the hook wired up?
node tools/dryrun.mjs ~/Code/some-repo    # what would the rules fire on?
```

[`live-test/`](live-test/README.md) is a clean sample project and a cut sheet —
one row per rule, what to say to the agent, and what should happen.

No dependencies, no build step. Node 20 or newer.

## Install

Point omp at the rules — one symlink, and omp needs nothing else:

```sh
ln -s ~/Code/agent-rules/rules ~/.omp/agent/rules
```

Then add the Claude Code plugin from the checkout:

```
/plugin marketplace add ~/Code/agent-rules
/plugin install agent-rules@agent-rules
```

The plugin reads the same two directories omp does, so both agents behave the
same way. Until the symlink exists, the hook finds no rules and stays silent.

---

## A rule

```yaml
---
description: "Do not use `await import()` — use static imports"
condition: "await import\\("
scope: "tool:edit(*.ts), tool:write(*.ts)"
interruptMode: never
---

Use static imports for modules known at author time.

## Why
- Static imports fail during build, not under load.

## Exceptions
- Plugin loading from a runtime registry.
```

`condition` is a regex, matched against **only the text the agent is adding** —
never the file on disk, and never the text being removed. `scope` says which
tool and which files. The body is what the agent is told when the rule fires.

`interruptMode: never` — the default, and what every omp builtin uses — lets
the write land and tells the agent afterwards, so it fixes the line in the same
turn. Anything else stops the write and asks a person.

---

## Where rules live

Both readers look in the same two places, in this order:

| Level | Path | Scope |
|---|---|---|
| Global | `~/.omp/agent/rules/*.md` | Every repository on the machine |
| Project | `<repo>/.omp/rules/*.md` | That repository only |

A project rule replaces a global one of the same name.

Project rules should not be committed, because colleagues do not have this
plugin and should not receive an unexplained `.omp/` folder. Put the ignore in
`.git/info/exclude`, **not** `.gitignore` — `.gitignore` is itself tracked, so
editing it is a change other people see.

---

## Licence

MIT.
