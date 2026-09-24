import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createJevClient} from '../src/jev.js';
import {createReviewer} from '../src/review.js';

async function server(t,handler){const s=createServer(handler);s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>{s.closeAllConnections();s.close();});return `http://127.0.0.1:${s.address().port}/v1/systemone`;}
test('real HTTP transport sends the System One contract exactly once',async t=>{
 let calls=0;
 const endpoint=await server(t,async(req,res)=>{calls++;assert.equal(req.url,'/v1/systemone');assert.equal(req.headers.authorization,'Bearer fake-key');let input='';for await(const chunk of req)input+=chunk;const body=JSON.parse(input);assert.equal(body.model,'jev-1.13.0');assert.equal(body.questions.check.type,'noul');res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({model:body.model,answers:{check:{type:'noul',noul:.99}},usage:{input_tokens:10}}));});
 const client=createJevClient({apiKey:'fake-key',endpoint});const r=await client.evaluate({state:{response:'test'},questions:{check:{type:'noul',instructions:'Is this a test?'}}});assert.equal(r.answers.check.noul,.99);assert.equal(calls,1);
});
test('HTTP 429 is not retried and errors do not include server body or key',async t=>{
 let calls=0;const endpoint=await server(t,(req,res)=>{calls++;res.writeHead(429);res.end('SENSITIVE_RESPONSE_BODY');});
 await assert.rejects(createJevClient({apiKey:'private-value',endpoint}).evaluate({state:'x',questions:{}}),e=>/429/.test(e.message)&&!e.message.includes('SENSITIVE')&&!e.message.includes('private-value'));
 assert.equal(calls,1);
});
test('review deadline aborts a real stalled connection as unavailable',async t=>{
 const endpoint=await server(t,()=>{});
 const reviewer=createReviewer({client:createJevClient({apiKey:'fake',endpoint}),deadlineMs:35});
 const policy={id:'timeout',hash:'h',events:['response_end'],requires:['response'],target:'response',detector:{type:'jev',question:{type:'noul',instructions:'Is this bad?'},decision:{violation_at_or_above:.9,clear_at_or_below:.1}}};
 const start=Date.now();const result=await reviewer.review({eventKind:'response_end',response:'bad'},[policy]);assert.equal(result.findings[0].status,'unavailable');assert.ok(Date.now()-start<2000);
});
