import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const PLACEHOLDER = "const HOOK = '__AGENT_RULES_HOOK__';";
const linkState = (path) => lstat(path).then((s) => (s.isSymbolicLink() ? 'link' : 'real'), () => 'missing');

// Install a built plugin folder into omp: a stable copy, the extension that runs its hook,
// the author/diagnose skills, and a link to the regex rules omp enforces itself.
// rulesDir defaults to the installed copy's rules; a development checkout passes its source rules/.
export async function installOmp({ pluginDir, rulesDir, home = homedir() }) {
  const agent = join(home, '.omp', 'agent');
  if (!existsSync(agent)) return ['omp: not found (no ~/.omp/agent), skipped'];
  const { version } = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8'));
  const messages = [];
  const installed = join(agent, 'agent-rules');
  await rm(installed, { recursive: true, force: true });
  await cp(pluginDir, installed, { recursive: true });
  const template = await readFile(join(installed, 'omp', 'agent-rules.js'), 'utf8');
  if (!template.includes(PLACEHOLDER)) throw new Error('omp/agent-rules.js has no HOOK placeholder');
  await mkdir(join(agent, 'extensions'), { recursive: true });
  await writeFile(join(agent, 'extensions', 'agent-rules.js'),
    template.replace(PLACEHOLDER, `const HOOK = ${JSON.stringify(join(installed, 'dist', 'behavior-hook.js'))};`));
  const links = [[join(agent, 'rules'), rulesDir ?? join(installed, 'rules')],
    ...['author-rule', 'diagnose-rule'].map((skill) => [join(agent, 'skills', skill), join(installed, 'skills', skill)])];
  for (const [link, target] of links) {
    if (await linkState(link) === 'real') { messages.push(`omp: ${link} is a real folder, not a link; left unchanged`); continue; }
    await mkdir(dirname(link), { recursive: true });
    await rm(link, { force: true }); await symlink(target, link);
  }
  messages.push(`omp: agent-rules ${version} installed`);
  return messages;
}
