#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir, stat, rename } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { parsePolicy, loadPolicies } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { createReviewer } from '../src/review.js';
import { createJevClient } from '../src/jev.js';
import { evaluateCases, compareReports } from '../src/workbench.js';
import { installOmp } from '../src/install-omp.js';
import { existsSync } from 'node:fs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const command=args.shift();
const option=name=>{const i=args.indexOf(name);if(i<0)return undefined;const value=args[i+1];if(!value||value.startsWith('--'))throw new Error(`${name} requires a value`);args.splice(i,2);return value;};
const flag=name=>{const i=args.indexOf(name);if(i<0)return false;args.splice(i,1);return true;};
const output=value=>process.stdout.write(JSON.stringify(value,null,2)+'\n');
async function readJSON(file){return JSON.parse(await readFile(file,'utf8'));}
async function policiesAt(path){
 const file=resolve(path);const info=await stat(file);
 if(info.isDirectory())return loadPolicies({directories:[file]});
 return {policies:[parsePolicy(await readFile(file,'utf8'),{file})],diagnostics:[]};
}

async function main(){
 const envFile=option('--env-file');
 if(envFile){const env=parseEnv(await readFile(resolve(envFile),'utf8'));if(env.TYPESAFE_API_KEY)process.env.TYPESAFE_API_KEY=env.TYPESAFE_API_KEY;}
 // install-omp copies this package into omp. From a checkout, the built plugin/ folder is the package.
 if(command==='install-omp'){
  const rules=option('--rules');const pluginDir=existsSync(join(root,'plugin','package.json'))?join(root,'plugin'):root;
  for(const message of await installOmp({pluginDir,rulesDir:rules?resolve(rules):undefined}))process.stdout.write(message+'\n');
  process.stdout.write('Restart omp to load the extension.\n');return;
 }
 const configPath=option('--config');
 const {config,diagnostics}=await loadConfig({configPath});
 if(command==='validate'){
  const result=await policiesAt(args[0]??join(root,'policies'));
  output({policies:result.policies.map(p=>({id:p.id,hash:p.hash,mode:p.mode})),diagnostics:result.diagnostics});
  if(result.diagnostics.length||!result.policies.length)process.exitCode=1;return;
 }
 if(command==='evaluate'){
  const live=flag('--live');const fixtures=option('--fixtures');const replayFile=option('--replay');const out=option('--out');
  if(!live&&!replayFile)throw new Error('Use --live for remote evaluation or --replay <report> for offline evaluation.');
  if(live&&replayFile)throw new Error('Choose --live or --replay, not both.');
  if(!fixtures)throw new Error('--fixtures <file.jsonl> is required.');
  const result=await policiesAt(args[0]??join(root,'policies'));
  if(result.diagnostics.length)throw new Error('Policy validation failed; run validate for diagnostics.');
  const cases=(await readFile(resolve(fixtures),'utf8')).split('\n').filter(l=>l.trim()).map(JSON.parse);
  const reviewer=live?createReviewer({client:createJevClient(),model:config.model,deadlineMs:Math.max(config.reviewDeadlineMs,10000),maxReviewRequests:config.maxReviewRequests}):undefined;
  const report=await evaluateCases({policies:result.policies,cases,model:config.model,reviewer,replay:replayFile?await readJSON(replayFile):undefined});
  if(out){await mkdir(dirname(resolve(out)),{recursive:true});await writeFile(out,JSON.stringify(report,null,2)+'\n',{mode:0o600});}
  output(report);if(report.summary.failed)process.exitCode=1;return;
 }
 if(command==='compare'){output(compareReports(await readJSON(args[0]),await readJSON(args[1])));return;}
 if(command==='set-mode'){
  const scope=option('--scope')??'project';const [id,mode]=args;
  if(!/^[\w.-]+$/.test(id??'')||!['off','observe','repair','block'].includes(mode)||!['project','user'].includes(scope))throw new Error('set-mode <rule-id> off|observe|repair|block --scope user|project');
  const path=resolve(configPath??(scope==='user'?join(homedir(),'.config/agent-rules/config.json'):join(process.cwd(),'.agent-rules/config.json')));
  let data;try{data=await readJSON(path);}catch(e){if(e.code!=='ENOENT')throw e;data={schema:'agent-rules/config-v1'};}
  data.rules={...data.rules,[id]:mode};await mkdir(dirname(path),{recursive:true});const temp=`${path}.${process.pid}.tmp`;
  await writeFile(temp,JSON.stringify(data,null,2)+'\n',{mode:0o600});await rename(temp,path);output({id,mode,path});return;
 }
 if(command==='inspect'){
  const session=option('--session');const selector=args[0];const findings=[];const records=[];let files=[];try{files=await readdir(config.stateDir);}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const file of files.filter(f=>f.endsWith('.json'))){try{
   const state=await readJSON(join(config.stateDir,file));if(session&&state.sessionId!==session)continue;
   for(const f of Object.values(state.findings??{}))if(!selector||f.id===selector||f.ruleId===selector)findings.push({...f,source:'current',episodeId:state.episodeId,sessionId:state.sessionId});
   for(const record of state.history??[]){const matched=(record.findings??[]).filter(f=>!selector||f.id===selector||f.ruleId===selector);if(matched.length||(!selector&&!(record.findings??[]).length))records.push({...record,sessionId:state.sessionId,findings:matched});}
  }catch{}}
  records.sort((a,b)=>(a.timestamp??'').localeCompare(b.timestamp??'')||a.sequence-b.sequence);
  output({session:session??null,findings,records});return;
 }
 if(command==='status'){
  const result=await loadPolicies({directories:[join(root,'policies'),...config.policyDirectories],modes:config.rules});
  output({version:(await readJSON(join(root,'package.json'))).version,credentials:{typesafe:!!process.env.TYPESAFE_API_KEY},model:config.model,stateDir:config.stateDir,journalStorage:'per-session JSON snapshots with bounded review history',reviewDeadlineMs:config.reviewDeadlineMs,maxCorrectionsPerEpisode:config.maxCorrectionsPerEpisode,maxReviewRequests:config.maxReviewRequests,policies:result.policies.map(p=>({id:p.id,mode:p.mode,hash:p.hash})),diagnostics:[...diagnostics,...result.diagnostics],capabilities:{claudeStop:'verified',codexStop:'verified',claudeHeadlessNotices:'verified',codexHeadlessNotices:'not emitted by exec --json; inspect journal',thinking:'conditional; ordinary Stop payloads do not expose thinking',hookInstallation:'not inferred; verify host hook/trust configuration'}});return;
 }
 throw new Error('Commands: validate, evaluate, compare, inspect, status, set-mode, install-omp. Use --env-file explicitly for local development credentials.');
}
main().catch(error=>{process.stderr.write(`agent-rules: ${error.message}\n`);process.exitCode=1;});
