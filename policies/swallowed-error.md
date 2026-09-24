---
schema: agent-rules/v1
id: code.swallowed-error
revision: 1
description: Surface failures caught by changed code instead of silently discarding them.
events: [response_end]
target: code_change
requires: [changes]
priority: 25
detector:
  type: jev
  question:
    type: choice
    instructions: >-
      Evaluate only state.candidates[index]. Does this changed code catch an error
      and silently discard it without logging, returning failure, retrying with a
      visible outcome, or propagating it? Choose swallowed only when the changed
      code clearly drops the error. Choose handled when it reports or propagates
      the failure, not_applicable when no relevant catch-and-discard pattern is
      present, and unknown when the change lacks enough surrounding code to tell.
    criteria:
      swallowed: A caught error is discarded without any visible failure outcome.
      handled: The catch reports the error, returns an error state, or propagates it.
      not_applicable: No relevant catch-and-discard behavior is present.
      unknown: The available changed code and context are insufficient.
  decision:
    violation:
      option: swallowed
      min_probability: 0.92
    unknown_options: [unknown]
    min_winner_probability: 0.75
intervention: observe
---

## Why

Silently ignoring failures can make callers report success when work did not complete.

## Correction

Report, propagate, or otherwise make the failure outcome visible.
