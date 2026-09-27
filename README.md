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
  "maxReviewRequests": 4,
  "maxCorrectionsPerEpisode": 2,
  "rules": {
    "reporting.test-result-contradiction": "repair",
    "communication.unexplained-jargon": "observe",
    "reporting.premature-completion": "observe"
  }
}
```

`repair` evaluates and corrects. `observe` evaluates and records without
steering: when an observe policy first fires on new evidence, the user sees
`Agent Rules (observe): <rule> would have fired.` and the agent receives nothing.
`off` skips the policy. Broader starter policies remain observe-only while their useful
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

### Explain a check

Ask the agent to use the **diagnose-rule** skill, or inspect the record directly:

```sh
node dist/agent-rules.js inspect communication.cat-pictures
```

Inspect the recorded judgment before replaying a response. A replay is a new model
evaluation and cannot establish what happened in the original session. `unknown`
means the check abstained; it is not a detected violation. Diagnostics distinguish
missing evidence, an input budget limit, uncertain judgments, and unavailable
evaluation. A large evidence requirement in one rule no longer skips unrelated
small rules in the same review.

Oversized evidence is reviewed in chunks within `maxReviewRequests` (default 4,
maximum 8) and one shared review deadline. Each request stays within the plugin's
24,000-character budget. Small checks retain the normal shared batch; additional
requests cover overflow. Chunk results and coverage are inspectable. Conflicting
results, missing chunks, or capture truncation cannot be reported as a clean bill
of health. Generic aggregation is conservative: all chunks must agree for a clear
or violation outcome; otherwise the result is inconclusive. Probabilities are not
averaged across chunks.

Chunking supports long responses, tool input/output, changed text, and exposed
thinking text. It retains source metadata and short context, with 256-character
overlaps. Oversized fixed instructions/context or an input requiring more chunks
than the call budget remain explicitly inconclusive. This is bounded review, not
an unlimited-context guarantee.

The character budget is our operating limit, not Jev's context limit. TypeSafe's
[model documentation](https://docs.typesafe.ai/models) currently specifies 64k
tokens per request and 32k for state plus the longest question. Chunking keeps
individual calls smaller without treating omitted material as reviewed.

Session journals are the JSON files in the state directory reported by `status`,
not a separate file named `journal`. Bounded review history survives a new user
prompt and includes the review's episode and outcome. Results already erased by
older versions cannot be recovered from the journal.

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
