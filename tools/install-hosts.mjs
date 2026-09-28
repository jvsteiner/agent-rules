// Development install: install the freshly built plugin/ folder of this checkout into every
// host found on this machine. Claude Code and Codex use plugin/ as a local marketplace
// named agent-rules; omp gets the extension, with its regex rules linked to this checkout.
// Users install the published npm package instead (see README.md).
// Run through `make install-local` or `npm run install-hosts`, which build first.
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installOmp } from '../src/install-omp.js';

const root = resolve(import.meta.dirname, '..');
const plugin = join(root, 'plugin');
const { version } = JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8'));
const results = [];

const has = (command) => spawnSync('which', [command], { encoding: 'utf8' }).status === 0;
const run = (command, args) => spawnSync(command, args, { cwd: root, encoding: 'utf8' }).status === 0;

// Point the agent-rules marketplace at plugin/, replacing a registration that points at the
// published package or an older path, then install or update the plugin from it.
function host(name, { remove, add, install, update }) {
  if (!has(name)) return results.push(`${name}: not found, skipped`);
  run(name, remove);
  if (run(name, add) && (run(name, install) || (update && run(name, update)))) return results.push(`${name}: agent-rules ${version} installed`);
  results.push(`${name}: FAILED. Run the development install steps in README.md by hand.`);
  process.exitCode = 1;
}

host('claude', { remove: ['plugin', 'marketplace', 'remove', 'agent-rules'], add: ['plugin', 'marketplace', 'add', plugin],
  install: ['plugin', 'install', 'agent-rules@agent-rules'], update: ['plugin', 'update', 'agent-rules@agent-rules'] });
// Codex deletes the previous version folder on install, but a running session keeps calling
// its hooks at the old path and fails with exit code 1 on every tool call. Keep the most
// recent earlier versions so open sessions work until they restart.
const codexCache = join(homedir(), '.codex', 'plugins', 'cache', 'agent-rules', 'agent-rules');
const KEEP_CODEX_VERSIONS = 5;
const byVersion = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const earlier = existsSync(codexCache) ? (await readdir(codexCache)).filter((v) => v !== version).sort(byVersion).slice(-KEEP_CODEX_VERSIONS) : [];
const saved = earlier.length ? await mkdtemp(join(tmpdir(), 'agent-rules-codex-')) : undefined;
for (const v of earlier) await cp(join(codexCache, v), join(saved, v), { recursive: true });
host('codex', { remove: ['plugin', 'marketplace', 'remove', 'agent-rules'], add: ['plugin', 'marketplace', 'add', plugin],
  install: ['plugin', 'add', 'agent-rules@agent-rules'] });
for (const v of earlier) if (!existsSync(join(codexCache, v))) await cp(join(saved, v), join(codexCache, v), { recursive: true });
if (saved) await rm(saved, { recursive: true, force: true });
if (existsSync(codexCache)) for (const v of (await readdir(codexCache)).filter((x) => x !== version).sort(byVersion).slice(0, -KEEP_CODEX_VERSIONS)) await rm(join(codexCache, v), { recursive: true, force: true });
results.push(...await installOmp({ pluginDir: plugin, rulesDir: join(root, 'rules') }));

console.log(results.join('\n'));
console.log('Restart open sessions to load the update. In Codex, trust changed hooks with /hooks.');
