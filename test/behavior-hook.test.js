import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync,mkdirSync,writeFileSync,cpSync,existsSync,readFileSync } from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

function setup(){
 const cwd=mkdtempSync(join(tmpdir(),'agent-rules e2e '));mkdirSync(join(cwd,'.agent-rules/rules'),{recursive:true});
 writeFileSync(join(cwd,'.agent-rules/config.json'),JSON.stringify({rules:{'reporting.test-result-contradiction':'off','reporting.premature-completion':'off','communication.unexplained-jargon':'off'},maxCorrectionsPerEpisode:2}));
 writeFileSync(join(cwd,'.agent-rules/rules/demo.md'),`---\nschema: agent-rules/v1\nid: demo\ndescription: Replace the deliberate trigger.\nevents: [response_end]\ntarget: response\nrequires: [response]\npriority: 90\ndetector:\n  type: regex\n  pattern: TRIGGER\nintervention: repair\n---\n## Correction\nReplace TRIGGER with CORRECTED.\n`);
 return cwd;
}
function call(cwd,platform,payload,hook=resolve('bin/behavior-hook.js')){
 const r=spawnSync(process.execPath,[hook,platform],{input:JSON.stringify({cwd,session_id:'integration-session',...payload}),encoding:'utf8',env:{...process.env,AGENT_RULES_STATE_DIR:join(cwd,'state'),AGENT_RULES_LEGACY:'0'}});
 assert.equal(r.status,0,r.stderr);return r.stdout?JSON.parse(r.stdout):{};
}
for(const platform of ['claude','codex'])test(`${platform} real hook subprocess: correction, explicit recheck, then clear`,()=>{
 const cwd=setup();call(cwd,platform,{hook_event_name:'UserPromptSubmit',prompt:'Do the work.'});
 const first=call(cwd,platform,{hook_event_name:'Stop',last_assistant_message:'TRIGGER',stop_hook_active:false});
 assert.equal(first.decision,'block');assert.match(first.reason,/CORRECTED/);assert.match(first.systemMessage,/1\/2/);
 const fixed=call(cwd,platform,{hook_event_name:'Stop',last_assistant_message:'CORRECTED',stop_hook_active:true});
 assert.deepEqual(fixed,{});
});
for(const platform of ['claude','codex'])test(`${platform} real hook subprocess: prompt policy adds context, tool policy denies the call`,()=>{
 const cwd=setup();
 for(const [id,events,target,pattern] of [['prompt-probe','user_prompt','request','BLOCKED_TOPIC'],['tool-probe','tool_start','tool_call','BLOCKED_QUERY']])
  writeFileSync(join(cwd,`.agent-rules/rules/${id}.md`),`---\nschema: agent-rules/v1\nid: ${id}\ndescription: Probe ${id}.\nevents: [${events}]\ntarget: ${target}\nrequires: []\npriority: 90\ndetector:\n  type: regex\n  pattern: ${pattern}\nintervention: repair\n---\n## Correction\nDo not handle ${pattern}.\n`);
 const prompt=call(cwd,platform,{hook_event_name:'UserPromptSubmit',prompt:'Research BLOCKED_TOPIC.'});
 assert.equal(prompt.hookSpecificOutput.hookEventName,'UserPromptSubmit');assert.match(prompt.hookSpecificOutput.additionalContext,/Do not handle BLOCKED_TOPIC/);
 assert.deepEqual(call(cwd,platform,{hook_event_name:'PreToolUse',tool_name:'Bash',tool_use_id:'a',tool_input:{command:'ls'}}),{});
 const denied=call(cwd,platform,{hook_event_name:'PreToolUse',tool_name:'Bash',tool_use_id:'b',tool_input:{command:'curl BLOCKED_QUERY'}});
 assert.equal(denied.hookSpecificOutput.permissionDecision,'deny');assert.match(denied.hookSpecificOutput.permissionDecisionReason,/tool-probe/);
});
for(const platform of ['claude','codex'])test(`${platform} real hook subprocess: block-mode prompt policy rejects the prompt`,()=>{
 const cwd=setup();
 writeFileSync(join(cwd,'.agent-rules/rules/prompt-block.md'),`---\nschema: agent-rules/v1\nid: prompt-block\ndescription: Probe prompt-block.\nevents: [user_prompt]\ntarget: request\nrequires: []\npriority: 90\ndetector:\n  type: regex\n  pattern: BLOCKED_TOPIC\nintervention: block\n---\n## Correction\nDo not handle BLOCKED_TOPIC.\n`);
 const rejected=call(cwd,platform,{hook_event_name:'UserPromptSubmit',prompt:'Research BLOCKED_TOPIC.'});
 assert.equal(rejected.decision,'block');assert.equal(rejected.reason,'Agent Rules blocked this request. prompt-block: Probe prompt-block.');
 assert.deepEqual(call(cwd,platform,{hook_event_name:'UserPromptSubmit',prompt:'Something else.'}),{});
});
test('built plugin folder works when copied to a path with spaces without node_modules',()=>{
 const cwd=setup();const installed=join(cwd,'installed plugin');
 cpSync(resolve('plugin'),installed,{recursive:true});
 for(const path of ['hooks/claude.json','hooks/codex.json','.claude-plugin/plugin.json','.codex-plugin/plugin.json','skills/author-rule/SKILL.md','omp/agent-rules.js'])assert.ok(existsSync(join(installed,path)),path);
 // A root plugin.json takes precedence in Codex and hides .codex-plugin/plugin.json's hooks.
 for(const path of ['node_modules','src','test','docs','plugin.json'])assert.ok(!existsSync(join(installed,path)),path);
 for(const [manifest,hooks] of [['.claude-plugin/plugin.json','./hooks/claude.json'],['.codex-plugin/plugin.json','./hooks/codex.json']])assert.equal(JSON.parse(readFileSync(join(installed,manifest),'utf8')).hooks,hooks,manifest);
 const r=spawnSync(process.execPath,[join(installed,'dist/agent-rules.js'),'validate',join(installed,'policies')],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr+r.stdout);
 const first=call(cwd,'codex',{hook_event_name:'Stop',last_assistant_message:'TRIGGER'},join(installed,'dist/behavior-hook.js'));
 assert.equal(first.decision,'block');
});
