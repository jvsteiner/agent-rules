# Cat-rule failure and audit-history fix

The latest retained record from the reported Claude session shows
`communication.cat-pictures` as `unknown` with
`judgment.reason: evidence_budget_exceeded`, not a violation. Its snapshot contained
1,595 response characters, 99 request characters, and approximately 26,914 characters
of serialized tool receipts. The generic notice obscured this specific cause.
The previous episode had already been erased, so this does not establish what
happened on the user's original test response.

The reviewer previously combined every eligible policy's evidence into one request.
A receipt-heavy verification rule could push that request over 24,000 characters,
causing even a short response-only cat rule to abstain. The reviewer now adds only
tasks that fit within the single request budget and explicitly records omitted
tasks. Shared evidence and question indices retain their original wire format.
There are no additional requests or automatic retries.

Findings now include diagnostic codes/messages for missing evidence, absent
candidates, budget limits, uncertain judgments, malformed/missing answers, and
transport/deadline failures. Classified findings retain their decision thresholds.
Runtime notices name the affected rules and reasons.

The per-session JSON journal now keeps bounded review history across user prompts,
including episode, sequence, timestamp, findings and actual requested outcome.
Historical evidence can be explicitly truncated to enforce retention bounds.
Existing current findings migrate before the next episode reset; already-erased
findings cannot be recovered. `inspect <rule-id> --session <host-session-id>`
filters history, and the new `diagnose-rule` skill explains how to use it.

The cat policy's repair guidance previously instructed a refusal that repeated
the banned topic. It now requests a refusal without naming that topic. The rule's
classification criteria and thresholds were not relaxed.

Verification:

- Full suite: 124 passing tests, no failures or skips; bundles rebuilt.
- Integration regression: actual bundled policies, three large tool receipts,
  correction requested, next user prompt, and CLI inspection of the prior verdict.
- Reviewer regressions: oversized rule before/after small rule; preserved shared
  evidence format; explicit abstention and service-failure diagnostics.
- One live Jev request with 27,000 characters of synthetic receipts. The transmitted
  request was 2,278 characters (846 input tokens, 83 output tokens). Jev 1.13.0
  classified the explicit cat-picture example as a violation with probability 1.0;
  the receipt-dependent rule abstained with `input_budget_exceeded`.
- Cat policy, plugin, and new diagnostic skill validation passed.

The live check is one synthetic regression example, not a claim of classifier
accuracy. It did not replay the user's original answer or modify their session.
