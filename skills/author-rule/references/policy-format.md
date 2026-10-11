# Policy and fixture format

## Markdown policy

Policies use YAML frontmatter followed by Markdown sections. The supported shape is:

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
      Compare the claim in `candidate.text` with the recorded execution receipts.
      Ignore quotes and descriptions of future work. If evidence cannot decide,
      select unknown.
    criteria:
      supported: Receipts support the claimed outcome.
      contradicted: Receipts explicitly conflict with the claimed outcome.
      unknown: The available evidence cannot establish the outcome.
      not_applicable: The candidate makes no execution claim.
  decision:
    violation:
      option: contradicted
      min_probability: 0.90
    unknown_options: [unknown]
    min_winner_probability: 0.70
intervention: observe
---

## Why

Explain the user value of the rule.

## Correction

Give a direct instruction for fixing this finding using the available evidence.
```

Use only evidence groups available to the runtime: `request`, `conversation`, `response`, `receipts`, `changes`, `thinking`, and `constraints`. `request` is only the user's latest message. `conversation` adds the user's last three earlier messages (up to 600 characters each) and the last 1,000 characters of the agent's previous reply; add it to `uses` for any request or tool rule, because a latest message such as "yes" or a chosen option means nothing without it. `requires` lists evidence the rule cannot be judged without; when any of it is missing, the review is skipped as unknown. Jev receives the last 10 tool calls in `state.receipts`, each trimmed to the first 600 characters of its input and the last 600 of its result (the call under review stays whole); older calls appear only as `state.receipts_omitted` (`count` and the tool names), so a rule about earlier calls should check both. `uses` lists evidence that helps when present but must not block the review, such as `receipts` or `changes` for a reply rule that also runs on turns without edits. Keep `events`, `requires`, and detector criteria specific to the rule. Choose the check point from when the rule can act:

| `events` | `target` | Checks | A `repair` finding |
|---|---|---|---|
| `user_prompt` | `request` | The user's request, before the agent starts | Adds the correction as context. In `block` mode, rejects the prompt so the model never sees it |
| `tool_start` | `tool_call` | The pending tool call: tool name and input | Denies the call, and the agent receives the correction. Applies to every matching call |
| `tool_result` | `code_change` | A completed edit | Adds the correction as context |
| `tool_result` | `tool_result` | The current tool's full returned text | Adds the correction as context, or wraps content when `delivery: wrap` is set |
| `response_end` | `response`, `response_span`, `thinking`, `thinking_span` | The finished reply | Stops the turn, and the agent rewrites the reply |

Prompt and pre-tool checks add a Jev request, about two seconds, to every prompt or tool call, and run only when an enabled policy uses them. A topic rule usually needs a `request` policy to stop work early and a `response` policy for replies that drift onto the topic; add a `tool_call` policy when the agent could act on the topic without being asked. All three hosts (Claude Code, Codex, and omp) support every check point. For `tool_call`, leave `requires` empty; the pending call is the evidence.

For Jev detectors, `question.type` is `choice`, `noul`, or `score`; instructions are currently authored as a string. Choice criteria are a map of option names to descriptions. Noul criteria may be omitted or describe `true` and/or `false`; decision thresholds are `violation_at_or_above` and `clear_at_or_below`, with the clear threshold lower than the violation threshold. Score criteria are an ordered array of 2–10 level descriptions. Score decisions use `violation_levels` and `clear_levels` containing zero-based level indices as strings (for example `['2']`), plus `min_probability` from 0 to 1. The two level sets must not overlap. Regex detectors use `type: regex`, a JavaScript `pattern`, and optional `flags`.

`prefilter` is an optional mapping with a regular expression `pattern` and optional `flags` (`i`, `m`, `s`, `u`). It runs locally on each candidate before any Jev call: a candidate it does not match is recorded as clear, with no Jev request and no cost. Give every `tool_call` and `request` policy a prefilter that matches only the calls or messages the rule could concern, such as `^(Edit|Write|MultiEdit|apply_patch)$` with flag `m` for edit rules or `\bgit\s+(commit|push)\b` for a commit rule. A `tool_call` candidate is the tool name on the first line followed by its JSON input. Keep the pattern broad enough to catch every violation; test it against the violating fixtures, because a violation the prefilter skips is a miss.

`intervention` is `observe`, `repair`, or `block`; it defaults to observe. Repair and block policies need a nonempty `## Correction` section. The section ends at the next level-two heading. Do not put credentials, shell commands, interpolation, or arbitrary filesystem requests in policy text. Probability thresholds are authored policy settings, not claims of human calibration.

### Tool-result delivery and review failures

These optional controls are general: the rule defines the category, detector and instruction.

- `delivery: wrap` requires `target: tool_result` and only `events: [tool_result]`. In repair/block mode the Correction text surrounds the result payload before delivery to Claude. Clear results are unchanged; unknown/unavailable results receive the instruction with an incomplete-review warning. Observe mode never replaces content. Each result is checked independently of response correction caps.
- `on_failure: block` requires `target: tool_call` and only `events: [tool_start]`. In repair/block mode inconclusive, missing, truncated, unavailable or stale review and state failures deny eligible calls. Without it, the existing fail-open behavior remains. A local prefilter miss is clear, not a failure. Broad prefilters can hold reads as well as writes during outages.
- `include_evidence: false` omits captured source text from agent feedback. Evidence remains in the local journal and, for Jev rules, the remote review request.

Claude replacement uses `PostToolUse.updatedToolOutput`. Structured Read text, Bash payload fields and MCP content blocks retain their metadata and non-text data. Unsupported/binary results, failed tool calls (`PostToolUseFailure` has no replacement field), Codex and omp receive a warning alongside the result. A crashed/timed-out post-tool hook can leave the original result without a wrapper. This is an advisory wrapper, not an ingestion barrier. Pre-tool command-hook failures are held using Claude's `onFailure: block` (requires Claude Code 2.1.295+); startup errors deny pre-tool calls.

For approval gates, define approved disclosure as a clear outcome in the detector: inspect the specific pending content and destination against the user's request and conversation. A blocked call can be retried after explicit approval in chat; there is no new native permission popup. General requests to produce a document do not imply approval to disclose restricted content. Opaque scripts cannot be content-scanned from their arguments: classify an uninspectable write as unknown, so `on_failure: block` holds it. This does not add sandboxing or inspect hidden side effects of arbitrary programs.

Example frontmatter controls for a result policy:

```yaml
events: [tool_result]
target: tool_result
delivery: wrap
include_evidence: false
```

Put the actual warning and consent instructions in `## Correction`, not in plugin source code.

## JSONL evaluation fixtures

Use one JSON object per line with this shape:

```json
{"id":"case-clear-1","labelSource":"generated","split":"development","snapshot":{"eventKind":"response_end","request":"Run tests and report the result.","response":"The test command failed.","receipts":[{"id":"tool-1","tool":"npm test","input":"npm test","result":"1 test failed","status":"failure"}],"changes":[],"thinking":[],"coverage":{}},"expected":"clear"}
```

`labelSource` is `generated` unless a person actually reviewed and labeled that example; never represent generated labels as human-verified. `split` is `development` or `holdout`. Expected outcomes are `violation`, `clear`, or `unknown`. Include ambiguous and missing-evidence examples when they are meaningful. Keep holdout examples separate while tuning instructions and thresholds.

Run saved examples with `node <plugin-root>/dist/agent-rules.js evaluate <policy-file> --fixtures <jsonl-file>`. Use `--out <report>` to save a report and `compare --replay <report>` to compare a saved result. Live evaluation is explicit via `--live`; pass credentials only through the host environment or an explicitly named `--env-file <path>`. Do not include secrets in fixtures or reports.
