# Tool-result wrapping Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task. Jamie authorized implementation; work remains local and uncommitted.

**Goal:** Let any policy wrap current tool results and hold pre-tool actions when review cannot establish compliance.

**Architecture:** Catalog validates independent delivery/failure/feedback controls. Reviewer selects the current result. Runtime emits a generic wrapping effect or denies an unchecked call, and host adapters preserve structured output while delivering rule-supplied text.

**Tech Stack:** Node ESM, YAML, node:test.

**Spec:** `docs/superpowers/specs/2026-10-11-tool-result-wrapping-design.md`

## Global Constraints

- No commercial-content detection or warning text in production code.
- Defaults and ordinary correction behavior remain compatible.
- No commits, pushes, releases or computer use.
- Version bump and install-local/status required.

## Review Focus

- Preserve structured metadata and non-text blocks; test Read, Bash and MCP.
- Review the latest result in full, not historical/clipped output.
- Wrap repeated results despite correction caps, and do not wrap clear/observe results.
- Unknown, missing, stale and unavailable gated reviews deny; unrelated policies/prefilter misses do not.
- Approved sensitive retry passes; permission for a different destination/action does not.

### Task 1: Policy controls and current-result review

Files: `src/catalog.js`, `src/review.js`, `src/runtime.js`, `test/tool-delivery.test.js`.

- [x] Add failing catalog/reviewer tests for `target: tool_result`, `delivery: wrap`, `on_failure: block`, `include_evidence: false`; reject incompatible settings.
- [x] Run tests and verify feature failures.
- [x] Implement controls and current-result candidate capture with coverage protection.
- [x] Verify full current text and unchanged prior behavior.

### Task 2: Runtime and host delivery

Files: `src/runtime.js`, `src/platforms.js`, `src/tool-output.js`, `bin/behavior-hook.js`, `hooks/claude.json`, `test/tool-delivery.test.js`.

- [x] Add failing tests for schema-preserving wrappers, repeated/clear/observe results, evidence omission and denied failed/stale reviews.
- [x] Implement generic effects and host-aware replacement/fallback. Scope failure blocking to eligible active policy controls. Harden the pre-tool hook failure path.
- [x] Run focused tests, then full suite.

### Task 3: User rules, documentation and installation

Files: global rules/fixtures under `~/.config/agent-rules/rules`, `README.md`, `skills/author-rule/references/policy-format.md`, versioned build artifacts/manifests.

- [x] Update commercial rules with approval exception and rule-defined wrapper; add synthetic approval/result fixtures.
- [x] Validate and evaluate rules, record behavioral limitations honestly.
- [x] Document general controls, host/result coverage and remote-review boundary.
- [x] Run full suite, `npm version patch --no-git-tag-version`, `make install-local`, `make status`; inspect final diff.
