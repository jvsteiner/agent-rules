# SDD ledger — plan: docs/superpowers/plans/2026-10-11-tool-result-wrapping.md

Task 1: complete — generic catalog controls and current-result candidates added. Initial 12 tests failed on unsupported fields; all passed after implementation.
Task 2: complete — generic wrappers and failure gates added; focused suite 17/17, full suite 168/168 before additional five coverage tests.
Ruling: approvals use the existing chat pattern, not a native permission popup — the user explicitly chose the commit-rule behavior. Cost: approval depends on the semantic detector recognizing the bounded user consent.
Ruling: unsupported results/hosts get explicit additional-context fallback — never send a schema-invalid replacement and imply it worked. Incoming wrapping is advisory and best-effort; the separate write gate enforces eligible calls.
Ruling: work remains uncommitted in an isolated worktree under ~/.codex/worktrees — no commit, merge or publish is authorized.
Task 3: complete — global rules validated and enabled. Plugin 0.2.24 installed in Claude Code, Codex and omp; cache manifests verified. Source changes brought back into ~/Code/agent-rules, uncommitted. Final suite 178/178; git diff --check clean.
Live host probe: Claude 2.1.296 accepted production Read and Bash replacements; model confirmed wrapper markers for both.
Final: fixed truncated regex/prefilter bypass — two regression tests RED→GREEN.
Final: fixed ID-less out-of-order result selection — regression test RED→GREEN.
Final: fixed historical truncation contaminating current-only results — regression test RED→GREEN. Focused suite 21/21.
Calibration: initial write fixtures 12/13; permission for one sensitive field falsely allowed additional fields. Implementation will not enable that rule without correcting the approval boundary. Asked Jamie whether to use native exact-call approval instead of semantic chat approval. Incoming warning fixtures 3/4; tightened ambiguous-field instructions.
Calibration after correction: incoming fixtures 4/4. Write fixtures 11/13 exact matches, with two uncertain results held rather than allowed; fresh holdout 7/8 exact matches, with the opaque write classified as violation rather than unknown (both held). No unapproved disclosure passed the revised fixtures. Explicit full approval passed; a short yes may remain held. Kept the user-authorized commit-rule chat pattern; native permission prompting remains an optional alternative, not implemented.
Production-bundle check with actual global policies: incoming structured Read result wrapped; unapproved sensitive Write denied; explicit full approval allowed the write. Only synthetic data used.
Final: fixed integration-test contamination from personal policies — 3 failing subprocess tests RED→GREEN by copying the built plugin and supplying explicit fixture configuration. No production behavior changed for this test isolation.
Limitations: classifier screening remains probabilistic. Opaque generated writes cannot be inspected from command text. Unsupported/binary result shapes and non-Claude hosts receive an alongside warning. Cowork has not been verified. Open sessions must restart (Codex must trust updated hooks).
