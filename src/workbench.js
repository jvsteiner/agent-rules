import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The evaluator crosses exactly the same review interface as the hook runtime. */
export async function evaluateCases({ policies, cases, reviewer, model, replay }) {
  if (!reviewer && !replay) throw new Error('Offline evaluation requires a matching replay; use --live to call Jev.');
  const results=[];
  const summary={total:cases.length,passed:0,failed:0,falsePositives:0,falseNegatives:0,abstentions:0,unavailable:0,inputTokens:0,outputTokens:0};
  for (const example of cases) {
    if (!example.id || !example.snapshot || !['clear','violation','unknown'].includes(example.expected)) throw new Error('Fixture requires id, snapshot and expected status.');
    if (!['generated','human','human-reviewed'].includes(example.labelSource) || !['development','holdout'].includes(example.split)) throw new Error(`Fixture ${example.id}: labelSource and split are required.`);
    const inputHash=digest({snapshot:example.snapshot,policies:policies.map(p=>[p.id,p.hash]),model});
    let review;
    if(reviewer) review=await reviewer.review(example.snapshot,policies);
    else {
      const stored=replay.cases?.find(c=>c.id===example.id && c.inputHash===inputHash);
      if(!stored) throw new Error(`No matching replay for ${example.id}; policy, evidence or model changed.`);
      review=stored.review;
    }
    const findings=example.ruleId ? review.findings.filter(f=>f.ruleId===example.ruleId) : review.findings;
    const statuses=findings.map(f=>f.status);
    const actual=statuses.includes('violation')?'violation':statuses.includes('unavailable')?'unavailable':statuses.includes('unknown')||!statuses.length?'unknown':'clear';
    const passed=actual===example.expected;
    summary[passed?'passed':'failed']++;
    if(actual==='violation' && example.expected!=='violation') summary.falsePositives++;
    if(actual==='clear' && example.expected==='violation') summary.falseNegatives++;
    if(actual==='unknown') summary.abstentions++;
    if(actual==='unavailable') summary.unavailable++;
    summary.inputTokens+=review.usage?.input_tokens??0;
    summary.outputTokens+=review.usage?.output_tokens??0;
    results.push({id:example.id,ruleId:example.ruleId,labelSource:example.labelSource,split:example.split,expected:example.expected,actual,passed,inputHash,review});
  }
  return {schema:'agent-rules/evaluation-v1',createdAt:new Date().toISOString(),live:!!reviewer,model,policyHashes:policies.map(p=>({id:p.id,hash:p.hash})),summary,cases:results};
}

export function compareReports(before,after) {
  const changes=[];
  for(const c of after.cases) {
    const prior=before.cases.find(x=>x.id===c.id);
    if(!prior || prior.actual!==c.actual || prior.passed!==c.passed) changes.push({id:c.id,before:prior?.actual??null,after:c.actual,passed:c.passed});
  }
  return {before:before.summary,after:after.summary,changes,removed:before.cases.filter(c=>!after.cases.some(x=>x.id===c.id)).map(c=>c.id)};
}
