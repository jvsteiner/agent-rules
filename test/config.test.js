import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

test('merges user then project settings and preserves defaults', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-config-'));
  const home = path.join(root, 'home'); const project = path.join(root, 'project');
  try {
    await mkdir(path.join(home, '.config', 'agent-rules'), { recursive: true });
    await mkdir(path.join(project, '.agent-rules'), { recursive: true });
    await writeFile(path.join(home, '.config', 'agent-rules', 'config.json'), JSON.stringify({ model: 'custom', rules: { a: 'off' } }));
    await writeFile(path.join(project, '.agent-rules', 'config.json'), JSON.stringify({ rules: { b: 'repair' } }));
    const { config } = await loadConfig({ projectRoot: project, home });
    assert.equal(config.model, 'custom');
    assert.equal(config.reviewDeadlineMs, 2000);
    assert.equal(config.maxCorrectionsPerEpisode, 2);
    assert.deepEqual(config.rules, { a: 'off', b: 'repair' });
    assert.deepEqual(config.policyDirectories, [path.join(home, '.config', 'agent-rules', 'rules'), path.join(project, '.agent-rules', 'rules')]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('explicit config path and environment are supported without exposing secrets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-config-'));
  try {
    const file = path.join(root, 'config.json');
    await writeFile(file, JSON.stringify({ model: 'x', apiKey: 'do-not-print', reviewDeadlineMs: -1 }));
    const result = await loadConfig({ projectRoot: root, home: root, env: { AGENT_RULES_CONFIG: file } });
    assert.ok(result.diagnostics.length);
    assert.equal(JSON.stringify(result).includes('do-not-print'), false);
    assert.equal(result.config.model, 'x');
    await assert.rejects(loadConfig({ projectRoot: root, home: root, env: {}, configPath: '../outside.json' }), /path/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects project credential settings and unsafe numeric values', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-config-'));
  try {
    await mkdir(path.join(root, '.agent-rules'), { recursive: true });
    await writeFile(path.join(root, '.agent-rules', 'config.json'), JSON.stringify({ apiKey: 'secret', maxCorrectionsPerEpisode: 999999 }));
    const result = await loadConfig({ projectRoot: root, home: root, env: {} });
    assert.equal(JSON.stringify(result).includes('secret'), false);
    assert.ok(result.diagnostics.length);
    assert.equal(result.config.maxCorrectionsPerEpisode, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
