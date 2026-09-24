# agent-rules

Editable behavioral policies for Claude Code and Codex. Jev evaluates the work;
the coding agent receives a specific correction and gets another attempt.

Automatic semantic feedback is limited to two deliveries per user episode.
Findings, evidence, and rechecks are inspectable. The original ten regex code
rules remain supported without a TypeSafe key.

## Quick start

Node 20.12 or newer is required. Committed `dist/` bundles include the runtime
and YAML dependency; installed hooks never download packages.

```sh
npm ci
npm test
node dist/agent-rules.js status --env-file .env
node tools/with-key.mjs .env claude --plugin-dir .
```

The explicit launcher parses the specified `.env` and passes `TYPESAFE_API_KEY`
to the agent. It never evaluates the file as shell code. Hooks normally use the
agent process environment and never automatically load a target project's `.env`.
This checkout's `.env` is ignored by Git.

For normal Claude installation, add this checkout as a marketplace and install
`agent-rules@agent-rules`. Codex packaging is in `plugin.json` and
`.codex-plugin/plugin.json`; install through a configured marketplace and review
its hooks with `/hooks`. Installation does not bypass host trust review.

For direct Codex hook setup, use `hooks/codex.json`, replacing `${PLUGIN_ROOT}`
with the absolute checkout path when configuring hooks outside a plugin.
The platform manifests select separate hook files. Default `hooks/hooks.json`
is intentionally empty to avoid duplicate registration. The original
`bin/agent-rules-hook.js` remains usable for legacy omp-compatible setups.

## Authoring and configuration

Ask the agent to use the **author-rule** skill to turn a preference into a Markdown
policy, Jev questions, examples, and an evaluation report. Generated labels remain
identified as generated; they are not claimed to be human validation.

Policies load from bundled `policies/`, `~/.config/agent-rules/rules/`, then
`<project>/.agent-rules/rules/`. Later IDs override earlier ones. An invalid
override disables its ID and produces diagnostics.

Configuration lives in `~/.config/agent-rules/config.json` or project
`.agent-rules/config.json`:

```json
{
  "schema": "agent-rules/config-v1",
  "model": "jev-1.13.0",
  "reviewDeadlineMs": 2000,
  "maxCorrectionsPerEpisode": 2,
  "rules": {
    "reporting.test-result-contradiction": "repair",
    "communication.unexplained-jargon": "observe",
    "reporting.premature-completion": "observe"
  }
}
```

`repair` evaluates and corrects, `observe` records without steering, and `off`
skips the policy. Broader starter policies remain observe-only while their useful
operating thresholds are evaluated. Probabilities do not establish intent.

```sh
node dist/agent-rules.js validate policies
node dist/agent-rules.js evaluate policies/test-result-contradiction.md \
  --fixtures policies/test-result-contradiction.cases.jsonl \
  --live --env-file .env --out /tmp/report.json
node dist/agent-rules.js evaluate policies/test-result-contradiction.md \
  --fixtures policies/test-result-contradiction.cases.jsonl --replay /tmp/report.json
node dist/agent-rules.js compare /tmp/before.json /tmp/after.json
node dist/agent-rules.js inspect reporting.test-result-contradiction
node dist/agent-rules.js set-mode communication.unexplained-jargon repair --scope project
```

Offline evaluation requires a matching replay and never silently calls Jev.
Reports bind results to model, policy hash, and evidence; mismatches with fixture
labels produce a nonzero exit, including unexpected abstentions.
See the [policy format](skills/author-rule/references/policy-format.md).

## Verification and actual limits

Deterministic tests cover legacy rules, catalogs, transport, real hook subprocesses,
concurrent journals, correction budgets, stale results, service failures, and
copied bundles running without `node_modules`. CI uses Node 20 and 24.

Explicit live probes use authenticated accounts and small synthetic tasks in
isolated temporary workspaces; they do not install global hooks:

```sh
node tools/host-probe.mjs claude --live --env-file .env
node tools/host-probe.mjs codex --live --env-file .env
node tools/host-probe.mjs codex --live --receipts --env-file .env
```

Both CLIs have completed Jev-triggered corrections and rechecks. Claude's headless
stream displays notices. The tested Codex `exec --json` omits `systemMessage`,
although correction works; use `inspect` for findings. Interactive/desktop notice
rendering has not been confirmed here.

The engine accepts explicitly exposed thinking segments with provenance and
completeness labels. Ordinary hook payloads observed in both hosts contain no
thinking text; automatic transcript extraction is not claimed. Semantic code
checks cover supported direct edits/patches, not universal shell-write attribution.
Curated generated cases demonstrate particular behavior, not general accuracy.

Selected response/code/evidence is sent to TypeSafe. Obvious secret patterns are
redacted; this is not comprehensive data-loss prevention. Journals have private
file permissions, bounded history, and cleanup of expired/excess inactive snapshots.

## Documents

- [Implementation plan](docs/2026-09-24-implementation-plan.md)
- [Implementation evidence and limitations](docs/2026-09-24-implementation-results.md)
- [Design](docs/2026-09-24-behavior-steering-design.md)
- [Research](docs/2026-09-24-jev-behavior-steering-research.md)
- [Original regex/omp design](docs/2026-09-11-agent-rules-design.md)

MIT licensed.
