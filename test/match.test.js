import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compileCondition, loadRules, normalise, parseRule } from "../src/rules.js";
import { addedText, globToRegExp, matchPayload, pathMatches, relativeTo } from "../src/match.js";

const here = dirname(fileURLToPath(import.meta.url));
const ruleDir = join(here, "fixtures", "rules");
const hookDir = join(here, "fixtures", "hooks");

const fixtureRules = () => loadRules([ruleDir]).rules;
const readRule = (n) => parseRule(n, readFileSync(join(ruleDir, `${n}.md`), "utf8"));

const edit = (file_path, new_string, extra = {}) => ({
  session_id: "s",
  cwd: "/repo",
  hook_event_name: "PreToolUse",
  tool_name: "Edit",
  tool_input: { file_path, old_string: "", new_string, ...extra },
});

// --- front matter, against a verbatim omp rule file -------------------------

test("an omp rule file round-trips", () => {
  const r = readRule("ts-no-dynamic-import");
  assert.equal(r.conditions.length, 1);
  assert.ok(r.conditions[0].test('const x = await import("y")'));
  assert.equal(r.scopes.length, 4);
  assert.deepEqual(r.scopes[0], { tool: "edit", glob: "*.ts" });
  assert.equal(r.delivery, "post");
  assert.ok(r.body.startsWith("Use static imports"));
});

test("interruptMode drives delivery, and absent means post", () => {
  assert.equal(parseRule("x", "---\ncondition: a\n---\nb\n").delivery, "post");
  assert.equal(
    parseRule("x", "---\ncondition: a\ninterruptMode: always\n---\nb\n").delivery,
    "pre",
  );
});

// --- omp's own normalisation quirks -----------------------------------------

test("a condition that is really a glob becomes an edit+write scope", () => {
  const n = normalise({ condition: "*.ts" });
  assert.deepEqual(n.condition, [".*"]);
  assert.deepEqual(n.scope, ["tool:edit(*.ts)", "tool:write(*.ts)"]);
});

test("a regex containing a slash is swallowed as a glob, loudly", () => {
  // omp reads any condition containing "/" as a file glob, so a regex with a
  // character class like [A-Za-z0-9/+] silently becomes `.*` and matches every
  // edit. This cost a rule that fired on all 1,044 files in a dry run. The
  // behaviour is kept identical to omp; only the warning is ours.
  const n = normalise({ condition: "(secret)\\s*=\\s*[A-Za-z0-9/+]{16,}" });
  assert.deepEqual(n.condition, [".*"]);
  assert.equal(n.notes.length, 1);
  assert.match(n.notes[0], /matches every edit/);
});

test("an ordinary file glob converts without a warning", () => {
  assert.deepEqual(normalise({ condition: "src/*.ts" }).notes, []);
});

test("ttsr_trigger is accepted as an alias for condition", () => {
  assert.deepEqual(normalise({ ttsr_trigger: "foo" }).condition, ["foo"]);
});

test("an inline flag prefix is lifted onto the regex", () => {
  assert.equal(compileCondition("(?i)todo").flags, "i");
  assert.ok(compileCondition("(?i)todo").test("TODO"));
  // Not a recognised flag set, so it stays a literal group — and `(?x)` is not
  // valid JavaScript, so the rule throws and `loadRules` reports it as broken.
  // omp compiles the same string the same way, so both agents reject it.
  assert.throws(() => compileCondition("(?x)a"), SyntaxError);
  assert.equal(compileCondition("(?:x)a").flags, "");
});

// --- globs -------------------------------------------------------------------

test("a glob with no slash matches the file name anywhere", () => {
  assert.ok(pathMatches("*.ts", "src/deep/a.ts"));
  assert.ok(!pathMatches("*.ts", "src/a.tsx"));
});

test("a glob with a slash matches the relative path", () => {
  assert.ok(pathMatches("src/**/*.rs", "src/a/b.rs"));
  assert.ok(!pathMatches("src/**/*.rs", "lib/a.rs"));
});

test("braces are alternation, commas outside them are literal", () => {
  assert.ok(globToRegExp("*.{ts,tsx}").test("a.tsx"));
  assert.ok(globToRegExp("a,b.ts").test("a,b.ts"));
});

test("relativeTo strips the cwd", () => {
  assert.equal(relativeTo("/repo", "/repo/src/a.ts"), "src/a.ts");
  assert.equal(relativeTo("/repo", "/other/a.ts"), "/other/a.ts");
});

// --- which text is matched ---------------------------------------------------

test("Edit matches the new text and ignores the removed text", () => {
  const rules = fixtureRules();
  const removing = edit("/repo/a.ts", "const x = 1;", {
    old_string: 'await import("gone")',
  });
  assert.deepEqual(matchPayload(removing, rules), []);

  const adding = edit("/repo/a.ts", 'await import("new")');
  assert.deepEqual(matchPayload(adding, rules).map((f) => f.name), [
    "ts-no-dynamic-import",
  ]);
});

test("Write reads content, MultiEdit reads every new_string", () => {
  assert.equal(
    addedText({ tool_name: "Write", tool_input: { content: "hi" } }),
    "hi",
  );
  assert.equal(
    addedText({
      tool_name: "MultiEdit",
      tool_input: { edits: [{ new_string: "a" }, { new_string: "b" }] },
    }),
    "a\nb",
  );
});

test("an unwatched tool fires nothing", () => {
  const p = { tool_name: "Bash", tool_input: { command: "await import(x)" } };
  assert.deepEqual(matchPayload(p, fixtureRules()), []);
});

// --- scope -------------------------------------------------------------------

test("a rule scoped to .ts does not fire on .rs", () => {
  const fired = matchPayload(edit("/repo/a.rs", 'await import("x")'), fixtureRules());
  assert.deepEqual(fired, []);
});

test("rules are independent — only the matching one fires", () => {
  const fired = matchPayload(edit("/repo/a.rs", "let x = y.unwrap();"), fixtureRules());
  assert.deepEqual(fired.map((f) => f.name), ["rs-no-unwrap"]);
  assert.equal(fired[0].delivery, "post");
});

// --- loading -----------------------------------------------------------------

test("a later directory wins on a name clash", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-rules-"));
  const a = join(root, "a");
  const b = join(root, "b");
  mkdirSync(a);
  mkdirSync(b);
  writeFileSync(join(a, "dup.md"), "---\ncondition: global\n---\nfrom global\n");
  writeFileSync(join(b, "dup.md"), "---\ncondition: project\n---\nfrom project\n");

  const { rules } = loadRules([a, b]);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].body, "from project");
});

test("a broken rule is a warning, not a crash", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-rules-"));
  writeFileSync(join(root, "ok.md"), "---\ncondition: fine\n---\nbody\n");
  writeFileSync(join(root, "broken.md"), "no front matter at all\n");
  writeFileSync(join(root, "nocond.md"), "---\ndescription: x\n---\nbody\n");

  const { rules, warnings } = loadRules([root]);
  assert.deepEqual(rules.map((r) => r.name), ["ok"]);
  assert.equal(warnings.length, 2);
});

test("a missing directory is empty, not an error", () => {
  assert.deepEqual(loadRules([join(tmpdir(), "does-not-exist-xyz")]), {
    rules: [],
    warnings: [],
  });
});

// --- recorded payloads from real sessions ------------------------------------

// The recorded files are named by index, not by tool: -2 is actually a Write.
// That is useful — the corpus covers both shapes.
test("every recorded payload is handled", () => {
  const rules = fixtureRules();
  for (const n of [0, 1, 2]) {
    const p = JSON.parse(readFileSync(join(hookDir, `PreToolUse-Edit-${n}.json`), "utf8"));
    assert.equal(p.hook_event_name, "PreToolUse");
    assert.ok(typeof addedText(p) === "string", `payload ${n} has added text`);
    assert.deepEqual(matchPayload(p, rules), [], `payload ${n} fires nothing`);
  }
});
