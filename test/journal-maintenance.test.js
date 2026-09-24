import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, lstat, readFile, rm, utimes, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { maintainJournal } from '../src/journal-maintenance.js';

test('removes expired regular state files but preserves recent, locked, and symlink targets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-journal-'));
  const outside = path.join(root, 'outside.json'); const old = path.join(root, 'old.json');
  try {
    await writeFile(outside, 'external');
    await writeFile(old, 'expired'); await utimes(old, new Date(0), new Date(0));
    await writeFile(path.join(root, 'recent.json'), 'recent');
    await writeFile(path.join(root, 'active.json'), 'active');
    await mkdir(path.join(root, 'active.json.lock'));
    await symlink(outside, path.join(root, 'link.json'));
    const result = await maintainJournal(root, { now: 100_000_000, maxAgeMs: 60_000 });
    assert.deepEqual(result.removed, ['old.json']);
    assert.deepEqual(result.errors, []);
    await assert.rejects(lstat(old));
    assert.equal(await readFile(outside, 'utf8'), 'external');
    assert.equal((await lstat(path.join(root, 'link.json'))).isSymbolicLink(), true);
    assert.equal((await lstat(path.join(root, 'active.json.lock'))).isDirectory(), true);
    assert.equal(await readFile(path.join(root, 'active.json'), 'utf8'), 'active');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('prunes oldest unlocked JSON files to count and byte limits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-journal-'));
  try {
    const names = ['one.json', 'two.json', 'three.json'];
    for (let i = 0; i < names.length; i++) {
      const file = path.join(root, names[i]); await writeFile(file, 'x'.repeat(4));
      await utimes(file, new Date(i * 1000 + 1000), new Date(i * 1000 + 1000));
    }
    await writeFile(path.join(root, 'keep.txt'), 'unmanaged');
    const result = await maintainJournal(root, { now: 10_000, maxAgeMs: 100_000, maxFiles: 2, maxBytes: 8 });
    assert.deepEqual(result.removed, ['one.json']);
    assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.json')).sort(), ['three.json', 'two.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing directory is a quiet no-op', async () => {
  const result = await maintainJournal(path.join(os.tmpdir(), `missing-journal-${Date.now()}`));
  assert.deepEqual(result, { removed: [], errors: [] });
});
