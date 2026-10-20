import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {aGuide} from '../a-research-guides.mjs';
import {validateAnalysis,registeredCodes} from '../lib/analysis-coverage.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const batch=JSON.parse(await fs.readFile(path.join(root,'docs/a-research-batch-500.json'),'utf8'));
const prepared=await Promise.all(batch.companies.map(async c=>({target:c,raw:await fs.readFile(path.join(root,c.file),'utf8')})));
test('authorized batch is exactly 500 new A-share companies, excluding approved sample and previous coverage',()=>{
 assert.equal(prepared.length,500);assert.equal(new Set(prepared.map(x=>x.target.code)).size,500);
 for(const {target:c} of prepared){assert.match(c.code,/^(?:00|30|60|68|43|83|87|88|92)\d{4}$/);assert(!batch.baselineExistingCodes.includes(c.code));assert.notEqual(c.code,'000848');}
 assert.deepEqual(batch.sectionTitles,['业务与模式','营收构成','护城河','竞争对手对比','市场观点','公司资料']);
});
test('all 500 drafts have registered, dated evidence and remain separate from verified institutional research',async()=>{
 const index=registeredCodes(await fs.readFile(path.join(root,'src/data/analyses/index.ts'),'utf8'));
 for(const {target:c,raw} of prepared){const a=JSON.parse(raw);
  assert.equal(crypto.createHash('sha256').update(raw).digest('hex'),c.sha256,c.code);
  assert.deepEqual(validateAnalysis(a,c.code,batch.asOf),[],c.code);assert(index.has(c.code));
  assert.equal(a.evidence.batchId,batch.id);assert.equal(a.researchStatus,'draft');assert.equal(a.evidence.manualReview,false);
  assert.equal(a.evidence.originalReportRead,false);assert(!a.ratingSummary&&!a.targetPriceRange);
  assert.equal(a.summary.split('\n\n').length,5);assert(a.summary.length>=1000);
  assert.equal(a.evidence.profileIdentity.securityCode,c.code);assert.equal(a.evidence.financial.currency,'CNY');
  assert(a.evidence.financial.reportDate<=batch.asOf);assert(a.evidence.financial.noticeDate<=batch.asOf);assert(a.evidence.financial.updateDate<=batch.asOf);
  assert(a.sources.length>=4);assert(a.sources.some(s=>s.kind==='disclosure'));assert(a.verificationTasks.length>=5);
 }
});
test('revenue snapshots retain a single dated set per dimension, never add totals to included subitems',()=>{
 for(const {target:c,raw} of prepared){const a=JSON.parse(raw);
  assert(a.businessSnapshot.groups.length,c.code);
  for(const group of a.businessSnapshot.groups){assert.equal(group.date,a.evidence.business.reportDate);assert.equal(new Set(group.items.map(x=>x.name)).size,group.items.length);}
  assert(/收入占比(?:不等于归母利润占比|不是利润占比)/.test(a.summary));
  if(a.evidence.business.items.some(x=>/^其中/.test(x.name))){assert(!a.position.includes('其中:'),c.code);}
 }
});
test('bank, insurance, wholesale markets and industrial products use appropriate business models',()=>{
 assert.equal(aGuide('金融-银行-股份制与城商行').key,'bank');assert.equal(aGuide('金融-非银行金融-保险').key,'insurance');
 assert.equal(aGuide('商贸零售-商业物业经营-专业市场').key,'market');assert.equal(aGuide('钢铁-钢铁-特钢').key,'steel');
 assert.equal(aGuide('基础化工-合成纤维及树脂-涤纶').key,'chemicals');
 for(const {raw} of prepared){const a=JSON.parse(raw);if(['bank','insurance','broker','otherFinance'].includes(aGuide(a.industry).key)){
  assert(a.summary.includes('服务量和资金规模不是普通商品销量'));for(const g of a.businessSnapshot.groups)for(const s of g.items)assert.equal(s.grossMargin,null);
 }}
});
