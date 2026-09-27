---
name: author-rule
description: Create, validate, calibrate, and enable Agent Rules policies from a user's concrete behavioral preference. Use when the user asks to add or refine a behavior rule; do not use for ordinary code checks or generic policy writing.
---

# Author an Agent Rules policy

Turn the user's preference into one narrow, observable check that can be judged from the available request, response, execution receipts, code changes, thinking, or constraints. Ask only for details needed to distinguish a violation from a reasonable exception. Do not broaden a preference into a judgment of intent or personality.

Read [references/policy-format.md](references/policy-format.md) when creating or changing a policy or its fixtures. Pick the earliest check point that can see the behavior: a `request` check stops unwanted work before it starts, a `tool_call` check blocks an action before it runs, and a `response` check corrects the finished reply. A preference may need more than one policy, one per check point. Prefer the earlier check points: a `response` repair makes the agent rewrite a finished reply, which costs a second full answer, while a `request` or `tool_call` check stops the work before it is done. Write the Markdown policy in a directory the hook reads live. Claude Code, Codex, and omp all read these directories on every event, so the policy applies in all three on the next event, with no build or restart:

- `~/.config/agent-rules/rules/` for every project. Use this unless the user asks for one project only.
- `<project>/.agent-rules/rules/` for one project.

Set its mode in the matching `config.json` (`~/.config/agent-rules/config.json` or `<project>/.agent-rules/config.json`) with `set-mode <id> <mode> --scope user` or `--scope project`; all three hosts read the same files.

Policies in the Agent Rules checkout's own `policies/` folder ship inside the installed plugin. A new or changed file there applies only after `npm run install-hosts` in the checkout and a restart of open sessions. Tell the user this when you write there.

Regex code rules in the checkout's `rules/` folder are also live in all three hosts: omp reads them through `~/.omp/agent/rules`, and the Claude and Codex hooks read the same folder. Keep `Why` explanatory; put all classifier-relevant distinctions in the detector instructions and criteria. Make the Correction section actionable and faithful to the user's requested behavior.

Validate the policy with `node <plugin-root>/dist/agent-rules.js validate <policy-file>`. Create JSONL examples from realistic snapshots, including clear, violating, and ambiguous cases where applicable. Mark generated labels as generated; never imply a generated label was reviewed by a person. Use development examples while refining, then evaluate against a separate holdout set. Use replay reports to compare revisions when available.

Use `evaluate --fixtures <file>` for saved examples. Use `evaluate --live` only when live evaluation is useful and consistent with the user's request; this can send selected evidence to the configured model. An explicit `--env-file <path>` may load credentials for that run. Never auto-load a repository `.env`, expose secret values, or write credentials into policies or reports. `--config <path>` selects an explicit configuration.

Modes are `off`, `observe`, `repair`, and `block`. `block` rejects a matching request before the model sees it; use it for a request policy when the user wants the work refused outright, because a `repair` correction is advice a model can ignore. New rules start in `observe` unless the user explicitly asks to enable correction. After validation, evaluation, and any requested calibration, honor an explicit request to create and enable the policy by running `set-mode <id> repair`; do not add an approval step for routine local policy edits. If evidence is too weak or evaluation finds false positives, keep it in observe and explain the limitation. Use `inspect <id>` and `status` to report the effective policy and current mode. The CLI also supports `compare --replay <report>` and `evaluate --out <report>` for recorded evaluation workflows.
