import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parsePolicy, loadPolicies } from '../src/catalog.js';

const policy = (patch = '', correction = '## Correction\nFix the response.') => `---\nschema: agent-rules/v1\nid: sample.rule\ndescription: Sample rule\nevents: [response_end]\ntarget: response\nrequires: [request, response]\npriority: 10\ndetector:\n  type: jev\n  question:\n    type: choice\n    instructions: Check the response.\n    criteria:\n      yes: A violation\n      no: Clear\n  decision:\n    violation:\n      option: yes\n      min_probability: 0.9\n    min_winner_probability: 0.7\n${patch}${patch ? '\n' : ''}---\n\n${correction}\n`;

test('normalizes a valid choice policy and hashes all authored content', () => {
  const parsed = parsePolicy(policy(), { file: 'sample.md' });
  assert.equal(parsed.id, 'sample.rule');
  assert.equal(parsed.mode, 'observe');
  assert.equal(parsed.correction, 'Fix the response.');
  assert.match(parsed.hash, /^[a-f0-9]{64}$/);
  assert.notEqual(parsed.hash, parsePolicy(policy('', '## Correction\nDo something else.' )).hash);
});

test('accepts Noul, Score, and regex detectors with valid decisions', () => {
  const noul = policy().replace('type: choice', 'type: noul').replace(/    criteria:\n      yes: A violation\n      no: Clear/, '    criteria:\n      true: Violation\n      false: Clear').replace(/  decision:\n[\s\S]*?min_winner_probability: 0.7/, '  decision:\n    violation_at_or_above: 0.8\n    clear_at_or_below: 0.2');
  const score = policy().replace('type: choice', 'type: score').replace(/    criteria:\n      yes: A violation\n      no: Clear/, '    criteria: [Clear, Violation]').replace(/  decision:\n[\s\S]*?min_winner_probability: 0.7/, '  decision:\n    violation_levels: ["1"]\n    clear_levels: ["0"]\n    min_probability: 0.8');
  const regex = policy().replace(/detector:\n[\s\S]*?min_winner_probability: 0.7/, 'detector:\n  type: regex\n  pattern: "\\\\bTODO\\\\b"\n  flags: i');
  assert.equal(parsePolicy(noul).detector.question.type, 'noul');
  assert.deepEqual(parsePolicy(score).detector.question.criteria, ['Clear', 'Violation']);
  assert.equal(parsePolicy(regex).detector.type, 'regex');
});

test('accepts omitted Noul criteria and preserves complete multiline Correction content', () => {
  const noul = policy().replace('type: choice', 'type: noul').replace(/    criteria:\n      yes: A violation\n      no: Clear/, '').replace(/  decision:\n[\s\S]*?min_winner_probability: 0.7/, '  decision:\n    violation_at_or_above: 0.8\n    clear_at_or_below: 0.2');
  const authored = policy().replace('Fix the response.', 'First paragraph.\n\nSecond paragraph.\n\n## Other\nExcluded text.');
  assert.equal(parsePolicy(noul).detector.question.type, 'noul');
  assert.equal(parsePolicy(authored).correction, 'First paragraph.\n\nSecond paragraph.');
});

test('validates evidence names against runtime snapshot groups', () => {
  assert.doesNotThrow(() => parsePolicy(policy().replace('[request, response]', '[request, response, receipts, changes, thinking, constraints]')));
  assert.throws(() => parsePolicy(policy().replace('[request, response]', '[request, code]')), /evidence.*code/i);
});

test('rejects invalid schema fields with source context', () => {
  assert.throws(() => parsePolicy(policy().replace('target: response', 'target: filesystem'), { file: 'bad.md' }), /bad\.md.*target|target.*bad\.md/i);
  assert.throws(() => parsePolicy(policy().replace('min_probability: 0.9', 'min_probability: 2')), /probability|threshold/i);
  assert.throws(() => parsePolicy(policy().replace('option: yes', 'option: missing')), /option.*missing|missing.*option/i);
  assert.throws(() => parsePolicy(policy().replace('[request, response]', '[secrets]')), /evidence.*secrets|secrets.*evidence/i);
  assert.throws(() => parsePolicy(policy().replace('target: response', 'target: response\nintervention: repair').replace('## Correction\nFix the response.', '## Why\nNo correction')), /Correction/i);
  assert.throws(() => parsePolicy('---\nschema: [broken\n---'), /YAML|parse/i);
});

test('loads overrides, modes, and tombstones an invalid higher-precedence definition', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-rules-'));
  const low = path.join(root, 'user'); const high = path.join(root, 'project');
  try {
    await mkdir(low); await mkdir(high);
    await writeFile(path.join(low, 'rule.md'), policy());
    await writeFile(path.join(high, 'rule.md'), policy().replace('target: response', 'target: impossible'));
    await writeFile(path.join(low, 'off.md'), policy().replaceAll('sample.rule', 'off.rule'));
    const result = await loadPolicies({ directories: [low, high], modes: { 'off.rule': 'off' } });
    assert.equal(result.policies.some(p => p.id === 'sample.rule'), false);
    assert.equal(result.policies.some(p => p.id === 'off.rule'), false);
    assert.ok(result.diagnostics.some(d => /sample\.rule/.test(JSON.stringify(d))));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects duplicate IDs within one directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-rules-'));
  try {
    await writeFile(path.join(root, 'a.md'), policy());
    await writeFile(path.join(root, 'b.md'), policy());
    const result = await loadPolicies({ directories: [root] });
    assert.equal(result.policies.length, 0);
    assert.ok(result.diagnostics.some(d => /duplicate/i.test(JSON.stringify(d))));
  } finally { await rm(root, { recursive: true, force: true }); }
});
