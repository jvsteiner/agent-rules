import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCases, compareReports } from '../src/workbench.js';

const policy={id:'test',hash:'v1'};
const cases=[{id:'a',labelSource:'generated',split:'development',snapshot:{response:'bad'},expected:'violation'},
 {id:'b',labelSource:'generated',split:'holdout',snapshot:{response:'good'},expected:'clear'}];
test('evaluation executes production reviewer and retains labeled provenance',async()=>{
 let calls=0;
 const reviewer={review:async s=>{calls++;return {findings:[{ruleId:'test',status:s.response==='bad'?'violation':'clear'}],model:'pinned',usage:{input_tokens:10},elapsedMs:2};}};
 const report=await evaluateCases({policies:[policy],cases,reviewer,model:'pinned'});
 assert.equal(calls,2);assert.equal(report.summary.passed,2);assert.equal(report.summary.failed,0);
 assert.equal(report.cases[1].split,'holdout');assert.equal(report.summary.inputTokens,20);
 const replay=await evaluateCases({policies:[policy],cases,model:'pinned',replay:report});
 assert.equal(replay.summary.passed,2);assert.equal(replay.live,false);
});
test('offline missing or stale replay cannot pretend it ran or call a model',async()=>{
 await assert.rejects(evaluateCases({policies:[policy],cases,model:'pinned'}),/replay|live/i);
 const report=await evaluateCases({policies:[policy],cases,model:'pinned',reviewer:{review:async()=>({findings:[{ruleId:'test',status:'clear'}]})}});
 await assert.rejects(evaluateCases({policies:[{...policy,hash:'v2'}],cases,model:'pinned',replay:report}),/replay/i);
});
test('reports distinguish false positive, false negative and abstention',async()=>{
 const report=await evaluateCases({policies:[policy],cases,model:'pinned',reviewer:{review:async s=>({findings:[{ruleId:'test',status:s.response==='bad'?'unknown':'violation'}]})}});
 assert.equal(report.summary.failed,2);assert.equal(report.summary.falsePositives,1);assert.equal(report.summary.abstentions,1);
 assert.equal(compareReports(report,report).changes.length,0);
});
