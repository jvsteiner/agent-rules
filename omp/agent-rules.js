// Agent Rules for omp. Translates omp extension events into Claude-shaped hook
// payloads and runs the same bundled hook the Claude and Codex plugins run, so
// all three hosts share policies, modes, and correction limits.
// tools/install-hosts.mjs replaces __AGENT_RULES_HOOK__ with the installed path.
import { spawn } from 'node:child_process';

const HOOK = '__AGENT_RULES_HOOK__';

const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function text(value) {
  if (typeof value === 'string') return value;
  const content = Array.isArray(value) ? value : record(value).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const joined = content.map(record).filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text).join('\n');
  return joined || undefined;
}

// omp tool names are lowercase; the shared hook recognizes Claude's names for file changes.
function claudeTool(name, rawInput) {
  const input = record(rawInput);
  const withPath = { ...input, file_path: input.path ?? input.file_path };
  if (name === 'write') return { tool_name: 'Write', tool_input: withPath };
  if (name === 'edit') return { tool_name: 'Edit', tool_input: withPath };
  if (name === 'bash') return { tool_name: 'Bash', tool_input: input };
  return { tool_name: String(name), tool_input: input };
}

function run(hook, payload) {
  return new Promise((resolve) => {
    // omp enforces the regex rules itself (TTSR); the hook reviews Jev policies only.
    const child = spawn(process.env.AGENT_RULES_NODE ?? 'node', [hook, 'claude'],
      { env: { ...process.env, AGENT_RULES_LEGACY: '0' }, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve({ systemMessage: 'Agent Rules: hook unavailable. Reinstall with npm run install-hosts.' }); });
    child.on('close', () => { clearTimeout(timer); try { resolve(out ? record(JSON.parse(out)) : {}); } catch { resolve({}); } });
    child.stdin.end(JSON.stringify(payload));
  });
}

export function createExtension(hook) {
  return function (pi) {
    async function send(hookEventName, fields, ctx) {
      const reply = await run(hook, { hook_event_name: hookEventName, session_id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, ...fields });
      if (reply.systemMessage && ctx.hasUI) ctx.ui.notify(reply.systemMessage, reply.decision === 'block' ? 'warning' : 'info');
      return reply;
    }

    pi.on('session_start', async (_event, ctx) => { await send('SessionStart', {}, ctx); });
    // before_agent_start fires for every prompt in every mode; `input` is interactive-only.
    // A prompt that repeats our own correction is its continuation, not a new request.
    let pendingCorrection;
    pi.on('before_agent_start', async (event, ctx) => {
      const prompt = typeof event.prompt === 'string' ? event.prompt : '';
      const continuation = pendingCorrection !== undefined && prompt.includes(pendingCorrection);
      pendingCorrection = undefined;
      if (!continuation) await send('UserPromptSubmit', { prompt }, ctx);
    });
    pi.on('tool_call', async (event, ctx) => {
      await send('PreToolUse', { tool_use_id: event.toolCallId, ...claudeTool(event.toolName, event.input) }, ctx);
    });
    pi.on('tool_result', async (event, ctx) => {
      await send(event.isError ? 'PostToolUseFailure' : 'PostToolUse',
        { tool_use_id: event.toolCallId, ...claudeTool(event.toolName, event.input), tool_response: text(event.content) }, ctx);
    });
    pi.on('session_stop', async (event, ctx) => {
      const reply = await send('Stop', { last_assistant_message: text(event.last_assistant_message), stop_hook_active: event.stop_hook_active }, ctx);
      if (reply.decision === 'block' && reply.reason) { pendingCorrection = reply.reason; return { decision: 'block', reason: reply.reason }; }
      return undefined;
    });
    pi.on('session_shutdown', async (_event, ctx) => { await send('SessionEnd', {}, ctx); });
  };
}

export default createExtension(HOOK);
