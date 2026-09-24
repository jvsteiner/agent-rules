# Implementation plan: autonomous delivery of Agent Rules v1

Based on [the accepted design](2026-09-24-behavior-steering-design.md).
Execution is authorized: implement, test, diagnose, and repair independently until
the implementation is demonstrably working. Preserve existing user edits.

## Resource preflight

Verified before implementation:

- Node 24.13.0, npm 11.6.2, registry access.
- Codex CLI 0.156.1 authenticated with ChatGPT.
- Claude Code 2.1.281 authenticated with Claude.
- `.env` exists, is git-ignored, and contains `TYPESAFE_API_KEY`.
- An authenticated request to Jev 1.13.0 returned HTTP 200 and a contradiction
  probability of 0.99 on a synthetic example. This establishes API access, not
  classification accuracy. No credential values are logged.
- Existing tests are present, but `node --test test/` fails on this installed Node
  version. Fix discovery first, then establish the true baseline.

Load `.env` only through an explicit local development/evaluation option. Plugin
runtime credentials normally come from the environment. Never read an arbitrary
target repository's `.env` automatically. Never commit keys, request headers,
raw host credentials, or unsanitized transcripts.

## Operating protocol

For each milestone: write the behavioral test first, run it and record the expected
failure, implement the smallest complete behavior, run focused tests, and then
run the cumulative suite. Do not weaken an assertion merely to make code pass.
Use temporary directories and controlled clocks/transports instead of modifying
personal hook configuration. Keep a progress/evidence log beside this plan.

Normal retries require no human input. Diagnose failures from exact inputs and
outputs. Fix the implementation, add regression coverage when a new failure is
found, and rerun affected acceptance checks. A real missing credential or host
capability is reported precisely and isolated from capabilities that work.
Do not fabricate a successful result, silently skip mandatory tests, repeatedly
retry authentication failures, or expand the product to conceal an integration gap.

No deployment, external messages, or irreversible actions are needed. Live model
tests use small synthetic tasks. Set process timeouts and maximum turns so a broken
Stop hook cannot consume an unbounded session. Record model usage where available.

## Milestone 0: baseline and platform contract harness

Deliverables:

- Portable test discovery, baseline report, locked dependencies.
- An isolated CLI harness that writes temporary hook scripts/settings and records
  sanitized event payloads, hook replies, and emitted host events.
- Real sessions in both CLIs proving Stop feedback causes a continuation.
- Capability records for visible thinking/summary access, user notices, genuine
  user versus synthetic continuation identity, interruption, and tool results.

Tests first:

1. Existing rule/matcher/hook tests run without changes to their semantics.
2. A fixed local finding asks for one correction; a repeated finding is bounded.
3. Missing/malformed hook input does not break unrelated agent work.

Run host probes with tools disabled where possible; use explicit temporary config,
not global installation. If trust bypass is required for the test invocation,
only use it for the exact generated and inspected test hook. Production trust
review is never bypassed by the plugin. Save discovered differences as fixtures.

Exit: both authenticated hosts complete a bounded correction session or the exact
unsupported surface is documented with captured evidence before adapter decisions.

## Milestone 1: policy catalog and configuration

Deliverables: full YAML parsing, schema validation, normalized policies, hashes,
bundled/user/project precedence, explicit rule modes, legacy regex preservation.

Red tests:

- Valid Choice, Noul, Score and regex policies load.
- Invalid question types, thresholds, reference options, evidence names, targets,
  duplicate IDs, missing repair text, and malformed YAML produce actionable errors.
- An invalid project override disables its ID rather than resurrecting the global
  policy. Disabled policies do not execute.
- Content changes alter the hash even if revision is unchanged.
- Configuration rejects paths or numeric values it cannot safely support.
- No config output prints secret values; project files cannot choose credentials.

Exit: catalog tests pass and all existing regex fixtures retain their outcomes.

## Milestone 2: review engine and Jev adapter

Deliverables: shared production/evaluation interface, evidence projection,
redaction and coverage, per-policy decisions, deterministic and Jev detectors.

Transport harness: injectable fetch/client with deterministic responses, delayed
responses, HTTP 401/429/529, partial answer maps, invalid types/probabilities,
connection errors, and aborts. Test with a local HTTP server as well as replay
objects so request shape, authentication, cancellation, and encoding are exercised.

Red tests:

- Several independent questions share one request where appropriate.
- Questions use explicit instructions; identifiers are only correlation keys.
- Unknown and unavailable never become clear or actionable violations.
- Missing required evidence prevents a model call and intervention.
- Full evidence/context and exact span IDs survive projection; truncation is marked.
- Threshold boundary cases for all primitives behave deterministically.
- Invalid or missing answers affect only the corresponding evaluations.
- One overall deadline cancels network work; no hidden SDK retry expansion.
- Secret-shaped content is redacted before transport and logs.
- Same policy/evidence/model can be memoized, while changed content is re-evaluated.

Exit: fixture tests and live API contract smoke pass; no accuracy claim yet.

## Milestone 3: platform adapters and evidence collection

Deliverables: Claude/Codex normalization, patch parsing, tool receipt correlation,
request capture, final-response capture, optional exposed-thinking capture.

Fixtures from milestone 0 are immutable inputs. Add representative synthetic
fixtures for rare errors with provenance labels; do not label invented payloads
as observed host behavior.

Red tests:

- Equivalent Claude edits and Codex patches produce equivalent changed text.
- Multi-file patches, whole-file writes, failed commands, delayed completion,
  absent file paths, and unexpected tool shapes are handled explicitly.
- Codex matcher aliases do not cause Claude payload assumptions.
- Host final-message fields take precedence over lagging transcripts.
- Visible thinking is distinct from summaries and answers. Partial/absent reasoning
  is marked; rejected alternatives are not treated as executed actions.
- The adapter emits valid event-specific continuation and notice structures.
- Advisory feedback does not replace original tool output or approve tool execution.

Exit: both host fixtures decode correctly; round-trip hook subprocess tests pass.

## Milestone 4: episode runtime, persistence, and bounded repair

Deliverables: per-session journal, atomic locking, evidence snapshots, correction
budget, deduplication, health reporting, bounded retention and inspection.

Sequence harness: feed host events through SessionRuntime with deterministic
judgments and controlled scheduling. Also spawn multiple real hook processes
against the same temporary state directory to exercise filesystem concurrency.

Red tests:

- Contradiction → correction → corrected response → cleared finding.
- Repeated violation consumes at most two deliveries across all policies.
- Duplicate unchanged findings do not produce repeated feedback.
- Codex continuation IDs cannot reset the cap. Ambiguous provenance preserves it.
- User steering invalidates pending results; interruption prevents continuation.
- Concurrent hooks cannot reserve more deliveries than allowed.
- Process failure after reservation cannot create extra retries.
- Corrupt/unwritable state leads to observation only, not an empty renewed budget.
- Classifier timeouts and unavailable evidence are visible and do not block work.
- Resolved, unknown, superseded, exhausted, and unavailable are distinguishable.
- State and diagnostic retention limits apply, with private file permissions.

Exit: deterministic sequences and multi-process tests pass; no unbounded path
exists under the exercised failure cases.

## Milestone 5: authoring workbench and skill

Deliverables: validate/evaluate/compare/inspect/status/set-mode commands; author-rule
skill; policy examples; JSONL fixtures; reproducible reports.

Red tests:

- Evaluation calls the same engine as live hooks.
- Offline evaluation cannot silently call a remote API.
- Replay identity includes policy/evidence/model; mismatches are errors.
- Reports separate false positives, false negatives, abstentions, unavailable
  cases, costs, and timing; failed cases produce a failing command status.
- Generated versus human labels and development versus holdout splits persist.
- Compare reports identifies changed outcomes; it does not imply statistical
  significance from small samples.
- Mode changes touch only the selected scope and preserve unrelated settings.
- Skill examples and paths execute correctly from an installed plugin layout.

The authoring skill must draft narrow questions, exceptions, repair guidance, and
positive/negative/unknown examples, execute evaluations, show disagreements, and
refine accordingly. It should honor an authorized create-and-enable request without
inventing another approval ceremony. It cannot label its own examples human-reviewed.

Exit: an authoring task produces a valid policy and evaluation artifact that the
runtime can use. Run a realistic isolated authoring exercise through an authenticated
host, with bounded work and no modification of global preferences.

## Milestone 6: starter policy evaluations

Initial policies:

1. Test-result contradictions: failed tests versus an explicit success claim.
2. Unexplained jargon relative to the request/audience.
3. Premature completion of an actionable authorized request.
4. Visible-thinking audit where host capture is supported, with cautious applicability.

Build labeled synthetic development suites and a distinct holdout set. Include
legitimate blockers, user stop requests, research-only tasks, requested technical
depth, quoting bad examples, attempted-then-failed work, rejected plans, pending
tools, and absent evidence. Labels remain identified as synthetic/generated.

Evaluate pinned Jev live. Tune development wording/thresholds, then assess holdout
without repeatedly optimizing on it. Failed holdout rules remain observe-only
and are documented as such rather than silently enabled. A small suite demonstrates
specific behavior, not production calibration.

Exit: verification contradiction rule passes the curated matrix and drives a real
host correction; other policies have truthful readiness and mode reporting.

## Milestone 7: packaging, actual sessions, and handoff

Deliverables: bundled runtime, platform-specific hook files, Codex/Claude metadata,
authoring skill, documented setup and environment loading, CI and operator commands.

Acceptance harnesses:

- Install-layout test runs copied bundle in a path containing spaces without
  node_modules and confirms all runtime resources resolve.
- Manifest/skill validation; dependency lock and no runtime package downloads.
- Actual Claude and Codex sessions with Jev-backed review, visible notices,
  corrected output, and bounded retries. Use synthetic false statements rather
  than modifying real project code to force findings.
- Authoring smoke and inspect/status output, including missing key behavior.
- Fresh cumulative test run, coverage review focused on important branches,
  deterministic package build, live Jev matrix, and secret-leak checks.

Keep user .env and unrelated edits intact. Do not call the implementation confirmed
working based only on mocks. Final evidence must list exact commands, pass/fail
counts, observed host behavior, live model ID, limitations, and changed files.

## Completion standard

Required: preserved legacy tests; new deterministic and subprocess harnesses;
valid installable bundles; successful authenticated Jev requests; evaluated starter
rule; real correction sessions on both hosts; authoring workflow; documented actual
thinking-capture support and any remaining coverage gaps.

If a host exposes no usable thinking text, explicit unsupported status is correct
for this conditional feature. It is not permission to claim thinking was audited.
If a required host test cannot run, report that as an unconfirmed integration and
continue independent work rather than declaring universal success.
