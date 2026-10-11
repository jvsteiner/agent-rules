#!/usr/bin/env node
// Bounded live Claude contract probe using only synthetic data and production runtime/adapters.
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const probes = join(homedir(), '.codex', 'worktrees');
await mkdir(probes, { recursive: true });
const dir = await mkdtemp(join(probes, 'agent-rules-wrap-probe-'));
const capture = join(dir, 'events.jsonl');
const source = join(dir, 'source.txt');
await writeFile(source, 'SYNTHETIC_RESTRICTED_PAYLOAD', { mode: 0o600 });
const hook = join(dir, 'hook.mjs');
await writeFile(hook, `
import { appendFile } from 'node:fs/promises';
import { parsePolicy } from ${JSON.stringify(join(root, 'src/catalog.js'))};
import { createReviewer } from ${JSON.stringify(join(root, 'src/review.js'))};
import { handleEvent } from ${JSON.stringify(join(root, 'src/runtime.js'))};
import { decode, encode } from ${JSON.stringify(join(root, 'src/platforms.js'))};
let input='';for await(const b of process.stdin)input+=b;
const payload=JSON.parse(input);
const policy=parsePolicy('---\\nschema: agent-rules/v1\\nid: integration.wrap\\ndescription: Wrap the synthetic test payload.\\nevents: [tool_result]\\ntarget: tool_result\\nrequires: []\\npriority: 100\\ndelivery: wrap\\ninclude_evidence: false\\ndetector:\\n  type: regex\\n  pattern: SYNTHETIC_RESTRICTED_PAYLOAD\\nintervention: repair\\n---\\n## Correction\\nSYNTHETIC_WRAPPER_VERIFIED. This is a synthetic policy test.');
const effect=await handleEvent(decode('claude',payload),{policies:[policy],reviewer:createReviewer(),stateDir:${JSON.stringify(join(dir, 'state'))}});
const reply=encode('claude',effect);
await appendFile(${JSON.stringify(capture)},JSON.stringify({event:payload.hook_event_name,tool:payload.tool_name,raw:payload.tool_response,reply})+'\\n',{mode:0o600});
process.stdout.write(JSON.stringify(reply));
`, { mode: 0o600 });
const command = `${process.execPath} '${hook.replaceAll("'", "'\\''")}'`;
const settings = join(dir, 'settings.json');
await writeFile(settings, JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command, timeout: 8 }] }] } }), { mode: 0o600 });
const prompt = `This is a bounded synthetic plugin test. Use Bash to run exactly printf SYNTHETIC_RESTRICTED_PAYLOAD, then use Read on ${source}. Do not read any other files or use other tools. For each result separately, report whether its returned content contains SYNTHETIC_WRAPPER_VERIFIED. Finish with BASH_WRAP_PASS and READ_WRAP_PASS if both result bodies contain that marker; otherwise name the failed one. Do not guess from this prompt.`;
const args = ['-p', prompt, '--settings', settings, '--setting-sources', '', '--strict-mcp-config', '--tools', 'Bash,Read', '--allowedTools', 'Bash', 'Read', '--max-turns', '5', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
const child = spawn('claude', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '', err = '';
child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
const code = await new Promise(resolve => child.on('close', resolve));
clearTimeout(timer);
await writeFile(join(dir, 'host.jsonl'), out, { mode: 0o600 });
const events = (await readFile(capture, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
const messages = out.trim().split('\n').filter(Boolean).flatMap(line => { try { const e=JSON.parse(line); return e.type==='assistant' ? e.message?.content?.filter(b=>b.type==='text').map(b=>b.text)??[] : []; } catch { return []; } });
const report = { code, directory: dir, tools: events.map(e => ({ name: e.tool, rawKeys: Object.keys(e.raw ?? {}), replacement: Boolean(e.reply?.hookSpecificOutput?.updatedToolOutput) })), modelConfirmed: messages.join('\n').includes('BASH_WRAP_PASS') && messages.join('\n').includes('READ_WRAP_PASS'), error: err.slice(-1000) };
console.log(JSON.stringify(report));
if (code !== 0 || !report.modelConfirmed || !['Bash','Read'].every(name => report.tools.some(t => t.name === name && t.replacement))) process.exitCode = 1;
