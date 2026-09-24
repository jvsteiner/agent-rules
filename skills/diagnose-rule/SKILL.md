---
name: diagnose-rule
description: Explain why an Agent Rules policy fired, abstained, or failed to correct, using recorded session judgments and outcomes. Use when debugging a rule or investigating a plugin notice.
---

# Diagnose a rule

Use the installed plugin's `dist/agent-rules.js`, located two directories above
this skill directory. Run `status` from the affected project to obtain effective
modes, configuration diagnostics, and the state directory. Run `inspect <rule-id>`
to read current findings and historical `records`; use `--session <session-id>`
when the affected host session ID is available. Match the episode, timestamp, and
evidence to the reply the user means before drawing conclusions. Different
sessions can contain different outcomes for the same policy.

The session JSON files are the journals; there is no separate file named
`journal`. New user prompts reset the current episode's retry counter and findings,
but bounded review history survives. Old versions erased previous episodes, and
retention can expire records. If the requested result is absent, state that it
cannot be established from the retained evidence.

Explain the finding's status, diagnostic, raw judgment, policy hash, thresholds,
and the recorded outcome. `violation` is a positive classification, `clear` is a
negative classification, `unknown` is an abstention, and `unavailable` is a failed
evaluation. An observe-mode violation does not request correction. A repair-mode
violation may still produce no correction because of deduplication or retry limits;
consult the recorded outcome. `continue_turn` records a requested correction, not
proof that the host displayed a notice or that the agent obeyed it.

Use diagnostics to distinguish missing evidence, a request-size limit, an
uncertain judgment, and service failure. Do not infer a detected violation from
an inconclusive-review notice. Do not infer classifier results from the mere
presence of a word in the response.

A live replay is a new paid evaluation and cannot recover the original verdict.
Start with local records, then replay only if it helps answer the remaining
question within the user's authorized task. Do not silently change thresholds,
disable policies, or weaken the user's rule to explain a failure.
