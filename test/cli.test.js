import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync } from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const cli=resolve('bin/agent-rules.js');
function run(args,env={}) {return spawnSync(process.execPath,[cli,...args],{encoding:'utf8',env:{...process.env,...env}});}
test('status reports credential presence without revealing it',()=>{
 const r=run(['status'],{TYPESAFE_API_KEY:'TEST_SECRET_DO_NOT_PRINT'});
 assert.equal(r.status,0,r.stderr);assert.doesNotMatch(r.stdout,/TEST_SECRET/);
 assert.equal(JSON.parse(r.stdout).credentials.typesafe,true);
});
test('all bundled semantic policies validate through actual CLI',()=>{
 const r=run(['validate','policies']);assert.equal(r.status,0,r.stdout+r.stderr);
 assert.ok(JSON.parse(r.stdout).policies.length>=3);
});
test('set-mode preserves unrelated explicit configuration',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ar-cli-'));const config=join(dir,'config.json');
 writeFileSync(config,JSON.stringify({model:'jev-1.13.0',rules:{other:'observe'}}));
 const r=run(['set-mode','communication.unexplained-jargon','repair','--config',config]);assert.equal(r.status,0,r.stderr);
 const c=JSON.parse(readFileSync(config));assert.equal(c.rules.other,'observe');assert.equal(c.rules['communication.unexplained-jargon'],'repair');
});
test('evaluate never silently makes remote requests',()=>{
 const r=run(['evaluate','policies/test-result-contradiction.md','--fixtures','policies/test-result-contradiction.cases.jsonl']);
 assert.notEqual(r.status,0);assert.match(r.stderr,/replay|live/i);
});
test('inspect searches bounded review history by rule and can select a session',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ar-inspect-'));const stateDir=join(dir,'state');const config=join(dir,'config.json');
 const record={episodeId:3,sequence:12,timestamp:'2026-09-24T10:00:00.000Z',outcome:{action:'continue_turn',correction:'Please remove the cat pictures.'},findings:[{ruleId:'communication.cat-pictures',status:'violation',judgment:{choice:'yes'},diagnostic:null}]};
 writeFileSync(join(dir,'state-file.json'),JSON.stringify({version:1,generation:3,episodeId:3,sessionId:'session-one',findings:{},history:[record]}));
 mkdirSync(stateDir);copyFileSync(join(dir,'state-file.json'),join(stateDir,'state-file.json'));
 writeFileSync(config,JSON.stringify({stateDir}));
 const r=run(['inspect','communication.cat-pictures','--session','session-one'],{AGENT_RULES_STATE_DIR:stateDir});
 assert.equal(r.status,0,r.stderr);const data=JSON.parse(r.stdout);
 assert.equal(data.records.length,1);assert.equal(data.records[0].episodeId,3);assert.equal(data.records[0].findings[0].ruleId,'communication.cat-pictures');
 assert.equal(data.records[0].outcome.correction,'Please remove the cat pictures.');
 const absent=run(['inspect','communication.cat-pictures','--session','other'],{AGENT_RULES_STATE_DIR:stateDir});
 assert.equal(JSON.parse(absent.stdout).records.length,0);
});
