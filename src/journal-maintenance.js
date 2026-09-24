import { lstat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

const DAY = 24 * 60 * 60 * 1000;

/** Remove expired or excess top-level journal state without following symlinks. */
export async function maintainJournal(stateDir, { now = Date.now(), maxAgeMs = DAY, maxFiles = 200, maxBytes = 10 * 1024 * 1024 } = {}) {
  const removed = [];
  const errors = [];
  let entries;
  try { entries = await readdir(stateDir); }
  catch (error) {
    if (error.code === 'ENOENT') return { removed, errors };
    return { removed, errors: [{ code: error.code ?? 'ERR_READ_DIR' }] };
  }

  const files = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(stateDir, name);
    try {
      const info = await lstat(file);
      if (info.isFile()) files.push({ name, file, mtimeMs: info.mtimeMs, size: info.size });
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push({ file: name, code: error.code ?? 'ERR_STAT' });
    }
  }

  let remainingCount = files.length;
  let remainingBytes = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of [...files].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    const expired = now - file.mtimeMs > maxAgeMs;
    if (!expired && remainingCount <= maxFiles && remainingBytes <= maxBytes) continue;
    try {
      // Runtime locks are directories named <state-file>.lock. Any existing lock
      // protects its state file, including a lock created during this scan.
      try { await lstat(`${file.file}.lock`); continue; }
      catch (error) { if (error.code !== 'ENOENT') { errors.push({ file: file.name, code: error.code ?? 'ERR_LOCK_STAT' }); continue; } }
      const current = await lstat(file.file);
      if (!current.isFile()) continue;
      await unlink(file.file);
      removed.push(file.name);
      remainingCount--;
      remainingBytes -= file.size;
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push({ file: file.name, code: error.code ?? 'ERR_REMOVE' });
    }
  }
  return { removed, errors };
}
