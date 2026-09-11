// Every shipped rule, checked both ways: it fires on a real violation, and it
// stays quiet on the corrected version. Four of the ten never fired across
// 1,044 recent file-changes, which is good news about the code and no evidence
// at all that those rules work — hence the positive case for each.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadRules } from "../src/rules.js";
import { matchPayload } from "../src/match.js";

const ruleDir = join(dirname(fileURLToPath(import.meta.url)), "..", "rules");
const { rules, warnings } = loadRules([ruleDir]);

const fired = (file, text) =>
  matchPayload(
    {
      cwd: "/repo",
      tool_name: "Edit",
      tool_input: { file_path: `/repo/${file}`, old_string: "", new_string: text },
    },
    rules,
  ).map((f) => f.name);

/** [rule, file, text that must fire, text that must not] */
const CASES = [
  ["py-no-ruff-format", "Makefile", "\truff format .", "\tblack ."],
  ["py-no-bare-except", "a.py", "try:\n    x()\nexcept:\n    pass", "except ValueError:"],
  ["py-no-print-in-lib", "a.py", 'print("hi")', 'log.info("hi")'],
  ["rs-no-unwrap", "a.rs", "let c = read().unwrap();", "let c = read()?;"],
  ["rs-no-panic", "a.rs", 'panic!("empty");', "return Err(E::Empty);"],
  ["ts-no-any", "a.ts", "function f(x: any) {}", "function f(x: unknown) {}"],
  ["ts-no-dynamic-import", "a.ts", 'const m = await import("sdk");', 'import { m } from "sdk";'],
  ["ts-no-console-log", "a.ts", 'console.log("hi");', 'logger.debug("hi");'],
  ["no-bare-todo", "a.rs", "// TODO: retry", "// TODO(#412): retry"],
  [
    "no-hardcoded-secret",
    "a.py",
    'API_KEY = "EXAMPLE_NOT_A_REAL_KEY_0000000"',
    'API_KEY = os.environ["API_KEY"]',
  ],
];

test("the rules directory loads with no warnings", () => {
  assert.deepEqual(warnings, []);
  assert.equal(rules.length, CASES.length);
});

test("every rule is covered by a case", () => {
  assert.deepEqual(
    rules.map((r) => r.name).sort(),
    CASES.map((c) => c[0]).sort(),
  );
});

for (const [name, file, bad, good] of CASES) {
  test(`${name} fires on a violation`, () => {
    assert.ok(fired(file, bad).includes(name), `expected ${name} on: ${bad}`);
  });

  test(`${name} is quiet on the fix`, () => {
    assert.ok(!fired(file, good).includes(name), `unexpected ${name} on: ${good}`);
  });
}

test("every rule lets the write land rather than blocking it", () => {
  for (const r of rules) assert.equal(r.delivery, "post", r.name);
});

test("every rule body names its exceptions", () => {
  for (const r of rules) {
    assert.match(r.body, /^## (Exceptions|If one is already committed)$/m, r.name);
  }
});

// The two false-positive shapes the dry run over real repositories exposed.
test("prose about TODOs is not a bare TODO", () => {
  assert.deepEqual(fired("a.ts", "// lists the open TODOs left behind"), []);
});

test("a sentence mentioning a token is not a hardcoded secret", () => {
  assert.deepEqual(fired("a.md", "The token is read from the environment."), []);
});
