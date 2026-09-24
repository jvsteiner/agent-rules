import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {decode} from '../src/platforms.js';
import {handleEvent} from '../src/runtime.js';
import {createReviewer} from '../src/review.js';
import {parsePolicy} from '../src/catalog.js';

test('captured Codex command lifecycle reaches reviewer with a completed receipt',async()=>{
 const fixture=JSON.parse(await readFile(new URL('./fixtures/hosts/codex-receipts.json',import.meta.url),'utf8'));
 const policy=parsePolicy(await readFile(new URL('../policies/test-result-contradiction.md',import.meta.url),'utf8'));
 let calls=0;
 const reviewer=createReviewer({client:{evaluate:async({state,questions})=>{
  calls++;assert.equal(state.receipts.length,1);assert.equal(state.receipts[0].status,'completed');assert.match(state.receipts[0].result,/2 failed/);
  return {model:'recorded-test-model',answers:Object.fromEntries(Object.keys(questions).map(id=>[id,{type:'choice',choice:'supported',probabilities:{supported:1,contradicted:0,unknown:0,not_applicable:0}}]))};
 }}});
 const context={reviewer,policies:[policy],stateDir:await mkdtemp(join(tmpdir(),'ar-observed-')),config:{}};
 for(const payload of fixture.events){const effect=await handleEvent(decode('codex',payload),context);assert.notEqual(effect.action,'continue_turn');}
 assert.equal(calls,1);
});
for(const platform of ['claude','codex'])test(`${platform} captured Stop continuation keeps its host identity`,async()=>{
 const fixture=JSON.parse(await readFile(new URL(`./fixtures/hosts/${platform}-correction.json`,import.meta.url),'utf8'));
 const stops=fixture.events.filter(p=>p.hook_event_name==='Stop').map(p=>decode(platform,p));
 assert.equal(stops.length,2);assert.equal(stops[0].stopHookActive,false);assert.equal(stops[1].stopHookActive,true);
 assert.equal(stops[0].sessionId,stops[1].sessionId);assert.equal(stops[1].response,'PROBE_CORRECTED');
 assert.equal(stops[0].thinking,undefined);
});
