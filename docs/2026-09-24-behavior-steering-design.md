# Agent Rules: behavior steering with Jev

Status: proposed implementation design. No runtime changes are included.

This document defines the next version of this project. It supersedes the
omp-only compatibility requirement in the September 11 design, while preserving
the existing deterministic rules. Platform and TypeSafe facts are documented in
[the research brief](2026-09-24-jev-behavior-steering-research.md).

## 1. Product decisions

Agent Rules observes a coding agent's work, recognizes specific undesirable
behaviors, and asks the agent to correct them. It runs as a Claude Code or Codex
plugin. Jev supplies typed judgments; the working Claude/GPT model performs the
correction and helps the user author new rules.

Decisions established with the user:

- Rules remain editable Markdown files.
- An authoring skill helps turn preferences into Jev questions and examples.
- Automatic correction is the normal intervention, with a strict retry limit.
- The user sees the original behavior, the plugin firing, and the correction.
  Visibility is a feature: users should be able to judge the technique themselves.
- Thinking exposed by the host is also auditable, with its provenance and
  completeness recorded separately from user-facing answers and executed actions.
- Existing code checks remain useful alongside semantic behavioral checks.

Design defaults chosen here:

- One local Node runtime, separate platform adapters, no daemon or hosted control
  plane. Retain JavaScript ESM and use JSDoc types; a TypeScript migration is not
  required for this work.
- At most two correction deliveries per user episode across all semantic rules,
  including post-tool nudges and Stop continuations. Rechecks do not consume a
  correction unless they deliver new repair instructions.
- Jev does not grant permissions, infer malicious intent, or certify truth.
- Checks distinguish clean, violation, unknown, and unavailable.
- First release targets main-agent sessions in the two local CLIs. Desktop
  support is declared only after its visibility and hook behavior are verified.
  Subagent enforcement is deferred; ordinary subagent output can be evidence.

## 2. User experience

The ordinary loop is:

1. The agent responds or changes code.
2. Agent Rules checks applicable policies against relevant evidence.
3. A concise plugin notice identifies a finding and the correction attempt.
4. The agent corrects the answer or continues the requested work.
5. The plugin rechecks and reports the outcome.

Example:

```text
Agent: All tests passed.

Agent Rules · verification claim · correction 1/2
The recorded test command failed, which conflicts with that statement.

Agent: The tests failed in … [corrected account and appropriate follow-up]

Agent Rules · verification claim
Recheck: the conflicting claim is no longer present.
```

The plugin emits the notice through supported hook output. It does not rely on
the agent voluntarily acknowledging a finding. Agent-facing feedback is separate
and gives an actionable correction. Do not duplicate full policies in notices.

Report what a recheck establishes. "Conflicting claim removed" is different
from "tests now pass". When evidence is unavailable, report that the result is
unknown. At the retry limit, say the finding remains unresolved and allow the
turn to finish. Do not make the agent argue with the reviewer.

Routine clean checks stay quiet. Changes to health state, such as missing
credentials or a disabled invalid rule, produce one concise diagnostic rather
than a notice on every tool call. An inspect command exposes the exact rule,
selected evidence, judgment, threshold, model version, and intervention history.

## 3. Runtime modules and interfaces

The runtime has four deep modules and a platform adapter seam. These are logical
modules; individual functions do not each need their own file or abstraction.

```text
                       authoring / evaluation CLI
                          |             |
                          v             v
platform adapter ---> PolicyCatalog   ReviewEngine
       |                                 ^
       v                                 |
SessionRuntime --------------------------+
       |
       v
platform-specific notice and model feedback
```

### PolicyCatalog

Interface: `loadPolicies(config, projectRoot) -> PolicySet + diagnostics`.

Owns discovery, full YAML parsing, validation, overrides, legacy import,
enabled/observe state, content hashes, and mapping Markdown sections to repair
instructions. Callers receive normalized immutable policies and never parse
frontmatter or merge directories themselves.

An invalid higher-precedence override disables that policy with a diagnostic;
it must not silently reactivate the lower-precedence definition. Duplicate IDs
within one source are errors. Diagnostics identify source and field.

### ReviewEngine

Interface: `review(snapshot, policySet, { signal }) -> ReviewResult`.

Owns eligibility, evidence projection, detector execution, Jev batching, result
validation, and mapping raw answers to findings. It does not render hook JSON,
write session state, or tell an agent to continue. The production runtime and
the evaluation CLI call this same interface.

The detector seam has two real adapters: existing deterministic matching and
Jev evaluation. It accepts immutable prepared evidence and returns judgments.
HTTP transport and replay transport are implementations used behind the Jev
adapter, not separate public review workflows.

### SessionRuntime

Interface: `handle(event, context) -> Effect`.

Owns episode identity, bounded evidence collection, concurrency, review scheduling,
finding history, correction budgets, stale-result rejection, feedback assembly,
and persistence. Its context supplies PolicyCatalog, ReviewEngine, storage, and a
clock, allowing the complete event sequence to be exercised through one interface.

`Effect` contains a user notice, optional model correction, and an abstract action:
`none`, `add_context`, or `continue_turn`. Legacy deterministic pre-tool decisions
remain a separately identified compatibility path, not an action Jev can select.

### AuthoringWorkbench

Interface: `evaluate(policyFiles, fixtureFiles, options) -> EvaluationReport`.

Owns fixture loading, expected-outcome comparison, model/policy version tracking,
and comparison against earlier reports. Calls ReviewEngine. The authoring skill
uses this interface through a CLI and handles the generative work itself.
No generative-model credentials or additional generative API integration are
required: the user's working agent is the author.

### Platform adapters

Interface: `decode(payload) -> Event | Unsupported` and
`encode(effect, capabilities) -> HookReply`.

Claude and Codex adapters own payload interpretation, capability detection,
tool names, user-visible output, and event-specific continuation semantics.
They never decide whether the content violates a policy.

An unsupported payload produces an explicit coverage diagnostic. Do not guess
that a patch is a Claude edit or classify the whole serialized tool call as code.

## 4. Normalized events and evidence

The normalized event carries:

```text
platform, sessionId, actorId, observedEventId, hostTurnId?
kind: session_start | user_prompt | tool_start | tool_result |
      thinking_observed | response_end | interrupt | session_end
cwd, projectRoot, receivedAt
source: host_user | plugin_continuation | unknown
payload: user text, final response, tool input/result, or interruption metadata
```

The adapter does not invent a host event ID. If absent, SessionRuntime allocates
a local sequence number. Tool-call IDs correlate starts and results; missing
or duplicate results remain visible in coverage metadata.

The review snapshot carries:

```text
episodeId, generation, actorId, eventKind
request: original text plus relevant later user instructions
response: exact latest response and stable candidate spans
thinking: exposed reasoning segments, source kind, sequence, completeness
changes: affected paths, added/replaced text, surrounding code when available
receipts: tool name, input summary, outcome, exact bounded evidence excerpts
constraints: configured audience and applicable repository instructions
coverage: missing fields, truncation, excluded content, pending tools
```

Facts keep source IDs, timestamps, and provenance. Tool output is evidence about
what the tool reported, not unquestionable truth about the world. A user-provided
test result is distinct from one recorded by the plugin. Model-generated summaries
are never silently promoted to observed facts.

Collection rules:

- Capture the submitted request before work starts. Preserve later corrections;
  do not rely on an LLM to maintain an authoritative task checklist in v1.
- Record tool outcomes locally. Prefer exact result snippets over generative
  summaries. Pending or absent results are not successful results.
- Use `last_assistant_message` for final response review. Transcript readers are
  bounded compatibility fallbacks, because transcript timing/format is unstable.
- Parse patches and Claude edit inputs. A whole-file write is a whole replacement,
  not proof every line was newly authored in this episode.
- For semantic code checks, obtain enclosing code and relevant conventions when
  available. Missing context can make a check ineligible.
- Do not attribute the whole dirty worktree to one tool. Shell writes and concurrent
  edits require a reliable before/after baseline; otherwise report that coverage
  is unavailable. V1 semantic code checks focus on supported direct edit payloads.
- Background work, later polling results, and subagents may finish after the main
  response. Treat pending evidence as pending and avoid false completion claims.

### Visible thinking

Include thinking text when the host makes it available through a supported event,
transcript field, or exposed reasoning summary. Availability must be established
per host/version. A visible UI panel does not by itself establish programmatic
access; if the plugin cannot obtain it, status reports "visible thinking capture
unsupported" rather than implying it was audited.

`thinking_observed` is a normalized observation, not a claimed native hook event.
An adapter can attach newly exposed segments at the next available tool or Stop
hook. Do not implement undocumented UI scraping or claim access to hidden model
reasoning. Store whether the source is an exposed thinking segment or a summary;
a summary is not a verbatim account of all reasoning.

Each segment has a source ID, timestamp/sequence, original text, and completeness
state: `partial`, `complete_segment`, or `unknown`. A completed segment is not
necessarily the complete thought process. Snapshot the text at review time and
invalidate judgments when later text changes its meaning. Do not judge an
unfinished streamed fragment as a settled decision.

Add `thinking` and `thinking_span` policy targets and an optional `thinking`
evidence requirement. Policies explicitly state whether they judge a considered
option, an adopted plan, or a discrepancy with subsequent conduct. Examples must
include an undesirable option being considered and then rejected, so deliberation
is not confused with execution. Thinking alone does not establish malicious intent,
that a tool ran, or that a result was achieved.

Useful checks include an explicit plan to omit a requested deliverable without
disclosure, a stated intention to report verification that has not happened, or
a material discrepancy between the visible plan and the final account. Ground
these checks in the request and observed outcomes where required. Feedback says
what text conflicts with what evidence; it does not diagnose motives.

Audit at the next suitable lifecycle event, batching with other relevant checks.
Avoid one request per thinking token. A host that exposes thinking only at Stop
supports retrospective audit, not prevention of earlier actions. In v1, corrective
thinking policies use normal advisory feedback and the same global episode budget;
they do not gain a new permission or tool-blocking mechanism.

The inspect view labels findings as arising from **visible thinking**, **reasoning
summary**, **answer**, or **tool action**, and shows subsequent text that cleared
or superseded a concern. Use the same local retention, redaction, and remote-data
disclosure rules as other evidence. Capture and audit coverage are shown even
when no thinking-specific correction policy is enabled.

Each policy declares its required fields. The engine supplies only relevant fields
and marks truncation before evaluation. Token budgets are hard caps, not invitations
to fill Jev's context. Start with a bounded recent receipt window and retain pinned
request/constraint text; abstain when the required evidence has been omitted.

## 5. Markdown policy format

Use versioned YAML frontmatter for machine-readable behavior and Markdown for
human explanation and corrective guidance. Use a maintained full YAML parser;
do not extend the existing handwritten subset parser for nested questions.

One semantic rule defines one independent Jev question. Related questions belong
in a pack of rules, allowing different evidence requirements and calibration.
V1 does not have cross-rule expressions, question dependency graphs, or executable
templates. Code handles relevance and episode state.

Example of a rule the authoring skill could produce:

```yaml
---
schema: agent-rules/v1
id: reporting.test-result-contradiction
revision: 1
description: Report test results consistently with observed execution.
events: [response_end]
target: response_span
requires: [request, response, receipts]
priority: 80
detector:
  type: jev
  question:
    type: choice
    instructions: >-
      Compare the test-result claim in `candidate.text` with the relevant
      evidence in `receipts`. Classify whether that evidence supports or
      contradicts the claimed result. Treat quoted examples and statements
      about future work as not applicable. Do not treat absent receipts as
      evidence that a test failed or was never run.
    criteria:
      supported: Evidence supports the claimed test execution and outcome.
      contradicted: Evidence explicitly conflicts with the claimed outcome.
      unknown: Available evidence cannot establish the claimed outcome.
      not_applicable: The candidate does not assert a test execution outcome.
  decision:
    violation:
      option: contradicted
      min_probability: 0.90
    unknown_options: [unknown]
    min_winner_probability: 0.70
intervention: repair
---

## Why

Users need an accurate account of what ran and what the results establish.

## Correction

Correct the conflicting test-result claim using the recorded evidence.
If resolving the failure belongs to the current authorized task, continue
that work. Otherwise report the failure and its practical consequence.
Do not run unrelated tests merely to satisfy this rule.
```

The numbers are **illustrative, uncalibrated values**, not release thresholds.
The workbench evaluates candidate thresholds using labeled examples.

Field semantics:

- `events` filters normalized events; `target` chooses the evaluation granularity.
  Targets: `response`, `response_span`, `code_change`, and conditionally available
  `thinking` / `thinking_span`.
- `requires` names evidence groups, not arbitrary filesystem access. Policies
  cannot request environment variables or run commands.
- `priority` orders corrective attention; it is not severity or a probability.
- `instructions` and `criteria` are the canonical classifier definition. Exceptions
  must be encoded there. Explanatory prose is not silently appended to the question.
- `Correction` is required for repair rules and is the canonical repair instruction.
  No string interpolation or shell execution is allowed in policy text.
- Choice violation decisions inspect the named option's probability. If the winner
  is a violation but below its intervention threshold, return unknown. Non-violation
  winners below `min_winner_probability` also return unknown, never a clean bill.
- Noul decisions define separate `violation_at_or_above` and `clear_at_or_below`
  thresholds, with an uncertainty interval. Score decisions use probability mass
  on specified rubric levels and separate clear/violation conditions. The schema
  rejects overlapping decision ranges and unknown option/level references.
- Question keys are generated by the engine for response correlation. Jev does
  not see those keys, so instructions must contain the complete question.

At runtime, preserve the original probabilities alongside the derived status.
Never interpret uncertainty as a less severe violation or claim a high probability
proves an accusation.

For `response_span`, code assigns IDs to paragraphs or bounded sentences and gives
each candidate its surrounding context. Each candidate gets a question; candidates
sharing relevant state are batched. Findings cite exact candidate IDs. Do not ask
Jev to generate an explanation or a quote. Explicitly report candidates omitted
because of budget limits.

Use whole-response checks for clarity/completion when chopping into spans would
destroy the meaning. Their findings may reference the whole response or request;
do not manufacture a precise offending sentence.

## 6. Policy discovery and configuration

Sources, in increasing precedence:

1. Bundled policies.
2. User policies under `~/.config/agent-rules/rules/`.
3. Project policies under `<project>/.agent-rules/rules/`.

Project roots are resolved explicitly by the adapter. Project-local policy loading
follows the host's trusted-project behavior; reviewed content cannot add new rule
sources. Standalone CLI use supplies the project explicitly.

Configuration is JSON: user `~/.config/agent-rules/config.json`, followed by project
`.agent-rules/config.json`. Merge scalar settings and rule-ID entries explicitly;
replace arrays rather than inventing partial array merging. `off` wins over a
bundled default at the applicable precedence. Permit `AGENT_RULES_CONFIG` for an
explicit config path, primarily for automation and tests.

```json
{
  "schema": "agent-rules/config-v1",
  "model": "jev-1.13.0",
  "reviewDeadlineMs": 2000,
  "maxCorrectionsPerEpisode": 2,
  "rules": {
    "reporting.test-result-contradiction": "repair",
    "communication.unexplained-jargon": "observe"
  }
}
```

The deadline is an initial operating target to validate, not a measured guarantee.
Rule states are `off`, `observe`, and `repair`. Observe evaluates and records the
finding without steering the agent; the inspect command exposes it. The selected
product default is repair for enabled, calibrated starter rules.

API keys come from `TYPESAFE_API_KEY` in the host process environment, never from
rule files. The status command reports presence without printing values.

Use a normalized policy hash, including question, criteria, decision settings, and
correction text, for caching and evaluation provenance. `revision` is a readable
version, not a substitute for the hash. Reload valid edits on the next invocation.
When edits invalidate recorded calibration, show that fact; do not silently call
the new wording evaluated. New uncalibrated rules begin in observe unless the user
explicitly requests repair mode.

There is no new mandatory confirmation step for every edit. The authoring skill
honors instructions such as "create and enable this rule" once it has completed
the specified validation, and reports any remaining uncertainty accurately.

## 7. Jev integration

Pin a model ID in configuration; record the returned model ID. Initially use
`@typesafe-ai/sdk`, whose typed primitives and cancellation support match the
integration. Bundle dependencies into a distributable Node entry point so plugin
installation does not depend on running npm inside its cache.

For each event:

1. Select eligible policies and candidates locally.
2. Build bounded state and independent typed questions.
3. Batch questions whose evidence can share a compact state.
4. Send under one overall abort deadline. Set SDK retries to zero for the live
   hook path initially; the workbench can use explicit retries separately.
5. Validate answer presence, question type, finite numbers, ranges, option keys,
   and distributions before applying decision settings.
6. Return raw judgments, derived statuses, usage, and timing.

Missing/malformed answers make the affected evaluation unavailable. A transport
error makes the batch unavailable. A timeout is not a negative judgment.
Non-live evaluations can use a longer configurable budget without changing the
classification semantics.

Cache by actual evidence content, policy hash, and model ID. Do not cache only by
file path or rule name. Disable persistent judgment caching in the first release;
episode-local memoization is sufficient and avoids stale or sensitive disk caches.

Rate limits, authentication failures, and timeouts do not block normal agent work.
The plugin surfaces a health change once, records the failure, and preserves
existing deterministic check behavior. Add a brief cooldown after repeated service
failures so every tool call does not pay the same network timeout.

## 8. Correction policy and episode state

An episode is the plugin's accounting unit for one genuine user turn and the
automatic corrections that follow it. Host turn IDs are observations, not the
authority for resetting the correction budget.

State includes:

```text
episodeId, generation, originatingUserEvent, currentRequest
correctionsReserved, correctionsDelivered
pendingContinuation, lastFeedbackHash
findings: rule/evidence identity, status, attempts, lastSeen
reviewInFlight, interrupted, latestEvidenceSequence
```

The state machine:

```text
observing -> reviewing -> clear / unknown / unavailable
                       -> finding -> repair requested -> observing
                                  -> budget exhausted
any active state -> interrupted / superseded
```

Budget and feedback rules:

- Reserve a correction atomically before emitting it. A process crash after
  reservation can consume an attempt; it must not create extra attempts.
- Two deliveries is a global episode cap, including all semantic policies.
  Bundle at most three actionable findings, prioritizing factual conflicts and
  missing deliverables over style. Bound the total feedback length.
- Unchanged evidence and the same finding do not earn repeated identical repair
  requests. New output is re-evaluated, subject to the existing global cap.
- Review active findings on the next relevant event, and inspect newly introduced
  findings. Do not claim a rule is resolved if it became ineligible or unavailable.
- When evidence has not changed, show that no progress was observed and stop
  automatically repeating the same instruction.
- A genuine user instruction supersedes pending review results. User interruption
  ends the correction flow; Stop feedback must not restart it.
- A rule cannot increase the global budget or authorize new work. Corrections
  preserve user scope, permissions, valid blockers, and requested stopping points.

Codex Stop feedback acts as a new prompt. The compatibility spike must establish
how to identify plugin continuations. Correlate pending continuation state with
host markers and submitted feedback; never reset solely on a changed host turn
ID. If provenance is ambiguous, retain the existing budget rather than resetting
it. The fallback is a two-delivery session ceiling until a genuine new user event
can be established. Report that capability limitation in status.

Use persistent per-platform/session state in the user's writable data directory,
not the installed plugin directory. Store a bounded JSON snapshot. Protect updates
with an exclusive filesystem lock and atomic replacement. Do not hold the lock
across the network call: snapshot and reserve review ownership, release, evaluate,
then compare generation/evidence sequence and commit under the lock. A stale
result is recorded as superseded and cannot emit a correction.

Scope locks to the session. Limit lock waits, recover stale ownership conservatively,
and treat storage failure as observe-only. Missing/corrupt state must not reset a
known correction chain and thereby evade the cap. Resume with incomplete state
reports missing coverage; it does not invent historical success.

## 9. Platform mapping and packaging

| Normalized behavior | Claude Code | Codex |
| --- | --- | --- |
| Session initialization | `SessionStart` | `SessionStart` |
| Request capture | `UserPromptSubmit` | `UserPromptSubmit` |
| Tool receipt collection | `PreToolUse`, `PostToolUse`, `PostToolUseFailure` | `PreToolUse`, `PostToolUse`, including failed shell outcomes |
| Response review | `Stop.last_assistant_message` | `Stop.last_assistant_message` |
| Advisory tool correction | `PostToolUse.additionalContext` | `PostToolUse.additionalContext` |
| Corrective continuation | Supported non-error Stop context when available; block/reason fallback | `Stop` block/reason |
| Visible notice | Supported `systemMessage`/hook status presentation | Supported `systemMessage`/hook status presentation |

The spike must check actual placement, persistence, and ordering of notices. A
warning-style host rendering is acceptable for v1, but a model-only message is
not sufficient. Never promise custom UI that the host does not provide.

Codex tool matchers may use Edit/Write aliases while the event still contains
`apply_patch` and `tool_input.command`. Parse that format explicitly. Avoid
post-tool block decisions for advisory checks because they can replace tool
output or reject a nested tool promise. Preserve original results.

Add separate hook configurations and select them in the corresponding manifest.
Use Codex's documented portable root manifest and OpenAI extension; keep Claude
plugin metadata alongside it. Do not register both a default and an explicit
hook file for the same adapter. Installation includes a status check for loaded
hooks and Codex trust state; it does not bypass trust review.

Each release bundles the runtime and skill helper at known paths. Hooks must not
install dependencies or execute package-manager downloads when an event fires.
Keep a small legacy entry point during migration so existing Claude installations
do not break merely because source files moved.

## 10. LLM-assisted authoring

Ship a portable skill named `author-rule`. Its exact invocation syntax follows
the host; do not hard-code Claude command syntax into Codex instructions.

Workflow:

1. Read the user's preference and relevant existing policies.
2. Make it observable. Split broad labels into narrow checks; identify which
   events and evidence make each check answerable.
3. Draft Markdown policies with Jev instructions, criteria, correction text, and
   valid exceptions. Use one question per policy and no invented confidence fields.
4. Draft labeled examples, including legitimate disagreement, actual blockers,
   requested technical detail, quoted bad behavior, and missing evidence.
5. Validate the schema and run the fixtures through AuthoringWorkbench.
6. Show false positives, false negatives, abstentions, and raw judgments. Refine
   questions or evidence selection based on discrepancies, not wording preference.
7. Save the rule, fixtures, and evaluation report. Enable according to the user's
   requested scope and mode; do not install a global rule when they asked for a
   project preference.

The skill owns generative drafting. The helper owns validation and evaluation.
The runtime owns intervention. An LLM cannot mark its own generated examples as
human-validated; fixture provenance must distinguish generated labels from user
judgments and reviewed real examples.

Core helper commands, names subject to final CLI conventions:

```text
agent-rules validate <policy-or-directory>
agent-rules evaluate <policy-or-directory> --fixtures <path> [--live]
agent-rules compare <report-a> <report-b>
agent-rules inspect <finding-id>
agent-rules status
agent-rules set-mode <rule-id> off|observe|repair --scope user|project
```

Evaluation without `--live` uses a matching saved replay or reports missing
results; it must not silently make network requests. Live evaluation reports
actual model, tokens, time, and failures. The authoring skill can use live
evaluation when the authoring task authorizes it and credentials are configured.

Fixtures sit beside the policy in `<id>.cases.jsonl`. Each line contains:

```text
id, labelSource, split: development|holdout
snapshot: the same normalized input used by ReviewEngine
expected: violation|clear|unknown
notes: human-readable reason for the expected result
```

Generated examples are development cases. Keep human-reviewed examples held out
from prompt refinement when assessing generalization. Reports retain fixture and
policy hashes; changing the wording or decision threshold creates a new comparison.
Do not reuse the same cases for tuning and claim they establish held-out accuracy.

The authoring skill should report an unjudgeable preference and suggest a narrower
one rather than manufacture a confident-looking policy.

## 11. Existing scaffolding and proposed layout

| Existing code | Treatment |
| --- | --- |
| `src/rules.js` | Preserve loader/override ideas and regex normalization through a legacy adapter; new PolicyCatalog validates v1 rules |
| `src/frontmatter.js` | Keep only for legacy parsing where compatibility matters; use full YAML parsing for v1 |
| `src/match.js` | Reuse pure deterministic matching; move tool payload interpretation into platform adapters |
| `bin/agent-rules-hook.js` | Retain compatibility entry; move orchestration and state into SessionRuntime |
| `rules/*.md` | Keep current regex policies and import them explicitly; no automatic semantic reinterpretation |
| `hooks/hooks.json` | Preserve legacy wiring during migration; add explicit Claude/Codex configurations |
| `test/`, `tools/`, `live-test/` | Extend around public interfaces, replay sequences, evaluation cases, and visible live demonstrations |

Suggested layout, not a requirement for one file per concept:

```text
plugin.json                      Codex portable metadata
.claude-plugin/                  Claude metadata and marketplace
hooks/claude.json
hooks/codex.json
bin/agent-rules-hook.js           compatibility entry
src/catalog/                     PolicyCatalog and legacy import
src/review/                      ReviewEngine, detectors, evidence projection
src/runtime/                     SessionRuntime, journal, correction policy
src/platforms/claude.js
src/platforms/codex.js
src/authoring/                   AuthoringWorkbench and CLI
rules/                          existing deterministic rules
policies/                       bundled v1 Markdown rules and fixtures
skills/author-rule/SKILL.md
dist/                           bundled runtime and CLI in releases
test/                           contract and event-sequence tests
evals/                          curated cases and report format
```

Legacy rule directories are an explicit import option. Installing the new plugin
does not overwrite `~/.omp/agent/rules`, and new Jev policies are not presented as
omp-compatible. Preserve existing post-write regex behavior. Legacy interrupting
rules are supported on Claude as before; Codex marks `ask` rules unsupported
until explicitly migrated, rather than converting them into automatic denials.

The two-delivery semantic budget does not silently weaken an existing deterministic
pre-tool enforcement rule. Report legacy behavior separately during transition.

## 12. Data handling and failure semantics

Setup explains that selected response text, code, and execution evidence are sent
to TypeSafe. Minimize remote state and run deterministic secret redaction before
transmission. Mark redaction in evidence coverage; if it removes information needed
for a judgment, abstain. Content is data, including instructions inside a response,
source file, or tool output; it cannot configure the reviewer.

Persist raw receipts only in a bounded local session store with user-only file
permissions. Initial retention: 24 hours, capped at 10 MiB per session; prune on
startup and writes. Retain compact verdict metadata for seven days with a global
size cap. Store the minimal redacted finding excerpts needed for inspection, and
report when detailed evidence has expired. Full remote request/response logging
is opt-in; SDK debug logging is off. Never log credentials.

All errors have explicit outcomes:

| Condition | Outcome |
| --- | --- |
| No relevant policy | No review scheduled |
| Missing required evidence | Unknown / ineligible, no repair |
| Invalid policy | Disable affected policy, diagnostic |
| Jev timeout/error/bad answer | Unavailable, no repair |
| Episode storage unavailable | Observe-only; no automatic continuation |
| New user instruction during review | Discard stale correction |
| Same unresolved finding at cap | Visible unresolved outcome, no continuation |
| Hook capability unsupported | Diagnostic and capability downgrade |

The plugin does not make permission decisions based on semantic behavior scores.
It cannot guarantee detection of deception, bypass-proof enforcement, or correction
of all undesirable behavior. The product promise is specific, inspectable checks
and bounded attempts to improve the work.

## 13. Implementation order and acceptance criteria

### Phase 0: platform compatibility spike

Capture sanitized payload fixtures from installed Claude and Codex versions.
Verify response review, visible notices, continuation identity, stop/interrupt
behavior, failed commands, patch input, and coexistence with existing hooks.
Identify whether visible thinking or reasoning summaries are obtainable, how
they are labeled, when they arrive, and whether they can be captured completely.
Include considered-and-rejected plans and incomplete segments in the fixtures.
Use a fixed local verdict so this phase isolates host behavior from Jev quality.

Exit criterion: a visible finding requests exactly one continuation in each CLI,
and a deliberately repeating finding cannot exceed the configured episode cap.
Record unsupported capabilities rather than assuming documentation parity.

### Phase 1: one complete vertical slice

Implement PolicyCatalog, the Jev adapter, minimal evidence collection,
SessionRuntime, and both platform adapters for test-result contradictions.
Include the evaluation CLI and replay fixtures from the start.

Exit criterion: a recorded failed test followed by a conflicting success claim
produces visible evidence-based feedback; a correct failure report, an absent
receipt, and a quoted example do not trigger the same correction. A corrected
statement is rechecked without falsely claiming the tests now pass.

### Phase 2: authoring and calibration

Add the authoring skill, structured examples, reports, comparison, and rule modes.
Author clarity and premature-completion rules using that workflow.

Exit criterion: the skill can create, validate, evaluate, refine, and save a rule
using the production review interface. Evaluation reports distinguish generated
labels, reviewed labels, development data, and holdout data. Thresholds and known
weaknesses are documented before enabling starter policies in repair mode.

### Phase 3: migration and semantic code checks

Import existing regex policies, package both plugins, and extend evidence to direct
code edits. Add a small number of contextual checks such as swallowed errors and
unjustified fallback behavior. Keep existing linters and code hooks intact.

Exit criterion: old regex fixtures retain their meaning, Codex patches are handled
correctly, and semantic code findings identify the relevant change with adequate
surrounding context. Unsupported shell-edit coverage is explicit.

### Verification throughout implementation

Test public interfaces and complete event sequences rather than private helpers:

- Catalog override errors, invalid decisions, and unchanged legacy meaning.
- Typed judgments, uncertain answers, missing evidence, partial failures, deadlines.
- Two adapters producing equivalent normalized evidence from representative inputs.
- Visible thinking versus summary provenance, partial segments, later retractions,
  and adopted plans versus rejected alternatives; explicit unsupported coverage.
- Concurrency, crashes after reservation, stale results, ambiguous continuations,
  interruptions, and exhausted budgets.
- Real task outcomes: false interventions, missed issues, repair success, unwanted
  extra work, latency, and cost including the working agent's correction turns.

Model evaluations are separate from deterministic CI. Replay stored responses in
ordinary tests; run live evaluations explicitly against a pinned model. No accuracy
or latency claim is justified solely by vendor examples or synthetic happy paths.

## 14. Deferred scope

- Hidden rewriting or suppression of the original response.
- Subagent-specific enforcement and cross-agent correction budgets.
- A hosted dashboard, persistent daemon, or MCP server solely for hook execution.
- Model-generated policies during every runtime check, automatic self-modifying
  rules, or automatic deployment of newly learned policies.
- Repository-wide semantic review on every edit, universal shell-write attribution,
  and using Jev in place of deterministic linters.
- A generic claim that the plugin detects malicious intent.

These are not required for the initial product. The remaining empirical decisions
are thresholds, practical deadlines, supported host-version details, and access
to visible thinking. The architecture and authoring workflow can proceed with
the design above; unavailable thinking capture is an explicit capability gap.
