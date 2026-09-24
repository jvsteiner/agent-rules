import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync,mkdirSync,writeFileSync,cpSync } from 'node:fs';
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
 assert.equal(fixed.decision,undefined);assert.ok(fixed.systemMessage);
});
test('copied built plugin works from a path with spaces without node_modules',()=>{
 const cwd=setup();const installed=join(cwd,'installed plugin');mkdirSync(installed);
 for(const folder of ['dist','policies','rules'])cpSync(resolve(folder),join(installed,folder),{recursive:true});
 cpSync(resolve('package.json'),join(installed,'package.json'));
 const r=spawnSync(process.execPath,[join(installed,'dist/agent-rules.js'),'validate',join(installed,'policies')],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr+r.stdout);
 const first=call(cwd,'codex',{hook_event_name:'Stop',last_assistant_message:'TRIGGER'},join(installed,'dist/behavior-hook.js'));
 assert.equal(first.decision,'block');
});
