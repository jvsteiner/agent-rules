# Live test

A clean sample project, and a cut sheet for checking the rules really fire.

Nothing here trips a rule as it stands — that is the point. You ask an agent to
write something bad, and watch what happens.

```
live-test/
  src/app.ts     TypeScript
  src/lib.py     Python
  src/lib.rs     Rust
  Makefile
```

---

## 0. Turn it on

One symlink, into omp's **global** rule directory — the level omp's own menu
calls *"Global — all projects"*. That makes the rules apply in every repository
on the machine. Nothing is written into any repository.

```sh
ls -ld ~/.omp/agent/rules                              # expect: No such file
ln -s ~/Code/agent-rules/rules ~/.omp/agent/rules
```

(The other level, `<repo>/.omp/rules`, is for a rule that should apply to one
repository only. You write those by hand when you want one. Both agents read
both directories, and a project rule replaces a global one of the same name.)

Then, in a Claude Code terminal:

```
/plugin marketplace add ~/Code/agent-rules
/plugin install agent-rules@agent-rules
```

**Restart the session afterwards.** Hooks load at session start.

---

## 1. Smoke test — 30 seconds, no agent needed

Does the hook work at all? This works from any directory, including this one:

```sh
node ~/Code/agent-rules/tools/smoke.mjs
```

You should see `10 rules loaded` and then the `ts-no-any` rule body printed
back, ending in `OK`.

It reports on two directories. The **global** one must say `found`. The project
one, `<cwd>/.omp/rules`, says `missing` unless you have written a rule for that
one repository — which is normal and fine.

If it says `no rules found`, the symlink in step 0 is missing or nested.

---

## 2. The cut sheet

One row per rule. Say the thing in the middle column to your agent. Watch for
the rule name.

**Do it in a fresh session each time, or read §3 first.**

| # | Rule | Say this | Expect |
|---|---|---|---|
| 1 | `ts-no-any` | "In `live-test/src/app.ts`, add a `handle` function that takes a payload of type `any` and returns it." | `ts-no-any`, then the agent switches to `unknown` |
| 2 | `ts-no-dynamic-import` | "In `live-test/src/app.ts`, load `node:path` with a dynamic import inside a function." | `ts-no-dynamic-import`, then a static import |
| 3 | `ts-no-console-log` | "In `live-test/src/app.ts`, log the row count with `console.log`." | `ts-no-console-log` |
| 4 | `py-no-print-in-lib` | "In `live-test/src/lib.py`, print the row count after loading." | `py-no-print-in-lib`, then `log.info` |
| 5 | `py-no-bare-except` | "In `live-test/src/lib.py`, wrap the parse in a try/except with a bare `except:`." | `py-no-bare-except` |
| 6 | `py-no-ruff-format` | "In `live-test/Makefile`, change the `fmt` target to run `ruff format`." | `py-no-ruff-format`, then back to `black` |
| 7 | `rs-no-unwrap` | "In `live-test/src/lib.rs`, add a `must_parse` function that uses `.unwrap()`." | `rs-no-unwrap`, then `?` or `expect` |
| 8 | `rs-no-panic` | "In `live-test/src/lib.rs`, make `divide` panic when the divisor is zero." | `rs-no-panic` |
| 9 | `no-bare-todo` | "In `live-test/src/lib.rs`, add a TODO comment saying the retry path is missing." | `no-bare-todo`, then `TODO(#nnn)` |
| 10 | `no-hardcoded-secret` | "In `live-test/src/lib.py`, add an `API_KEY` constant set to the literal `EXAMPLE_NOT_A_REAL_KEY_0000000`." | `no-hardcoded-secret`, then `os.environ` |

### What a pass looks like

The write **lands**, then the agent is handed the rule and fixes it in the same
turn. You will usually see the bad line appear and then be corrected. That is
the design working, not a bug.

### If the agent refuses before writing anything

Some of these it already knows not to do, from your `CLAUDE.md`. That is the
advice working, not the rule. Say **"do it anyway, I am testing a hook"** and
try again.

### If nothing happens

In order, cheapest first:

1. Did you restart the session after installing the plugin?
2. Does `ls -l ~/.omp/agent/rules` show the symlink?
3. Run the smoke test in §1.
4. `rm -f ~/.cache/agent-rules/*.json` — see §3.

---

## 3. The one gotcha: once per session

**A rule fires once per session and then goes quiet.** Test `ts-no-any` twice in
one session and you only see it once. That is deliberate — a rule that fires on
every edit gets the plugin switched off.

To test the same rule again without starting a new session:

```sh
rm -f ~/.cache/agent-rules/*.json
```

---

## 4. Testing the interrupt path

All ten shipped rules let the write land. To see the other path — the write
stopped, and a person asked — make one rule interrupting for a moment:

```sh
sed -i '' 's/^interruptMode: never/interruptMode: always/' rules/ts-no-console-log.md
```

Restart the session, run row 3, and you should be **asked to approve the write**
instead of told afterwards. Then put it back:

```sh
sed -i '' 's/^interruptMode: always/interruptMode: never/' rules/ts-no-console-log.md
```

---

## 5. The real test: do both agents agree?

This is the one risk in the whole design. If omp and Claude Code read the same
file differently, a rule quietly means two things.

Run the **same row** in both agents and compare:

| | omp | Claude Code |
|---|---|---|
| Did the rule fire? | | |
| Same rule name? | | |
| Same text shown? | | |
| Fired once, or every edit? | | |

Rows 1, 7 and 10 are the ones worth doing in both. Row 10 especially — its
regex is the one that has already been wrong once.

---

## 6. Write down what nagged

The failure mode is not a rule that misses. It is a rule that fires when it
should not, until you switch the whole thing off.

For each firing, note one of:

- **right** — it caught a real mistake
- **noise** — technically correct, but you did not want telling
- **wrong** — it should not have matched at all

Anything marked noise or wrong needs its `condition` tightened or its
`## Exceptions` section extended. Check the change with:

```sh
node tools/dryrun.mjs ~/Code/gbuild ~/Code/quayside
```
