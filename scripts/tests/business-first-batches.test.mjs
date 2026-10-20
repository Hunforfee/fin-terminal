import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateAnalysis,registeredCodes} from '../lib/analysis-coverage.mjs';
import {businessProfile} from '../business-first-profiles.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const batches=await Promise.all(['','-2'].map(async suffix=>JSON.parse(await fs.readFile(path.join(root,`docs/a-research-batch-500${suffix}.json`),'utf8'))));
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const entries=await Promise.all(batches.flatMap(b=>b.companies.map(async c=>{const raw=await fs.readFile(path.join(root,c.file),'utf8');return {c,b,raw,a:JSON.parse(raw)};})));
test('two authorized batches contain 1000 distinct companies and preserve sample boundaries',()=>{
 assert.equal(entries.length,1000);assert.equal(new Set(entries.map(x=>x.c.code)).size,1000);
 for(const b of batches){assert.equal(b.companies.length,500);assert.equal(b.businessRewritten,500);for(const c of b.companies){assert(!b.baselineExistingCodes.includes(c.code));assert(!['000848','603866'].includes(c.code));}}
 const prior=new Set(batches[1].baselineExistingCodes);for(const c of batches[0].companies)assert(prior.has(c.code));
});
test('business rewrites preserve all other sections, evidence identity and registry membership',async()=>{
 const registered=registeredCodes(await fs.readFile(path.join(root,'src/data/analyses/index.ts'),'utf8'));
 for(const {c,a,b,raw}of entries){
  assert.equal(hash(raw),c.sha256,c.code);assert(registered.has(c.code));assert.deepEqual(validateAnalysis(a,c.code,b.asOf),[]);
  const sections=JSON.stringify(Object.fromEntries(Object.entries(a).filter(([k])=>!['summary','evidence'].includes(k))));
  assert.equal(hash(sections),c.businessRevision.retainedSectionsSha256,c.code);
  assert.equal(a.evidence.editorialStyle,'business-product-industry-v3');assert.equal(a.evidence.manualReview,false);assert.equal(a.evidence.originalReportRead,false);
  assert.equal(a.researchStatus,'draft');assert(!a.ratingSummary&&!a.targetPriceRange);assert(a.sources.some(x=>x.kind==='disclosure'));
 }
});
test('all business bodies describe disclosed products and industry mechanics rather than repeat financial summaries',()=>{
 for(const {a,c}of entries){
  assert.equal(a.summary.split('\n\n').length,5,c.code);assert(a.summary.length>=1000);
  assert(!/undefined|NaN|聚合财务表列示|经营现金流净额|归母利润|扣非/.test(a.summary),c.code);
  assert(a.summary.includes(a.fullName));assert(a.summary.includes('客户'));assert(a.summary.includes('行业竞争'));assert(a.summary.includes('交付'));
  const products=a.evidence.business.items.filter(x=>!/^其中/.test(x.name)&&!/(其他|内部|抵销|抵消)/.test(x.name));
  assert(!products.length||a.summary.includes(products[0].name),c.code);
 }
});
test('hospitality, aviation, technical services and cloud infrastructure retain distinct business meanings',()=>{
 assert(businessProfile('travel','休闲服务-酒店').use.includes('住宿'));
 assert(businessProfile('travel','交通运输-航空').use.includes('旅客'));
 assert(businessProfile('professional').use.includes('专业结果'));
 assert(businessProfile('datacenter').use.includes('机柜'));
 assert(businessProfile('oil','石油天然气-油田服务').use.includes('作业'));
 assert(businessProfile('battery').use.includes('能量存储'));
});
