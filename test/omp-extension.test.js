import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createExtension } from '../omp/agent-rules.js';

function project() {
  const cwd = mkdtempSync(join(tmpdir(), 'agent-rules omp '));
  mkdirSync(join(cwd, '.agent-rules/rules'), { recursive: true });
  writeFileSync(join(cwd, '.agent-rules/config.json'), JSON.stringify({ rules: { 'reporting.test-result-contradiction': 'off', 'reporting.premature-completion': 'off', 'communication.unexplained-jargon': 'off', 'communication.cat-pictures': 'off' } }));
  writeFileSync(join(cwd, '.agent-rules/rules/demo.md'), `---\nschema: agent-rules/v1\nid: demo\ndescription: Replace the deliberate trigger.\nevents: [response_end]\ntarget: response\nrequires: [response]\npriority: 90\ndetector:\n  type: regex\n  pattern: TRIGGER\nintervention: repair\n---\n## Correction\nReplace TRIGGER with CORRECTED.\n`);
  return cwd;
}

function host(cwd) {
  const handlers = {}; const notices = [];
  createExtension(resolve('bin/behavior-hook.js'))({ on: (name, handler) => { handlers[name] = handler; } });
  const aborts = []; const widgets = {};
  const ctx = { cwd, hasUI: true, sessionManager: { getSessionId: () => 'omp-session' }, abort: () => aborts.push(true),
    ui: { notify: (message) => notices.push(message), setWidget: (key, lines) => { widgets[key] = lines; } } };
  return { emit: (name, event) => handlers[name](event, ctx), handlers, notices, aborts, widgets };
}

test('omp extension registers the lifecycle events the shared hook needs', () => {
  const { handlers } = host(project());
  assert.deepEqual(Object.keys(handlers).sort(), ['before_agent_start', 'input', 'session_shutdown', 'session_start', 'session_stop', 'tool_call', 'tool_result']);
});

test('omp session_stop runs the shared hook: correction, then clear after the fix', async () => {
  const cwd = project(); process.env.AGENT_RULES_STATE_DIR = join(cwd, 'state');
  try {
    const omp = host(cwd);
    await omp.emit('before_agent_start', { prompt: 'Do the work.', systemPrompt: [] });
    const first = await omp.emit('session_stop', { last_assistant_message: { role: 'assistant', content: [{ type: 'text', text: 'TRIGGER' }] }, stop_hook_active: false });
    assert.equal(first.decision, 'block'); assert.match(first.reason, /CORRECTED/);
    assert.ok(omp.notices.some((n) => /Agent Rules: demo \(1\/2\)/.test(n)));
    const fixed = await omp.emit('session_stop', { last_assistant_message: { role: 'assistant', content: [{ type: 'text', text: 'CORRECTED' }] }, stop_hook_active: true });
    assert.equal(fixed, undefined);
  } finally { delete process.env.AGENT_RULES_STATE_DIR; }
});

function policy(cwd, id, events, target, pattern, mode = 'repair') {
  writeFileSync(join(cwd, `.agent-rules/rules/${id}.md`), `---\nschema: agent-rules/v1\nid: ${id}\ndescription: Probe ${id}.\nevents: [${events}]\ntarget: ${target}\nrequires: []\npriority: 90\ndetector:\n  type: regex\n  pattern: ${pattern}\nintervention: ${mode}\n---\n## Correction\nDo not handle ${pattern}.\n`);
}

test('omp before_agent_start adds prompt context and tool_call blocks the pending tool', async () => {
  const cwd = project(); process.env.AGENT_RULES_STATE_DIR = join(cwd, 'state');
  policy(cwd, 'prompt-probe', 'user_prompt', 'request', 'BLOCKED_TOPIC');
  policy(cwd, 'tool-probe', 'tool_start', 'tool_call', 'BLOCKED_QUERY');
  try {
    const omp = host(cwd);
    const started = await omp.emit('before_agent_start', { prompt: 'Research BLOCKED_TOPIC.', systemPrompt: [] });
    assert.equal(started.message.customType, 'agent-rules');
    assert.match(started.message.content, /prompt-probe[\s\S]*plugin the user installed[\s\S]*Do not handle BLOCKED_TOPIC/);
    const allowed = await omp.emit('tool_call', { toolCallId: 'a', toolName: 'bash', input: { command: 'ls' } });
    assert.equal(allowed, undefined);
    const blocked = await omp.emit('tool_call', { toolCallId: 'b', toolName: 'bash', input: { command: 'curl BLOCKED_QUERY' } });
    assert.equal(blocked.block, true); assert.match(blocked.reason, /tool-probe/);
  } finally { delete process.env.AGENT_RULES_STATE_DIR; }
});

test('omp block-mode request rule aborts the turn before the model sees the prompt', async () => {
  const cwd = project(); process.env.AGENT_RULES_STATE_DIR = join(cwd, 'state');
  policy(cwd, 'prompt-block', 'user_prompt', 'request', 'BLOCKED_TOPIC', 'block');
  try {
    const omp = host(cwd);
    assert.equal(await omp.emit('before_agent_start', { prompt: 'Research BLOCKED_TOPIC.', systemPrompt: [] }), undefined);
    assert.equal(omp.aborts.length, 1);
    assert.match(omp.widgets['agent-rules'][0], /Agent Rules blocked this request\. prompt-block: Probe prompt-block\./);
    await omp.emit('before_agent_start', { prompt: 'Something else.', systemPrompt: [] });
    assert.equal(omp.aborts.length, 1);
  } finally { delete process.env.AGENT_RULES_STATE_DIR; }
});

test('omp interactive input swallows a blocked prompt, keeps the reason on screen, and reviews each prompt once', async () => {
  const cwd = project(); process.env.AGENT_RULES_STATE_DIR = join(cwd, 'state');
  policy(cwd, 'prompt-block', 'user_prompt', 'request', 'BLOCKED_TOPIC', 'block');
  policy(cwd, 'prompt-note', 'user_prompt', 'request', 'NOTED_TOPIC');
  try {
    const omp = host(cwd);
    assert.deepEqual(await omp.emit('input', { text: 'Research BLOCKED_TOPIC.', source: 'interactive' }), { handled: true });
    assert.match(omp.widgets['agent-rules'][0], /prompt-block/);
    assert.equal(omp.aborts.length, 0);
    assert.equal(await omp.emit('input', { text: 'Research NOTED_TOPIC.', source: 'interactive' }), undefined);
    assert.equal(omp.widgets['agent-rules'], undefined);
    const started = await omp.emit('before_agent_start', { prompt: 'Research NOTED_TOPIC.', systemPrompt: [] });
    assert.match(started.message.content, /prompt-note/);
    // The prompt was reviewed at input; before_agent_start reused that review instead of a second call.
    const state = JSON.parse(readFileSync(join(cwd, 'state', readdirSync(join(cwd, 'state')).find((f) => f.endsWith('.json'))), 'utf8'));
    assert.equal(state.episodeId, 2);
  } finally { delete process.env.AGENT_RULES_STATE_DIR; }
});
