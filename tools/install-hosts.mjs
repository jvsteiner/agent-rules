// Install or update the built plugin/ folder in every host found on this machine:
// Claude Code and Codex through their marketplaces, omp through an extension file.
// Run through `npm run install-hosts`, which builds first.
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const plugin = join(root, 'plugin');
const { version } = JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8'));
const results = [];

const has = (command) => spawnSync('which', [command], { encoding: 'utf8' }).status === 0;
function run(command, args) {
  const r = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}`.trim() };
}
// Try the update path first; fall back to adding the marketplace and installing.
function host(name, steps) {
  if (!has(name)) return results.push(`${name}: not found, skipped`);
  for (const attempt of steps) {
    const outcomes = attempt.map(([command, args]) => run(command, args));
    if (outcomes.every((o) => o.ok)) return results.push(`${name}: agent-rules ${version} installed`);
  }
  results.push(`${name}: FAILED. Run the steps in README.md by hand.`);
  process.exitCode = 1;
}

host('claude', [
  [['claude', ['plugin', 'marketplace', 'update', 'agent-rules']], ['claude', ['plugin', 'update', 'agent-rules@agent-rules']]],
  [['claude', ['plugin', 'marketplace', 'add', root]], ['claude', ['plugin', 'install', 'agent-rules@agent-rules']]],
]);
host('codex', [
  [['codex', ['plugin', 'add', 'agent-rules@agent-rules']]],
  [['codex', ['plugin', 'marketplace', 'add', root]], ['codex', ['plugin', 'add', 'agent-rules@agent-rules']]],
]);

// omp: a stable copy of the plugin, an extension that runs its hook, and the live regex rules.
const ompAgent = join(homedir(), '.omp', 'agent');
if (existsSync(ompAgent)) {
  const installed = join(ompAgent, 'agent-rules');
  await rm(installed, { recursive: true, force: true });
  await cp(plugin, installed, { recursive: true });
  const template = await readFile(join(plugin, 'omp', 'agent-rules.js'), 'utf8');
  await mkdir(join(ompAgent, 'extensions'), { recursive: true });
  const placeholder = "const HOOK = '__AGENT_RULES_HOOK__';";
  if (!template.includes(placeholder)) throw new Error('omp/agent-rules.js has no HOOK placeholder');
  await writeFile(join(ompAgent, 'extensions', 'agent-rules.js'),
    template.replace(placeholder, `const HOOK = ${JSON.stringify(join(installed, 'dist', 'behavior-hook.js'))};`));
  const rules = join(ompAgent, 'rules');
  const isLink = await lstat(rules).then((s) => s.isSymbolicLink(), () => null);
  if (isLink === false) results.push(`omp: ${rules} is a real folder, not a link; left unchanged`);
  else { await rm(rules, { force: true }); await symlink(join(root, 'rules'), rules); }
  // Skills load live from the installed copy; omp's own skills folder wins on a name clash.
  for (const skill of ['author-rule', 'diagnose-rule']) {
    const link = join(ompAgent, 'skills', skill);
    const existing = await lstat(link).then((s) => s.isSymbolicLink(), () => null);
    if (existing === false) { results.push(`omp: ${link} is a real folder; left unchanged`); continue; }
    await mkdir(join(ompAgent, 'skills'), { recursive: true });
    await rm(link, { force: true }); await symlink(join(installed, 'skills', skill), link);
  }
  results.push(`omp: agent-rules ${version} installed`);
} else results.push('omp: not found, skipped');

console.log(results.join('\n'));
console.log('Restart open sessions to load the update. In Codex, trust changed hooks with /hooks.');
