# Implementation results — 24 September 2026

Agent Rules 0.2.0 implements the bounded review and correction workflow in the
[implementation plan](2026-09-24-implementation-plan.md). Authenticated Claude Code
and Codex sessions both completed a Jev-triggered correction and recheck. The
checkout contains the implementation and installable bundles; no global plugin
installation or publishing was performed.

## Delivered

- Editable Markdown policies with validated YAML, stable hashes, scoped overrides,
  repair/observe/off modes, and Choice, Noul, Score, and regex detectors.
- A shared runtime/evaluation engine and authenticated Jev transport with a deadline,
  no network retries, evidence requirements, redaction, and explicit abstention.
- Claude/Codex adapters, correlated tool receipts, latest completed changes per path,
  and journaled findings, judgments, policy hashes, and correction history.
- At most two semantic correction deliveries per user episode by default, with
  concurrency control, deduplication, stale-result rejection, and health notices.
- An LLM authoring skill and validate/evaluate/compare/inspect/status/set-mode CLI.
- Four starter policies, generated evaluation cases, replayable reports, bundled
  hooks requiring no package download, and deterministic CI on Node 20 and 24.
- Compatibility with the original ten regex rules and their tests.

The Jev integration uses a small direct-fetch client rather than the initially
considered SDK. This makes request deadlines and absence of retries explicit.
Implementation work was delegated to Luna agents; live host probes were bounded.

## Verification

Final local environment: Node 24.13.0, npm 11.6.2, Claude Code 2.1.281,
Codex 0.156.1. Both hosts were authenticated. The ignored `.env` key successfully
authenticated to `https://api.typesafe.ai/v1/systemone`, model `jev-1.13.0`.

| Check | Result |
|---|---|
| Original baseline | 58 tests passed |
| Final `npm test`, including bundle build | 117 passed; zero failures or skips |
| `npm run test:coverage` | Passed; runtime 100% line / 89.62% branch coverage |
| `node dist/agent-rules.js validate policies` | Four valid policies, no diagnostics |
| Codex plugin validator | Passed |
| Authoring skill validator | Passed |
| `claude plugin validate .` | Passed |
| `git diff --check` | Passed |
| Exact credential scan of nonignored deliverables | No matches; `.env` untracked |

Coverage is diagnostic, not a correctness guarantee. Whole-run coverage including
bundles and supporting files was 87.85% lines and 60.85% branches. Local tests ran
on Node 24; the added CI matrix supplies Node 20 validation when CI runs.

The deterministic suite includes real hook subprocesses, a local HTTP server for
request/authentication/abort/error behavior, simultaneous journal writers, stale
results, missing/corrupt state, exhausted budgets, unavailable service, evidence
replacement after edits, and copied bundles under paths with spaces without
`node_modules`. Sanitized observed host fixtures are in `test/fixtures/hosts/`.

Actual host probes used isolated temporary projects and a synthetic marker policy:
the first answer contained `PROBE_INITIAL`, Jev classified it, feedback requested
`PROBE_CORRECTED`, and the host corrected and was rechecked. Both hosts completed
this sequence. A separate Codex receipt probe ran an intentionally failing command.
Its tool response supplied stdout without an exit code; the adapter records
completion without inventing success or failure.

The authoring exercise produced a new observe-only policy for capability-only
answers, four development cases and two holdout cases, and a 6/6 live evaluation in
an isolated directory. Those labels were generated, not human reviewed.

## Live starter-policy evaluations

The committed reports in `evals/reports/` retain model, policy hashes, inputs,
judgments, usage, and generated-label provenance.

| Policy | Expected outcomes matched | Default mode |
|---|---|---|
| Test-result contradiction | 10/10, including two expected unknowns | repair |
| Unexplained jargon | 5/5, including one expected unknown | observe |
| Premature completion | 4/5; unexpected abstention on one holdout | observe |
| Swallowed error | 3/3, including one expected unknown | observe |

The completion evaluation deliberately exits unsuccessfully for its mismatch.
The missed case received an insufficiently decisive judgment; it was not silently
treated as clear. Its policy remains observe-only, without tuning against that
holdout. The verification policy was refined after an earlier 8/10 run; a case
marked holdout was seen during refinement, so its final report is not an independent
holdout estimate. These small generated sets demonstrate examples, not production
accuracy, calibrated probabilities, or reliable judgments of an agent's intent.

## Host limitations and remaining scope

- Claude's tested headless stream displays intervention notices. Codex
  `exec --json` omits hook `systemMessage`, although correction works. Findings
  remain available through `inspect`; interactive/desktop notice rendering is
  unconfirmed. The user's desired visibility is therefore only partly verified
  across host surfaces.
- The engine accepts explicitly exposed thinking segments with provenance and
  completeness metadata. Ordinary observed hooks supplied no thinking text.
  Automatic transcript extraction and an end-to-end thinking audit are not
  implemented or claimed. Hidden reasoning is inaccessible.
- Semantic code evidence covers supported direct edits and patches. Arbitrary
  shell writes are not comprehensively attributed or reconstructed.
- Missing evidence and overlarge review inputs abstain. Tool receipts are only as
  informative as the host payload; a tool completing is not proof that it passed.
- Secret-pattern redaction is partial. Selected evidence is sent to TypeSafe;
  private journal permissions and retention bounds do not make this comprehensive
  data-loss prevention.
- Broad deception, malicious-compliance, and intent classification remain future
  policy-authoring/evaluation work. The shipped policies are narrower checks.

## Run and extend

See the [README](../README.md) for installation, configuration, and evaluation.
For a local Claude session using the explicit ignored key file:

```sh
node tools/with-key.mjs .env claude --plugin-dir .
```

Ask the installed `author-rule` skill to draft a narrow policy and evaluate it.
Keep new policies in observe mode until their disagreements and evidence needs
are understood. Reuse saved reports for offline iteration; real host probes need
not run during routine tests.
