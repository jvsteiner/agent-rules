#!/usr/bin/env node
// Explicit, bounded live-host contract probe. No persistent host configuration changes.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve,dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const platform = process.argv[2];
const live=process.argv.includes('--live');
const receipts=process.argv.includes('--receipts');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if (!['claude', 'codex'].includes(platform)) throw new Error('Usage: node tools/host-probe.mjs claude|codex');
const dir = mkdtempSync(join(tmpdir(), `agent-rules-${platform}-probe-`));
const capture = join(dir, 'events.jsonl');
const hook = join(dir, 'probe.cjs');
writeFileSync(hook, `
const fs = require('node:fs');
let input=''; process.stdin.on('data', x=>input+=x); process.stdin.on('end',()=>{
const p=JSON.parse(input); fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(p)+'\\n');
if(p.hook_event_name==='Stop' && !p.stop_hook_active) process.stdout.write(JSON.stringify({systemMessage:'Agent Rules probe: correction requested (1/1)',decision:'block',reason:'This is a bounded plugin integration test. Reply exactly PROBE_CORRECTED now; the previous response was the test trigger.'}));
});
`);
const childEnv={...process.env};
if(live){
 const envIndex=process.argv.indexOf('--env-file');
 if(envIndex>=0){const env=parseEnv(readFileSync(resolve(process.argv[envIndex+1]),'utf8'));childEnv.TYPESAFE_API_KEY=env.TYPESAFE_API_KEY;}
 if(!childEnv.TYPESAFE_API_KEY)throw new Error('Live probe requires TYPESAFE_API_KEY or explicit --env-file.');
 const {mkdirSync}=await import('node:fs');
 mkdirSync(join(dir,'.agent-rules/rules'),{recursive:true});
 writeFileSync(join(dir,'.agent-rules/config.json'),JSON.stringify({reviewDeadlineMs:5000,rules:{'reporting.test-result-contradiction':receipts?'repair':'off','reporting.premature-completion':'off','communication.unexplained-jargon':'off','integration.probe':receipts?'off':'repair'}}));
 writeFileSync(join(dir,'.agent-rules/rules/probe.md'),`---\nschema: agent-rules/v1\nid: integration.probe\ndescription: Replace the deliberately supplied test response.\nevents: [response_end]\ntarget: response\nrequires: [response]\npriority: 90\ndetector:\n  type: jev\n  question:\n    type: noul\n    instructions: Does the candidate response say PROBE_INITIAL? Evaluate the response text only, not the user request.\n  decision:\n    violation_at_or_above: 0.90\n    clear_at_or_below: 0.10\nintervention: repair\n---\n## Correction\nThis is a bounded plugin integration test. Reply exactly PROBE_CORRECTED now.\n`);
 childEnv.AGENT_RULES_STATE_DIR=join(dir,'state');childEnv.AGENT_RULES_LEGACY='0';
 writeFileSync(hook,`const fs=require('node:fs');const {execFileSync}=require('node:child_process');let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{const p=JSON.parse(input);fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(p)+'\\n');const reply=execFileSync(${JSON.stringify(process.execPath)},[${JSON.stringify(join(root,'dist/behavior-hook.js'))},${JSON.stringify(platform)}],{input,encoding:'utf8',env:process.env});fs.appendFileSync(${JSON.stringify(join(dir,'replies.jsonl'))},JSON.stringify({event:p.hook_event_name,reply:reply?JSON.parse(reply):null})+'\\n');process.stdout.write(reply);});`);
}
const command = `${process.execPath} '${hook.replaceAll("'", "'\\''")}'`;
const hooks = Object.fromEntries(['SessionStart','UserPromptSubmit','Stop',...(receipts?['PreToolUse','PostToolUse',...(platform==='claude'?['PostToolUseFailure']:[])]:[])].map(e=>[e,[{hooks:[{type:'command',command,timeout:8}]}]]));
const prompt = receipts ? 'This is an isolated plugin integration test. Run exactly: node -e "console.log(\'SYNTHETIC TEST RESULT: 2 failed, 0 passed\'); process.exit(1)" . Then report in one short sentence the actual result. Do not fix anything; failure is intentional. Do not read files.' : 'This is a plugin integration test. Respond with exactly PROBE_INITIAL. Do not call tools.';
let args;
if(platform==='claude'){
 const settings=join(dir,'settings.json');writeFileSync(settings,JSON.stringify({hooks}));
 args=['-p',prompt,'--settings',settings,'--setting-sources','','--strict-mcp-config','--tools',receipts?'Bash':'','--max-turns','4','--output-format','stream-json','--verbose','--no-session-persistence'];
 if(receipts)args.push('--allowedTools','Bash(node *)');
} else {
 args=['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--dangerously-bypass-hook-trust','--json','-C',dir];
 for(const e of Object.keys(hooks)) args.push('-c',`hooks.${e}=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=5}]}]`);
 args.push(prompt);
}
const child=spawn(platform,args,{cwd:dir,env:childEnv,stdio:['ignore','pipe','pipe']});
let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
const timer=setTimeout(()=>child.kill('SIGTERM'),120000);
child.on('close',code=>{
 clearTimeout(timer);writeFileSync(join(dir,'host.jsonl'),out,{mode:0o600});writeFileSync(join(dir,'stderr.txt'),err,{mode:0o600});
 let events=[];try{events=readFileSync(capture,'utf8').trim().split('\n').map(JSON.parse);}catch{}
 const stops=events.filter(e=>e.hook_event_name==='Stop');
 let replies=[];if(live)try{replies=readFileSync(join(dir,'replies.jsonl'),'utf8').trim().split('\n').map(JSON.parse);}catch{}
 const report={platform,live,receipts,code,directory:dir,events:events.map(e=>({event:e.hook_event_name,fields:Object.keys(e),stopHookActive:e.stop_hook_active,turn:e.turn_id,last:e.last_assistant_message})),corrected:stops.some(e=>e.last_assistant_message?.includes('PROBE_CORRECTED')),noticeInStream:out.includes('Agent Rules'),replies};
 writeFileSync(join(dir,'report.json'),JSON.stringify(report,null,2));
 const accepted=receipts?events.some(e=>e.hook_event_name==='PostToolUse')&&stops.some(e=>/fail/i.test(e.last_assistant_message??'')):report.corrected;
 console.log(JSON.stringify(report,null,2));if(code!==0||!accepted) {console.error(err.slice(-1500));process.exitCode=1;}
});
