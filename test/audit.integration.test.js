import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadPolicies } from '../src/catalog.js';
import { createReviewer } from '../src/review.js';
import { handleEvent } from '../src/runtime.js';

test('large tool receipts do not silence cat policy and next prompt preserves inspectable verdict', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-rules-audit-'));
  try {
    const { policies } = await loadPolicies({ directories: [resolve('policies')], modes: { 'communication.cat-pictures': 'repair' } });
    const base = { platform: 'claude', sessionId: 'audit-regression', actorId: 'main' };
    const event = (kind, extra = {}) => ({ ...base, kind, ...extra });
    await handleEvent(event('user_prompt', { source: 'host_user', userText: 'Fix my test.' }), { stateDir });
    for (let i = 0; i < 3; i++) await handleEvent(event('tool_result', { tool: { id: `t${i}`, name: 'shell', input: {}, result: 'x'.repeat(10000), status: 'completed' } }), { stateDir });
    let calls = 0;
    const reviewer = createReviewer({ maxReviewRequests: 1, client: { evaluate: async ({ state, questions }) => {
      calls++;
      assert.equal(state.receipts, undefined, 'oversized unrelated receipts must not enter the small review');
      return { answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => {
        const choice = Object.hasOwn(q.criteria, 'cat_pictures') ? 'cat_pictures' : 'clear';
        return [id, { type: 'choice', choice, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choice ? 1 : 0])) }];
      })) };
    } } });
    const outcome = await handleEvent(event('response_end', { response: 'Here is a cute cat picture.' }), { stateDir, policies, reviewer });
    assert.equal(calls, 1);
    assert.equal(outcome.action, 'continue_turn');
    assert.match(outcome.feedback, /communication.cat-pictures/);
    await handleEvent(event('user_prompt', { source: 'host_user', userText: 'Why did that fire?' }), { stateDir });
    const inspected = spawnSync(process.execPath, ['bin/agent-rules.js', 'inspect', 'communication.cat-pictures'], {
      encoding: 'utf8', env: { ...process.env, AGENT_RULES_STATE_DIR: stateDir },
    });
    assert.equal(inspected.status, 0, inspected.stderr);
    const record = JSON.parse(inspected.stdout);
    assert.match(JSON.stringify(record), /cat_pictures/);
    assert.match(JSON.stringify(record), /continue_turn/);
    assert.match(JSON.stringify(record), /violation/);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('runtime passes a long response through chunk review including its tail', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-rules-chunk-audit-'));
  try {
    const { policies } = await loadPolicies({ directories: [resolve('policies')], modes: { 'communication.cat-pictures': 'repair' } });
    const selected = policies.filter(p => p.id === 'communication.cat-pictures');
    const base = { platform: 'claude', sessionId: 'chunk-regression', actorId: 'main' };
    await handleEvent({ ...base, kind: 'user_prompt', source: 'host_user', userText: 'Describe this image.' }, { stateDir });
    let calls = 0, tailSeen = false;
    const reviewer = createReviewer({ maxReviewRequests: 4, client: { evaluate: async ({ state, questions, model }) => {
      calls++;
      assert.ok(JSON.stringify({ state, questions, model }).length <= 24000);
      tailSeen ||= state.candidates.some(c => c.text.includes('TAIL_SENTINEL'));
      return { answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, {
        type: 'choice', choice: 'cat_pictures', probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === 'cat_pictures' ? 1 : 0])),
      }])) };
    } } });
    const response = 'A picture of a cat. '.repeat(1500) + 'TAIL_SENTINEL';
    const outcome = await handleEvent({ ...base, kind: 'response_end', response }, { stateDir, policies: selected, reviewer });
    assert.ok(calls >= 2 && calls <= 4);
    assert.equal(tailSeen, true, 'capture and chunking must preserve the response tail');
    assert.equal(outcome.action, 'continue_turn');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
