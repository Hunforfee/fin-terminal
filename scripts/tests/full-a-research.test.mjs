import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {validateAnalysis,registeredCodes} from '../lib/analysis-coverage.mjs';
const batch=JSON.parse(await fs.readFile('docs/full-market-research.json','utf8'));
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
test('active scope is remaining A shares only; every original analysis is byte-preserved',async()=>{
 assert.equal(batch.companies.length,3982);
 assert.equal(new Set(batch.companies.map(x=>x.code)).size,3982);
 for(const t of batch.companies){assert.equal(t.market,'A');assert(!batch.baselineExisting[t.code]);}
 assert.equal(Object.keys(batch.baselineExisting).length,1843);
 for(const [code,sha]of Object.entries(batch.baselineExisting))assert.equal(hash(await fs.readFile(`src/data/analyses/${code}.json`)),sha,code);
 const actual=(await fs.readdir('src/data/analyses')).filter(x=>/^\d{5}\.json$/.test(x)).map(x=>x.slice(0,-5));
 let hk;try{hk=JSON.parse(await fs.readFile('docs/full-hk-research.json','utf8'));}catch{}
 const approved=new Set(hk?.companies.map(x=>x.code)||[]);
 for(const code of actual)assert(batch.baselineExisting[code]||approved.has(code),'Unapproved HK addition: '+code);
});
test('new drafts retain real issuer evidence, dated sources, research tasks and exact registration',async()=>{
 const registry=registeredCodes(await fs.readFile('src/data/analyses/index.ts','utf8'));
 for(const t of batch.companies){
  if(t.analysisStatus!=='draft'){assert.equal(t.readiness,'source-gap');assert(t.gaps.length);continue;}
  const raw=await fs.readFile(`src/data/analyses/${t.code}.json`),a=JSON.parse(raw);
  assert.equal(hash(raw),t.sha256,t.code);assert(registry.has(t.code));
  assert.deepEqual(validateAnalysis(a,t.code,batch.asOf),[],t.code);
  assert.equal(a.researchStatus,'draft');assert.equal(a.evidence.originalReportRead,false);
  assert.equal(a.evidence.manualReview,false);assert(!a.ratingSummary&&!a.targetPriceRange);
  assert.equal(a.evidence.profileIdentity.securityCode,t.code);
  assert(a.summary.split('\n\n').length>=5);assert(a.summary.includes('[概况]'));
  const product=a.evidence.business.items.find(x=>!/(^其他|补充|抵销|抵消|内部)/.test(x.name)&&!/^其中[:：]?/.test(x.name));
  if(product)assert(a.summary.includes(product.name),t.code);
 }
});
