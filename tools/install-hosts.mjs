// Development install: install the freshly built plugin/ folder of this checkout into every
// host found on this machine. Claude Code and Codex use plugin/ as a local marketplace
// named agent-rules; omp gets the extension, with its regex rules linked to this checkout.
// Users install the published npm package instead (see README.md).
// Run through `make install-local` or `npm run install-hosts`, which build first.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
host('codex', { remove: ['plugin', 'marketplace', 'remove', 'agent-rules'], add: ['plugin', 'marketplace', 'add', plugin],
  install: ['plugin', 'add', 'agent-rules@agent-rules'] });
results.push(...await installOmp({ pluginDir: plugin, rulesDir: join(root, 'rules') }));

console.log(results.join('\n'));
console.log('Restart open sessions to load the update. In Codex, trust changed hooks with /hooks.');
