import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parsePolicy } from '../src/catalog.js';
import { createReviewer } from '../src/review.js';
import { handleEvent } from '../src/runtime.js';
import { decode, encode } from '../src/platforms.js';

function source({ target = 'tool_result', extra = '', mode = 'repair', detector = 'regex' } = {}) {
  return `---
schema: agent-rules/v1
id: example.restricted
description: Get permission before reusing restricted content.
events: [${target === 'tool_call' ? 'tool_start' : 'tool_result'}]
target: ${target}
requires: []
uses: [request, conversation]
priority: 100
${extra}
detector:
  type: ${detector}
${detector === 'regex' ? '  pattern: restricted' : `  question:
    type: choice
    instructions: Judge only state.candidates[index].
    criteria:
      unapproved: Restricted and unapproved.
      approved: Approved for this content and destination.
      clear: No restricted content.
      unknown: Cannot tell.
  decision:
    violation:
      option: unapproved
      min_probability: 0.85
    unknown_options: [unknown]
    min_winner_probability: 0.70`}
intervention: ${mode}
---
## Correction
Obtain user permission before writing this restricted content elsewhere.
`;
}
const wrapPolicy = (mode = 'repair') => parsePolicy(source({ mode, extra: 'delivery: wrap\ninclude_evidence: false' }));
const guardPolicy = () => parsePolicy(source({ target: 'tool_call', detector: 'jev', extra: 'on_failure: block\ninclude_evidence: false' }));
const env = async (policies, reviewer = createReviewer()) => ({ policies, reviewer, stateDir: await mkdtemp(join(tmpdir(), 'ar-delivery-')) });
const result = (tool_name, tool_response, tool_use_id = 't') => decode('claude', { hook_event_name: 'PostToolUse', session_id: 's', tool_name, tool_response, tool_use_id, tool_input: {} });
const call = (input) => decode('claude', { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Write', tool_use_id: 'w', tool_input: input });

test('catalog accepts general wrapping and failure controls, rejects incompatible delivery', () => {
  assert.equal(wrapPolicy().delivery, 'wrap');
  assert.equal(guardPolicy().onFailure, 'block');
  assert.equal(guardPolicy().includeEvidence, false);
  assert.throws(() => parsePolicy(source({ target: 'tool_call', extra: 'delivery: wrap' })), /delivery/);
  assert.throws(() => parsePolicy(source({ extra: 'on_failure: block' })), /on_failure/);
  assert.throws(() => parsePolicy(source({ extra: 'include_evidence: nope' })), /include_evidence/);
});

test('reviewer scans only the full current result, including content away from the ends', async () => {
  const p = wrapPolicy();
  const text = 'a'.repeat(1200) + 'restricted' + 'z'.repeat(1200);
  const snapshot = { eventKind: 'tool_result', currentTool: { id: 'new', tool: 'Read', result: text }, receipts: [{ id: 'old', tool: 'Read', result: 'restricted old data', status: 'completed' }] };
  const findings = (await createReviewer().review(snapshot, [p])).findings;
  assert.equal(findings.length, 1);
  assert.equal(findings[0].status, 'violation');
  assert.equal(findings[0].evidence[0].id, 'new');
  assert.ok(findings[0].evidence[0].text.includes(text));
  snapshot.currentTool.result = 'public';
  assert.equal((await createReviewer().review(snapshot, [p])).findings[0].status, 'clear');
});

test('Read result wraps content in place, preserves metadata, repeats beyond correction cap', async () => {
  const ctx = await env([wrapPolicy()]);
  ctx.config = { maxCorrectionsPerEpisode: 0 };
  const raw = { type: 'text', file: { filePath: '/source.txt', content: 'restricted source', numLines: 1, startLine: 1, totalLines: 1 } };
  for (let i = 0; i < 3; i++) {
    const effect = await handleEvent(result('Read', raw, String(i)), ctx);
    const output = encode('claude', effect).hookSpecificOutput?.updatedToolOutput;
    assert.equal(output?.type, 'text');
    assert.equal(output?.file.filePath, '/source.txt');
    assert.equal(output?.file.totalLines, 1);
    assert.match(output.file.content, /permission[\s\S]*restricted source[\s\S]*permission/);
    assert.equal(output.file.content.split('restricted source').length, 2);
    assert.ok(!effect.feedback.includes('restricted source'));
  }
  assert.equal(raw.file.content, 'restricted source');
});

test('Bash replacement preserves structured fields and wraps stdout and stderr', async () => {
  const ctx = await env([wrapPolicy()]);
  const raw = { stdout: 'restricted stdout', stderr: 'restricted stderr', interrupted: false, isImage: false };
  const output = encode('claude', await handleEvent(result('Bash', raw), ctx)).hookSpecificOutput?.updatedToolOutput;
  assert.equal(output?.interrupted, false);
  assert.equal(output?.isImage, false);
  assert.match(output.stdout, /permission[\s\S]*restricted stdout/);
  assert.match(output.stderr, /restricted stderr[\s\S]*permission/);
});

test('MCP wrapper surrounds text and non-text blocks without changing binary data', async () => {
  const ctx = await env([wrapPolicy()]);
  const raw = { content: [{ type: 'text', text: 'restricted' }, { type: 'image', mimeType: 'image/png', data: 'abc' }], isError: false, structuredContent: { amount: 123, label: 'restricted' } };
  const output = encode('claude', await handleEvent(result('mcp__example__read', raw), ctx)).hookSpecificOutput?.updatedToolOutput;
  assert.equal(output?.isError, false);
  assert.deepEqual(output.content.find(x => x.type === 'image'), raw.content[1]);
  assert.match(output.content[0].text, /permission/);
  assert.match(output.content.at(-1).text, /permission/);
  assert.ok(JSON.stringify(output).includes('restricted'));
});

test('clear and observe results do not replace content', async () => {
  for (const [mode, content] of [['repair', 'public'], ['observe', 'restricted']]) {
    const ctx = await env([wrapPolicy(mode)]);
    const encoded = encode('claude', await handleEvent(result('Read', { type: 'text', file: { content } }), ctx));
    assert.equal(encoded.hookSpecificOutput?.updatedToolOutput, undefined);
  }
});

test('inconclusive result review produces a conservative wrapper using the rule instruction', async () => {
  const p = wrapPolicy();
  const ctx = await env([p], { review: async () => ({ findings: [{ ruleId: p.id, status: 'unknown', mode: 'repair' }] }) });
  const encoded = encode('claude', await handleEvent(result('Bash', { stdout: 'raw result', stderr: '', interrupted: false, isImage: false }), ctx));
  assert.match(encoded.hookSpecificOutput.updatedToolOutput.stdout, /incomplete|unavailable|inconclusive/i);
  assert.match(encoded.hookSpecificOutput.updatedToolOutput.stdout, /permission/);
});

test('failure guard denies unknown, missing and throwing reviews without echoing evidence', async () => {
  const p = guardPolicy();
  const reviews = [
    { review: async () => ({ findings: [{ ruleId: p.id, status: 'unknown', diagnostic: { code: 'below_threshold' }, mode: 'repair', evidence: 'restricted secret' }] }) },
    { review: async () => ({ findings: [] }) },
    { review: async () => { throw Error('failed'); } },
  ];
  for (const reviewer of reviews) {
    const ctx = await env([p], reviewer);
    const effect = await handleEvent(call({ file_path: '/dest', content: 'restricted secret' }), ctx);
    assert.equal(effect.action, 'deny_tool');
    assert.equal(encode('claude', effect).hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(!effect.feedback.includes('restricted secret'));
  }
});

test('a clear approval judgment permits the write; unapproved judgment denies it', async () => {
  const p = guardPolicy();
  for (const [status, action] of [['violation', 'deny_tool'], ['clear', 'none']]) {
    const reviewer = { review: async () => ({ findings: [{ ruleId: p.id, status, mode: 'repair', correction: p.correction, description: p.description, evidence: 'restricted secret' }] }) };
    const ctx = await env([p], reviewer);
    const effect = await handleEvent(call({ file_path: '/dest', content: 'restricted secret' }), ctx);
    assert.equal(effect.action, action);
    if (effect.feedback) assert.ok(!effect.feedback.includes('restricted secret'));
  }
});

test('failure guard respects prefilter exclusions and default fail-open behavior', async () => {
  const reviewer = { review: async () => { throw Error('unavailable'); } };
  const sourceText = source({ target: 'tool_call', detector: 'jev', extra: 'on_failure: block\nprefilter:\n  pattern: restricted' });
  const ctx = await env([parsePolicy(sourceText)], reviewer);
  assert.equal((await handleEvent(call({ content: 'public' }), ctx)).action, 'none');
  const ordinary = await env([parsePolicy(source({ target: 'tool_call' }))], reviewer);
  assert.equal((await handleEvent(call({ content: 'restricted' }), ordinary)).action, 'none');
});

test('state storage failure holds an eligible guarded call', async () => {
  const ctx = await env([guardPolicy()]);
  const file = join(ctx.stateDir, 'not-a-directory');
  await writeFile(file, 'x');
  ctx.stateDir = file;
  assert.equal((await handleEvent(call({ content: 'restricted' }), ctx)).action, 'deny_tool');
});

test('hosts without replacement support receive an explicit instruction, not an invalid replacement', async () => {
  const ctx = await env([wrapPolicy()]);
  const effect = await handleEvent(result('Read', { type: 'text', file: { content: 'restricted' } }), ctx);
  const encoded = encode('codex', effect);
  assert.equal(encoded.hookSpecificOutput?.updatedToolOutput, undefined);
  assert.match(encoded.hookSpecificOutput.additionalContext, /permission/);
});

test('stale reviews hold gated calls instead of applying a judgment to a different request', async () => {
  const p = guardPolicy();
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const ctx = await env([p], { review: async () => {
    started(); await new Promise(resolve => { release = resolve; });
    return { findings: [{ ruleId: p.id, status: 'clear', mode: 'repair' }] };
  } });
  const pending = handleEvent(call({ content: 'restricted' }), ctx);
  await entered;
  await handleEvent(decode('claude', { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'Different request' }), { ...ctx, reviewer: undefined });
  release();
  assert.equal((await pending).action, 'deny_tool');
});

test('truncated source evidence cannot pass an otherwise clear gated judgment', async () => {
  const p = guardPolicy();
  const reviewer = createReviewer({ client: { evaluate: async ({ questions }) => ({ answers: Object.fromEntries(Object.keys(questions).map(key => [key, { type: 'choice', choice: 'clear', probabilities: { clear: 1, approved: 0, unapproved: 0, unknown: 0 } }])) }) } });
  const ctx = await env([p], reviewer);
  assert.equal((await handleEvent(call({ content: 'x'.repeat(100000) }), ctx)).action, 'deny_tool');
});

test('raw hook failure results get a warning without an unsupported replacement', async () => {
  const ctx = await env([wrapPolicy()]);
  const event = decode('claude', { hook_event_name: 'PostToolUseFailure', session_id: 's', tool_name: 'Bash', tool_input: {}, error: 'restricted error' });
  const encoded = encode('claude', await handleEvent(event, ctx));
  assert.equal(encoded.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.equal(encoded.hookSpecificOutput.updatedToolOutput, undefined);
  assert.match(encoded.hookSpecificOutput.additionalContext, /permission/);
});

test('binary Read data stays unchanged while the warning uses the context channel', async () => {
  const ctx = await env([wrapPolicy()]);
  const raw = { type: 'image', file: { base64: 'restricted', filePath: '/image.png' } };
  const encoded = encode('claude', await handleEvent(result('Read', raw), ctx));
  assert.equal(encoded.hookSpecificOutput.updatedToolOutput, undefined);
  assert.match(encoded.hookSpecificOutput.additionalContext, /permission/);
  assert.equal(raw.file.base64, 'restricted');
});

test('pre-tool entry point denies an invalid explicit config path rather than returning a notice', async () => {
  const { spawnSync } = await import('node:child_process');
  const payload = { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Write', tool_input: { content: 'restricted' } };
  const run = spawnSync(process.execPath, ['bin/behavior-hook.js', 'claude'], { encoding: 'utf8', cwd: new URL('..', import.meta.url), input: JSON.stringify(payload), env: { ...process.env, AGENT_RULES_CONFIG: '../invalid-config.json' } });
  assert.equal(JSON.parse(run.stdout || '{}').hookSpecificOutput?.permissionDecision, 'deny');
});

test('a guarded regex cannot clear a violating suffix lost to capture truncation', async () => {
  const p = parsePolicy(source({ target: 'tool_call', extra: 'on_failure: block' }));
  const ctx = await env([p]);
  const effect = await handleEvent(call({ content: 'x'.repeat(100000) + 'restricted' }), ctx);
  assert.equal(effect.action, 'deny_tool');
});

test('a guarded prefilter cannot clear a violating suffix lost to capture truncation', async () => {
  const p = parsePolicy(source({ target: 'tool_call', extra: 'on_failure: block\nprefilter:\n  pattern: restricted' }));
  const ctx = await env([p]);
  assert.equal((await handleEvent(call({ content: 'x'.repeat(100000) + 'restricted' }), ctx)).action, 'deny_tool');
});

test('ID-less parallel tool completions review the receipt just updated', async () => {
  const ctx = await env([wrapPolicy()]);
  const start = (name, input) => decode('claude', { hook_event_name: 'PreToolUse', session_id: 's', tool_name: name, tool_input: input });
  await handleEvent(start('Read', { file_path: '/a' }), ctx);
  await handleEvent(start('Bash', { command: 'echo public' }), ctx);
  await handleEvent(decode('claude', { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'echo public' }, tool_response: { stdout: 'public' } }), ctx);
  const current = decode('claude', { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Read', tool_input: { file_path: '/a' }, tool_response: { type: 'text', file: { content: 'restricted' } } });
  assert.equal((await handleEvent(current, ctx)).action, 'wrap_tool_result');
});

test('historical truncation does not invalidate a complete current-only result review', async () => {
  const p = parsePolicy(source({ detector: 'jev', extra: 'delivery: wrap' }).replace('uses: [request, conversation]', 'uses: []'));
  const client = { evaluate: async ({ questions }) => ({ answers: Object.fromEntries(Object.keys(questions).map(k => [k, { type: 'choice', choice: 'clear', probabilities: { clear: 1, approved: 0, unapproved: 0, unknown: 0 } }])) }) };
  const ctx = await env([p], createReviewer({ client }));
  await handleEvent(result('Bash', { stdout: 'x'.repeat(100000) }, 'old'), ctx);
  const effect = await handleEvent(result('Bash', { stdout: 'public' }, 'new'), ctx);
  assert.notEqual(effect.action, 'wrap_tool_result');
});

test('a malformed failure-blocking policy holds pre-tool calls instead of disappearing silently', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdir } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'ar-invalid-gate-'));
  const rules = join(dir, '.agent-rules', 'rules');
  await mkdir(rules, { recursive: true });
  await writeFile(join(rules, 'bad.md'), source({ target: 'tool_call', extra: 'on_failure: block' }).replace('type: regex', 'type: invalid'));
  const payload = { hook_event_name: 'PreToolUse', cwd: dir, session_id: 's', tool_name: 'Write', tool_input: { content: 'restricted' } };
  const run = spawnSync(process.execPath, ['bin/behavior-hook.js', 'claude'], { encoding: 'utf8', cwd: new URL('..', import.meta.url), input: JSON.stringify(payload), env: { ...process.env, AGENT_RULES_CONFIG: '', AGENT_RULES_STATE_DIR: join(dir, 'state') } });
  assert.equal(JSON.parse(run.stdout || '{}').hookSpecificOutput?.permissionDecision, 'deny');
});
