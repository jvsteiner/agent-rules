#!/usr/bin/env node
import { dirname,resolve,join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { loadPolicies } from '../src/catalog.js';
import { createReviewer } from '../src/review.js';
import { createJevClient } from '../src/jev.js';
import { handleEvent } from '../src/runtime.js';
import { decode,encode } from '../src/platforms.js';
import { loadRules } from '../src/rules.js';
import { matchPayload } from '../src/match.js';
import { maintainJournal } from '../src/journal-maintenance.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
async function main(){
 let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>2_000_000)throw new Error('payload too large');}
 const payload=JSON.parse(input);const platform=process.argv[2];const event=decode(platform,payload);if(!event)return;
 const {config,diagnostics}=await loadConfig({projectRoot:payload.cwd??process.cwd()});
 if(event.kind==='session_start')await maintainJournal(config.stateDir);
 const loaded=await loadPolicies({directories:[join(root,'policies'),...config.policyDirectories],modes:config.rules});
 const reviewer=createReviewer({client:createJevClient(),model:config.model,deadlineMs:config.reviewDeadlineMs,maxReviewRequests:config.maxReviewRequests});
 let effect=await handleEvent(event,{reviewer,policies:loaded.policies,stateDir:config.stateDir,config});
 // Preserve existing deterministic checks separately from semantic correction accounting.
 if(['tool_start','tool_result'].includes(event.kind)&&event.changes?.length&&process.env.AGENT_RULES_LEGACY!=='0'){
  const legacy=loadRules([join(root,'rules'),join(homedir(),'.omp/agent/rules'),join(payload.cwd??'.','.omp/rules')]);
  const hits=new Map();
  for(const change of event.changes){const tool=event.tool?.name==='Write'?'Write':'Edit';for(const f of matchPayload({tool_name:tool,cwd:payload.cwd,tool_input:{file_path:change.path,content:change.text,new_string:change.text}},legacy.rules))hits.set(f.name,f);}
  const firing=[...hits.values()].filter(f=>f.delivery===(event.kind==='tool_start'?'pre':'post'));
  if(firing.length){
   const feedback=firing.map(f=>`[${f.name}] ${f.description}\n${f.body}`).join('\n\n').slice(0,8000);
   if(event.kind==='tool_start'&&platform==='claude'&&effect.action!=='deny_tool'){process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'ask',permissionDecisionReason:feedback}}));return;}
   if(event.kind==='tool_result')effect={action:'add_context',notice:'Agent Rules: deterministic code policy matched.',feedback:[effect.feedback,feedback].filter(Boolean).join('\n\n')};
  }
 }
 const warnings=[...diagnostics,...loaded.diagnostics];
 if(warnings.length&&event.kind==='session_start')effect.notice='Agent Rules: configuration diagnostics are available via status.';
 const reply=encode(platform,effect);if(Object.keys(reply).length)process.stdout.write(JSON.stringify(reply));
}
main().catch(()=>{process.stdout.write(JSON.stringify({systemMessage:'Agent Rules: review unavailable (invalid input or runtime failure). Run status for configuration diagnostics.'}));});
