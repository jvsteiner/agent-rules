import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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
  const ctx = { cwd, hasUI: true, sessionManager: { getSessionId: () => 'omp-session' }, ui: { notify: (message) => notices.push(message) } };
  return { emit: (name, event) => handlers[name](event, ctx), handlers, notices };
}

test('omp extension registers the lifecycle events the shared hook needs', () => {
  const { handlers } = host(project());
  assert.deepEqual(Object.keys(handlers).sort(), ['before_agent_start', 'session_shutdown', 'session_start', 'session_stop', 'tool_call', 'tool_result']);
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
