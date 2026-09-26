# Claude Code's auto mode classifier compared with Agent Rules

Claude Code has a built-in classifier. It is the safety check behind **auto
mode**: it decides whether a tool call can run without asking the user. This note
describes how that classifier works and how it differs from Agent Rules.

Facts about Claude Code come from Anthropic's documentation and engineering post,
checked against Claude Code 2.1.281 docs on 24 September 2026. Items that come
only from third parties are marked.

## How the auto mode classifier works

### A separate model call

- The main agent does not judge its own actions. A separate model request judges
  each checked action.
- The check runs **before** the tool runs. A blocked action does not run.
- From v2.1.278, Claude Code asks the Anthropic server to do the check as part of
  the session's own model requests. Where the server does it, there is no separate
  classifier call. Where it cannot (some platforms and regions), Claude Code sends
  its own classifier requests. `/status` shows **Auto mode server: Enabled** when
  the server checks decide the session's actions.

### Model

- The classifier runs on **Claude Sonnet 5** by default, whatever the `/model`
  choice is.
- A classifier model that Anthropic configures server-side takes precedence.
- If the session model is Sonnet 4.6, or `availableModels` excludes Sonnet 5, the
  classifier uses the session model. A session on a Fable model uses an Opus model.
- The first auto mode request in a session checks that Sonnet 5 is available. The
  classifier model then stays fixed for the session.

### Two stages

1. A fast filter emits one token: block or allow. It is tuned to block when unsure.
   It flags about 8.5% of real actions.
2. Only a flagged action goes to stage 2. Stage 2 reasons step by step over the same
   input. The prompt is identical apart from the final instruction, so stage 2 is
   almost all prompt-cache hits.

Published results: 0.4% false positives on real traffic. Misses are 17% on a set of
52 real overeager actions and 5.7% on a synthetic set of 1,000. The false-positive
and miss rates come from different datasets. Anthropic attributes most misses to the
classifier accepting approval-like text that does not cover the action's full blast
radius.

### Input and long context

- The classifier sees **user messages, the agent's tool calls, and CLAUDE.md**.
- It **removes the agent's own messages and all tool output**. Anthropic calls this
  "reasoning-blind by design". The agent cannot argue for its action, and hostile
  text in files or web pages cannot reach the classifier.
- A `PostToolUse` hook can add a `classifierContext` field to a tool result. The
  classifier reads it as application-provided context (v2.1.236 or later).
- A separate server-side probe scans tool results for prompt injection before the
  agent reads them.
- Long context is handled by sending less text, not by chunking. If the stripped
  transcript still exceeds the model's window, Claude Code reports "transcript
  exceeded context window" and the action is denied.
- Boundaries the user states ("don't push") are re-read from the transcript on
  each check. Compaction can remove them.

### Scope

- File reads and edits in the working directory skip the classifier, except
  protected paths. Most checks are shell commands and network operations.
- It also reviews subagent tasks (at spawn, per action, and the final report),
  `SendMessage` content, and `rm` of critical paths.
- Output is allow, `soft_deny` (allowed if the user clearly approved it) or
  `hard_deny`. A block returns a reason, usually the name of the matched rule, and
  the agent tries another approach.
- After 3 blocks in a row, or 20 in a session, Claude Code falls back to asking the
  user (reported by third parties; not found in the official docs). A classifier
  error denies the action.

### Cost

- On Enterprise and API accounts, and on Bedrock, Vertex and Foundry, classifier
  calls count as token usage. Where the server does the check, there are no
  separate calls to count.
- Pro, Max and Team plans never show the notice for billed local classifier
  requests. The docs do not state directly whether checks count against
  subscription usage limits.

### When it does not run

- It runs only in auto mode, and in plan mode where plan mode uses the classifier.
- `--dangerously-skip-permissions` (`bypassPermissions`) disables permission prompts
  and safety checks. The classifier does not run. Fixed checks still apply: actions
  no mode auto-approves, critical-path `rm`, and two cross-session message checks.
  The docs state this mode offers no protection against prompt injection.
- To stop the classifier: press `Shift+Tab` out of auto mode, start with
  `claude --permission-mode default`, set `permissions.defaultMode` in
  `~/.claude/settings.json`, or set `disableAutoMode`.

## Comparison with Agent Rules

| | Claude Code auto mode | Agent Rules |
|---|---|---|
| Purpose | Stop unsafe **actions** | Correct unwanted **behavior** in replies and work |
| When it runs | Before a tool call (blocking) | After the reply, on the `Stop` hook (`response_end`) |
| Question asked | One fixed question: is this action safe and intended? | One question per policy in `policies/*.md`, written by the user |
| Model | Sonnet 5 by default, server-configurable | Jev `jev-1.13.0` via TypeSafe System One |
| Model window | Full Claude context window | 64k tokens total, 32k for state plus the longest question |
| Input | User messages, tool calls, CLAUDE.md. Replies and tool output removed | Request, response, tool inputs and results, changes, exposed thinking |
| Long input | Strip the transcript. Too long = deny | Chunk into overlapping windows under 24,000 characters, up to 4 requests (`maxReviewRequests`, 1–8) |
| Aggregation | One judgment | Unanimous clear or violation across chunks, otherwise unknown |
| Output | Allow / soft deny / hard deny, with a reason | Probabilities per option, fired by per-policy thresholds (for example `min_probability: 0.90`) |
| Staging | Fast one-token filter, then reasoning only when flagged | Single pass per chunk |
| On failure or timeout | Deny the action | Abstain; no correction (default deadline 2,000 ms) |
| Effect | Action blocked, agent retries another way | Turn stopped and the correction sent to the agent (`repair`), or logged only (`observe`) |
| Limit | 3 in a row or 20 per session, then ask the user (third-party report) | `maxCorrectionsPerEpisode`, 2 by default |
| Cost | Free where the server checks; token usage otherwise | Separate TypeSafe API call per review request |

### Why the designs differ

- Auto mode judges actions, so it can drop the agent's replies and still see what
  matters. Agent Rules judges behavior in the reply, so the reply is its main input.
- Removing tool output protects auto mode from prompt injection. Agent Rules reads
  tool output, so its policies must treat that text as evidence, not instructions.
- Auto mode runs on a large model and does not need chunking. Jev's smaller window
  is the reason Agent Rules chunks and requires unanimous chunk judgments.
- Auto mode fails closed because a wrong allow can cause damage. Agent Rules fails
  open because a missed correction costs less than blocking a valid reply.
- Auto mode checks before the action and so prevents it. Agent Rules checks after
  the reply is written, so the user sees the first reply and then the corrected one.
- An agent that knows a policy may refuse before any check runs. Auto mode avoids
  this effect by hiding the agent's reasoning from the classifier; Agent Rules
  reads the reply, so a pre-emptive refusal passes as clear.

### Ideas worth considering

- A fast first pass that sends only flagged replies to a full review.
- A `PostToolUse` hook that sets `classifierContext`, so an Agent Rules finding can
  inform auto mode decisions.

## Sources

- [How we built Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode) (Anthropic engineering)
- [Choose a permission mode](https://code.claude.com/docs/en/permission-modes.md)
- [Auto mode configuration](https://code.claude.com/docs/en/auto-mode-config.md)
- [Auto mode classifier request charges](https://code.claude.com/docs/en/auto-mode-classifier-billing.md)
- [Claude Code changelog](https://code.claude.com/docs/en/changelog.md), v2.1.278–2.1.281
- [Auto mode as the default](https://claude.com/blog/auto-mode-default-in-claude-code) (Anthropic blog)
- [Simon Willison on auto mode](https://simonwillison.net/2026/Mar/24/auto-mode-for-claude-code/) (third party)
- Agent Rules: `src/review-chunks.js`, `src/review.js`, `src/config.js`,
  `src/runtime.js`, [bounded evidence chunking](2026-09-24-chunking.md)
