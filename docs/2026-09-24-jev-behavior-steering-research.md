# Jev behavior steering: research and design options

Research date: 2026-09-24. This is a design brief, not an implemented integration.

The intended product is a Claude Code and Codex plugin that detects undesirable
agent behavior and gives the working agent a specific corrective instruction.
The user selected **automatic correction with a strict retry limit** as the
default. Exact limits, initial policies, and rollout criteria remain proposals.
The user also explicitly wants the original response and the plugin's intervention
to be visible, so observing the correction can build trust in the technique.

The subsequent [implementation design](2026-09-24-behavior-steering-design.md)
also includes the user's requirement to audit visible thinking when the host
exposes it. Programmatic access to that text remains a compatibility-spike question;
this research did not verify reasoning capture in either installed runtime.

## Findings that determine the design

1. Both platforms document native lifecycle hooks for inspecting tool calls,
   supplying feedback, and continuing a turn at `Stop`. A command hook can call
   Jev without making the main agent voluntarily invoke a review tool.
2. Jev supplies typed judgments and probabilities. It does not generate a critique,
   repair instructions, or replacement code. Policy authors supply the correction;
   Claude/GPT performs it.
3. Broad labels such as deception or laziness must become observable checks.
   Unsupported success claims and omitted requirements are assessable with
   evidence. Deliberate intent cannot be established from a classification.
4. `Stop` is a continuation opportunity after a response. This fits the desired
   visible correction workflow: the user sees the original response, the plugin
   firing, and the agent's repair. Withholding the original response is not a
   product requirement.
5. A common evaluation engine is practical; identical hook configuration and
   payload handling across platforms is not.

Sources: [Claude hooks][claude-hooks], [Codex hooks][codex-hooks],
[TypeSafe API][ts-api], [Jev with coding agents][ts-agents].

## Verified platform capabilities

| Concern | Claude Code | Codex |
| --- | --- | --- |
| Before tool execution | `PreToolUse`: allow, deny, ask, change input, add context | `PreToolUse`: deny, allow with changed input, add context; `ask` is currently unsupported |
| After execution | `PostToolUse` supplies context; `PostToolUseFailure` covers failures | `PostToolUse` supplies context and includes nonzero shell exits |
| End-of-turn review | `Stop`, including `last_assistant_message` and `stop_hook_active` | Same fields, plus `turn_id` |
| Request more work | `Stop` block/reason; current docs also support non-error `additionalContext` continuation | `Stop` block/reason creates a continuation prompt acting as a new user prompt |
| Subagents | `SubagentStop`; newer handback flow may deliver report through `SubagentHandback` before closing text | `SubagentStop` with agent ID and subagent transcript path; common session ID is the parent's |
| File edit payload | Existing project handles `Edit`, `Write`, `MultiEdit` | `apply_patch`, with patch in `tool_input.command`; Edit/Write matcher aliases do not change the payload |
| Shell | Tool hooks; tools/scripts can modify files | `Bash` alias includes unified exec; final result can arrive through a later poll |
| Packaging | Claude plugin metadata and hook configuration | Portable root `plugin.json` with `extensions.com.openai.hooks`; legacy `.codex-plugin/plugin.json` also supported |

Codex hooks require review/trust of their current definition. Installation alone
does not activate an untrusted hook. The docs say plugins are supported in Codex
CLI and the desktop surface, but not the IDE extension. Scripts must exist in the
execution environment; installing a web plugin does not deploy local scripts.

The current Claude hook reference mentions `MessageDisplay`, but describes its
replacement as display-only: the model and transcript retain the original text.
This is not a shared mechanism for correcting the model's answer before display.

Neither platform's post-tool hook undoes an action. Use pre-tool denial only for
checks intended to prevent that action. Advisory feedback should preserve the
original tool result: Codex post-tool blocking can replace it and can reject a
nested code-mode tool promise, which is usually undesirable for style feedback.

Read the current event contracts rather than assuming compatible field names
have identical effects. For example, returning unsupported Codex pre-tool fields
can fail the hook and allow the tool call to continue.

Local version commands reported **codex-cli 0.156.1** and **Claude Code 2.1.281**.
This research did not execute live hook flows against either installed binary;
documentation support does not establish behavior in every UI or build.

Sources: [Claude hooks][claude-hooks], [Claude plugins][claude-plugins],
[Codex hooks][codex-hooks], [Codex plugins][codex-plugins],
[Codex packaging][codex-build].

## Jev's useful primitives and limits

`POST https://api.typesafe.ai/v1/systemone` accepts `model`, `state`, and a map
of named `questions`. Each question is one of:

- **Noul:** probability that a specified condition holds. Use independent Nouls
  when several behaviors can occur together. There is no extra confidence field.
- **Choice:** one of a defined set, with probabilities and confidence. Useful for
  evidence relationships: supported, contradicted, not established, not applicable.
- **Score:** a distribution over ordered descriptive levels and their weighted
  score. Useful for clarity or severity, provided each level has a concrete rubric.

Question IDs are not supplied to the underlying model. Instructions must say what
is being judged explicitly. Independent questions share state and run in parallel;
they cannot use each other's answers. A dependent evidence-selection step requires
another request, or speculative questions whose answers code conditionally uses.

Current model documentation lists `jev-1.13.0`; both `jev-latest` and `jev-preview`
currently point to it. Pin the version once thresholds have been evaluated.

Documented price is **$0.042 per million input tokens**, with free output tokens.
A request totaling 5,000 input tokens costs approximately **$0.00021**; 1,000 such
requests cost **$0.21**, excluding retries and the working agent's repair turns.
The latter can dominate actual cost.

Limits currently listed: 64k tokens across the entire request; 32k for state plus
the longest question; 250k tokens/second and 1,200 requests/minute. TypeSafe says
rate limits can change. Do not treat the full context limit as a desirable input
size: its jaggedness guidance explicitly warns about irrelevant long context.

A vendor cookbook reports 0.27 seconds for one batched 13-question request over
a GDPR article, versus 2.71 seconds for 13 sequential requests. Those are cached
Jev 1.12 example results, not measurements or latency promises for this plugin.
Measure p50/p95 and timeouts on our actual state and policies.

The JavaScript SDK (`@typesafe-ai/sdk`) supports Node 20+, ESM, and typed results.
Its defaults are unsuitable as an implicit hook deadline: timeout is 10 seconds
**per attempt**, with two retries and potentially substantial retry-after waits.
Use an overall abort deadline and explicit retry policy. An initial design target
could be a two-second review budget, adjusted after measuring actual latency.

TypeSafe documents literal interpretation, weak multi-hop reasoning, distraction
from long state, and susceptibility to adversarial content. Typed output ensures
shape, not correctness. A classifier must not be the source of authorization or a
guarantee of honesty. Its guardrail cookbook is a useful composition example; its
strong claims about resisting injected instructions do not override the explicit
adversarial-content limitation in the model guidance.

Sources: [API][ts-api], [models/pricing][ts-models], [confidence][ts-confidence],
[SDK][ts-sdk], [SDK configuration][ts-sdk-config], [SDK retry defaults][ts-retries],
[batched questions][ts-batch], [limitations][ts-limits], [guardrails][ts-guardrails].

## Turn behavioral categories into useful checks

| Desired improvement | Concrete check | Required context / important exceptions |
| --- | --- | --- |
| Clear explanations | Unexplained terminology materially obstructs the answer for this audience | User question, audience preference, candidate response; necessary technical terms and requested detail are allowed |
| Honest reporting | A claim of running, testing, verifying, or completing something is contradicted or not established by available evidence | Exact response span and relevant tool receipts; distinguish missing telemetry from failure and outside evidence supplied by the user |
| Complete work | An explicit requested deliverable is missing and the agent is trying to finish despite having an available authorized next step | Request and later steering, artifacts, outcomes, blockers; questions, research-only tasks, stop requests, and real approval dependencies are valid stopping points |
| Respect intent | The proposed action conflicts with a stated objective or constraint | User's original request plus corrections and pending action; disagreement backed by evidence is not misbehavior |
| Better code | A changed function swallows an error, introduces unjustified fallback behavior, bypasses a type boundary, or violates a repository convention | Changed code plus enclosing function and relevant conventions; isolated added lines often lack enough context |
| Proportionate autonomy | Agent requests permission again for an already-authorized reversible action | Current authorization, exact intended action, platform restrictions; real approval barriers must remain respected |
| Preserve requested scope | Agent silently drops a requirement, changes an interface, or substitutes an easier deliverable | Explicit requirements versus actual changes and final report |

Avoid a single "is this deceptive/lazy/misaligned?" question. Split these categories
into narrow policies with allowed cases and evidence requirements. Do not combine
them into a weighted quality average that could hide an unsupported success claim
behind a good clarity score.

Use `unknown` as a real operational outcome. A detector that cannot see the needed
evidence should abstain or request a bounded self-check; it should not accuse the
agent or mechanically insist on additional work.

Evidence localization is possible without asking Jev to generate explanations:
split a response into candidate spans in code, assign IDs, evaluate spans or ask
a Choice to select one (including no-match), and copy the selected source text
verbatim into a fixed correction template. Jev selecting a span still needs
evaluation; selection does not prove the allegation.

Useful precedents: [citation verification][ts-citations] combines exact matching
with semantic support checks; [semantic find][ts-find] evaluates identified spans.

## Proposed architecture

```text
Claude / Codex lifecycle event
  -> platform adapter
  -> bounded state + tool evidence + relevant policy selection
  -> existing deterministic checks / Jev question batch
  -> explicit decision policy
  -> concise corrective feedback
  -> agent continues and produces new work
  -> re-evaluate within a shared retry budget
```

Keep the runtime as a local Node program initially. A hosted dashboard, daemon, or
MCP server is optional later. Command hooks already give automatic execution on
both platforms; adding an MCP tool alone would depend on the agent choosing it.
Package dependencies so installing the plugin does not require npm downloads on
every hook invocation. A bundled runtime or a small direct-fetch client are both
feasible; choose during implementation.

Separate five responsibilities:

1. **Adapters:** normalize tool arguments, lifecycle events, response text, and
   platform-specific output. Report capability gaps explicitly.
2. **Evidence collection:** retain bounded tool receipts and user requirements.
   Each fact carries source, time, scope, and coverage. Keep observations separate
   from claims by the working agent and from classifier inferences.
3. **Policy evaluation:** select applicable policies, build Jev state/questions,
   validate results, and retain raw probabilities. Batch policies sharing relevant
   state; do not put the entire conversation into every request.
4. **Intervention policy:** apply calibrated thresholds, evidence sufficiency,
   category priority, and retry budget. This code decides whether to intervene.
5. **Feedback and diagnostics:** render brief, authored repair instructions with
   exact evidence references. Record policy/model version, latency, decision,
   uncertainty, and whether the repair improved the result.

Use `UserPromptSubmit` to retain the explicit objective and subsequent steering.
Use tool events to collect receipts, and `Stop` for answer/completion review.
`SessionStart` can give a short advance instruction about the enabled policies;
avoid loading the entire catalog into the working agent's context.

For code, start alongside existing hooks. Keep exact syntax checks and linters
deterministic. Add semantic review for a few defined smells. For edits performed
through shell commands, a post-action diff may be needed; distinguish task changes
from pre-existing user changes and concurrent agent edits. Never assign the entire
dirty worktree to the current tool call without a baseline.

Prefer hook payloads and locally recorded events over reparsing full transcripts.
Claude documents asynchronous transcript writes; Codex documents an unstable
transcript format. Any transcript reader should be versioned, bounded, and report
missing coverage. No hidden reasoning is required or assumed accessible.

## Automatic correction and stopping rules

Make the intervention visible independently of whether the agent acknowledges it.
Use the platform's supported user-facing hook status/output alongside the separate
model-facing correction. Exact presentation must be checked in each target UI.
For example: "agent-rules: verification claim lacks support in the recorded
results. Asking for correction (1/2)." Show successful rechecks, unresolved
findings, and exhausted retry budgets concisely. Do not claim resolution merely
because the agent says it complied; report what the recheck actually establishes.
Detailed inspection can show the policy, exact evidence, model version, raw
judgment, and threshold. Avoid implying that a probability is proof of wrongdoing.

Proposed initial limit: **at most two corrective continuations per actual user
turn, shared across all policies**, with a smaller limit available for style-only
checks. A real user stop/interrupt always wins.

- First intervention: one short bundle of the highest-priority actionable findings.
- Re-evaluate changed output; confirm whether the original issue improved.
- Do not repeat identical feedback when evidence has not changed.
- On exhaustion, stop injecting continuations and record the unresolved finding;
  a brief status can tell the user that automatic correction reached its limit.
- On timeout or unavailable Jev, allow ordinary work to continue and record
  "review unavailable", not "passed". Existing deterministic enforcement retains
  its own behavior.

The retry identity needs particular care in Codex: Stop feedback creates a new
continuation prompt and may change turn bookkeeping. Verify this in a live spike.
Do not reset the budget solely because a new `turn_id` appears. Use continuation
state and a conservative session-level ceiling if the originating user turn cannot
be established. State updates must be atomic across concurrent hooks/subagents.

Interventions should be specific and non-accusatory. For example:

> Your response says "all tests passed", but the recorded test command failed.
> Correct that statement. If fixing the failure is within the requested task,
> resolve it and report the actual result.

The intervention conveys a configured policy and its evidence. There is no need
for the existing wrapper's "NOT prompt injection" or exaggerated claims of
authority. Repair instructions must preserve the user's permissions, scope,
valid exceptions, and current stop requests.

## Rule format and migration from this repository

Keep the useful human-authored rule concept: description, scope, allowed cases,
and repair guidance. Extend it with a detector type, event targets, evidence
requirements, Jev instructions/criteria, policy version, and intervention settings.
Policy examples should include both violations and legitimate exceptions.

The current implementation provides reusable pieces:

- `src/rules.js`: loading and name-based overrides.
- `src/match.js`: deterministic regex/glob checks and Claude payload extraction.
- `bin/agent-rules-hook.js`: hook dispatch, model feedback, and session state.
- `rules/`: ten existing deterministic policies.

Important changes:

- Once-per-session suppression in `decide()` is wrong for recurring semantic
  behavior. Deduplicate by policy version, relevant evidence hash, and episode,
  while allowing a policy to detect new violations later in the session.
- The handcrafted frontmatter parser only handles a small YAML subset. Rich
  nested criteria require a real parser with schema validation, or an explicit
  JSON policy representation. Do not silently extend the current parser ad hoc.
- Move new policy configuration away from mandatory omp naming/layout. Preserve
  legacy regex rules with an importer if desired; native omp cannot interpret
  new Jev policies just because they still live in Markdown files.
- Replace completely silent errors with unobtrusive diagnostics and a status
  command. Missing configuration must be distinguishable from a clean review.
- Give each platform its own hook file and package metadata, sharing the engine.
  Current Codex docs recommend portable root metadata; Claude's supported plugin
  metadata can coexist in the same repository.

Keep project overrides explicit. Trusted local configuration selects policies;
text being reviewed must not redefine thresholds or disable the reviewer.

## Data handling

The plugin sends selected code, response text, and supporting evidence to
TypeSafe. Make that boundary explicit in setup. Apply local secret detection and
minimization before constructing remote state; avoid raw environment dumps and
unbounded tool output. Store metadata and selected evidence references by default,
with full diagnostic payloads opt-in.

TypeSafe states it does not train on customer requests/responses. Its docs offer
zero data retention for enterprise customers; do not assume ZDR for every account.
The SDK's debug logging includes request bodies, so keep it off by default.
Source: [models][ts-models], [legal][ts-legal], [SDK configuration][ts-sdk-config].

## Recommended first slice and remaining empirical work

Start with response review: **clarity**, **unsupported work/verification claims**,
and **premature completion**. Integrate the current deterministic code hooks,
then add two or three semantic code checks with narrow definitions.

Before treating those checks as reliable, collect labeled positive and negative
examples, including legitimate blockers, research-only tasks, requested technical
detail, corrections to a mistaken user premise, and unavailable evidence. Include
examples where quoted bad behavior must not count as the agent doing it.

Evaluate policies separately, then evaluate the complete repair loop. Measure:

- False interventions on good work and missed material violations.
- Evidence coverage and abstention rate.
- Whether the repair actually resolves the issue without removing useful detail
  or causing unnecessary work.
- Additional agent turns, task completion rate, p50/p95 latency, API cost, and
  repair cost.
- Repeated feedback, concurrent hooks, interruption, failed API calls, and stale
  classifier results after the user changes direction.

Use held-out examples to tune thresholds; no universal probability cutoff is
established by these docs. Pin model and policy versions for repeatability.

The first compatibility spike should establish actual tool/Stop payloads in both
installed runtimes, visibility of the original response, continuation identity,
subagent behavior, and coexistence with existing hooks. The remaining uncertainty
is behavioral accuracy and integration behavior, not the availability of a typed
classification API.

No Jev requests, live hook experiments, or application tests were run during this
research. Only documentation and repository inspection, plus version commands,
were used. No runtime code or installed configuration was changed.

[claude-hooks]: https://code.claude.com/docs/en/hooks
[claude-plugins]: https://code.claude.com/docs/en/plugins-reference
[codex-hooks]: https://developers.openai.com/codex/hooks
[codex-plugins]: https://developers.openai.com/codex/plugins
[codex-build]: https://developers.openai.com/codex/plugins/build
[ts-api]: https://docs.typesafe.ai/api
[ts-agents]: https://docs.typesafe.ai/introduction/coding-agents
[ts-models]: https://docs.typesafe.ai/models
[ts-confidence]: https://docs.typesafe.ai/confidence
[ts-sdk]: https://docs.typesafe.ai/sdk/javascript
[ts-sdk-config]: https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig
[ts-retries]: https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy
[ts-batch]: https://docs.typesafe.ai/cookbooks/parallel_questions
[ts-limits]: https://docs.typesafe.ai/model-jaggedness/jev-1.13
[ts-guardrails]: https://docs.typesafe.ai/cookbooks/llm_guardrails
[ts-citations]: https://docs.typesafe.ai/cookbooks/citation_check
[ts-find]: https://docs.typesafe.ai/cookbooks/semantic_find
[ts-legal]: https://docs.typesafe.ai/legal
