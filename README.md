# agent-rules

Editable behavioral policies for Claude Code, Codex, and omp. Jev evaluates the work;
the coding agent receives a specific correction and gets another attempt.

Automatic semantic feedback is limited to two deliveries per user episode.
Findings, evidence, and rechecks are inspectable. The original ten regex code
rules remain supported without a TypeSafe key.

## Install

Agent Rules is published to npm as `@jvsteiner/agent-rules`. Installing needs
Node 20.12 or newer and no clone of this repository. The package contains
prebuilt bundles; installed hooks never download other packages.

### 1. Set your TypeSafe key

Jev rules call TypeSafe's Jev model, which needs an API key from
[TypeSafe](https://docs.typesafe.ai/). The hooks read the key only from the
`TYPESAFE_API_KEY` environment variable of the agent process. They never read a
`.env` file, so a project's secrets cannot leak into a review.

Export the key in your shell profile, for example `~/.zshrc`, then open a new
terminal so Claude Code, Codex, and omp start with it:

```sh
export TYPESAFE_API_KEY=your-key
```

For Claude Code only, the key can instead go in `~/.claude/settings.json` under
`"env"`. Without a key, each session starts with the notice
`Agent Rules: TYPESAFE_API_KEY is not set`, Jev rules do nothing, and regex
rules still run.

### 2. Install in each agent

Claude Code:

```sh
claude plugin marketplace add jvsteiner/agent-rules
claude plugin install agent-rules@agent-rules
```

Codex:

```sh
codex plugin marketplace add jvsteiner/agent-rules
codex plugin add agent-rules@agent-rules
```

Codex runs a plugin's hooks only after you trust them. Open Codex, run `/hooks`,
and trust the seven Agent Rules hooks.

omp:

```sh
npx @jvsteiner/agent-rules install-omp
```

This copies the package to `~/.omp/agent/agent-rules/`, writes the extension
`~/.omp/agent/extensions/agent-rules.js`, and links the `author-rule` and
`diagnose-rule` skills and the regex rules into `~/.omp/agent/`. It leaves any
real folder already at those paths unchanged. omp enforces the regex rules itself
through its TTSR feature, so the extension runs only the Jev policies.

Restart open sessions after installing.

### Update

```sh
claude plugin marketplace update agent-rules && claude plugin update agent-rules@agent-rules
codex plugin add agent-rules@agent-rules
npx @jvsteiner/agent-rules@latest install-omp
```

Restart open sessions afterwards. If an update changes Codex's hook file, trust
the hooks again in `/hooks`.

### Uninstall

```sh
claude plugin uninstall agent-rules@agent-rules
codex plugin remove agent-rules@agent-rules
rm -r ~/.omp/agent/agent-rules ~/.omp/agent/extensions/agent-rules.js \
  ~/.omp/agent/skills/author-rule ~/.omp/agent/skills/diagnose-rule ~/.omp/agent/rules
```

Only remove `~/.omp/agent/rules` if it is the link the installer created.

### Where rules live

All three agents run the same hook and read the same rule folders on every event,
so a saved rule applies on the next prompt, tool call, or reply, with no build or
restart:

- `~/.config/agent-rules/rules/`: your rules for every project, with modes in
  `~/.config/agent-rules/config.json`.
- `<project>/.agent-rules/rules/`: rules for one project, with modes in
  `<project>/.agent-rules/config.json`.
- The package's own `policies/` and `rules/` folders: starter rules that ship
  with each release.

The command-line tool runs as `npx @jvsteiner/agent-rules <command>`; in a
checkout, `node dist/agent-rules.js <command>` is the same tool.

## Development

Work from a clone. The [Makefile](Makefile) runs every task with absolute paths
built from `$(PWD)`, so run `make` from the repository root. It works with the
GNU Make 3.81 that ships with macOS.

```sh
make deps            # npm ci, which also builds
make test            # build and run the full test suite
make check           # tests plus validation of the bundled policies
make status          # effective policies, modes, and whether the key is set
make install-local   # install this checkout into Claude Code, Codex, and omp
```

`make build` bundles `dist/` and assembles `plugin/`, which Git ignores.
`plugin/` holds only what an install needs: manifests, hooks, bundles,
policies, regex rules, skills, and the omp extension. It is both the npm package
and a local marketplace: `make install-local` registers `plugin/` as the
`agent-rules` marketplace in Claude Code and Codex, installs from it, and
installs omp with its regex rules linked to this checkout's `rules/`, so rule
edits apply at once. It replaces an `agent-rules` marketplace that points at the
published package. After changing code, hooks, skills, or `policies/`, run
`make install-local` again and restart open sessions.

For development, the repository's ignored `.env` can hold `TYPESAFE_API_KEY`.
Only explicit commands read it: CLI calls with `--env-file .env`, and the
launcher `node tools/with-key.mjs .env claude --plugin-dir plugin`, which
parses the file without evaluating it as shell code.

The manifests select separate hook files: `hooks/claude.json` and
`hooks/codex.json`. The default `hooks/hooks.json` is empty so no host
registers the hooks twice. The package has no root `plugin.json`: Codex reads a
root `plugin.json` before `.codex-plugin/plugin.json` and would find no hooks.

## Release

Releases publish `plugin/` to npm as `@jvsteiner/agent-rules`. Both marketplace
files in this repository (`.claude-plugin/marketplace.json` and
`.agents/plugins/marketplace.json`) install that npm package, so a release
reaches users through their normal update commands.

One-time setup: `npm login` with an account that can publish the
`@jvsteiner` scope, and `gh auth login` for GitHub.

```sh
make release                 # patch release
make release BUMP=minor      # or minor, or major
```

`make release` runs these steps in order, and each can also run on its own:

1. `make release-check` refuses to continue unless the tree is clean, the
   branch is `main` and in sync with `origin/main`, and npm and gh are logged in.
2. `make release-bump` bumps the version in `package.json`, which also updates
   the plugin manifests and marketplace entries through the build, then runs the
   tests, validates the bundled policies, commits `release: vX.Y.Z`, and tags
   `vX.Y.Z`.
3. `make release-publish` publishes `plugin/` to npm, then pushes `main` and
   the tag.
4. `make release-github` creates the GitHub release for the tag, with generated
   notes and the npm tarball attached.

If a step fails, fix the cause and rerun that step. `make pack` writes the npm
tarball to `.release/` without publishing, to inspect exactly what ships.

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

Each policy has one of four modes:

- `off`: the policy does not run.
- `observe`: the policy runs and records. When it first fires on new evidence,
  the user sees `Agent Rules (observe): <rule> would have fired.` and the agent
  receives nothing.
- `repair`: the agent receives the correction and fixes its work.
- `block`: like `repair`, and a request policy also rejects the prompt, so the
  model never sees it. Use it when the model must not act on a request at all;
  a correction is advice that a model can ignore.

Broader starter policies remain observe-only while their useful operating
thresholds are evaluated. Probabilities do not establish intent.

A policy's `events` and `target` choose when it acts, in Claude Code, Codex, and
omp alike:

- `user_prompt` + `request`: checks the request before work starts; a repair
  finding adds the correction as context, and a block finding rejects the
  prompt.
- `tool_start` + `tool_call`: checks each tool call before it runs; a repair or
  block finding denies the call. Denials repeat for every matching call and do
  not use up the correction limit.
- `tool_result` + `code_change`: checks completed edits; a repair finding adds
  context.
- `response_end` + `response`: checks the finished reply; a repair finding stops
  the turn for a rewrite.

Prompt and pre-tool checks cost one Jev request per prompt or tool call and run
only when an enabled policy uses them. Rewrites and added context share the
per-request correction limit; rejected prompts and denied tool calls do not.

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

Each event is one Jev request: the shared evidence is sent once, rules that judge the
same text share one candidate entry, and each rule adds only its question. A request
may hold up to 80,000 characters, below Jev's limit of 32k tokens for the state and
the longest question. Evidence larger than that is reviewed in chunks within
`maxReviewRequests` (default 4, maximum 8) and one shared review deadline. Chunk
results and coverage are inspectable. Conflicting results, missing chunks, or
capture truncation cannot be reported as a clean bill of health. Generic
aggregation is conservative: all chunks must agree for a clear or violation
outcome; otherwise the result is inconclusive. Probabilities are not averaged
across chunks.

Jev charges per input token, and question text counts. A policy's `prefilter`
pattern runs locally first; when it matches none of the candidates, the rule is
clear without a Jev call. Tool and request rules should always have one, so that
reads, tests, and other calls no rule concerns cost nothing.

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
