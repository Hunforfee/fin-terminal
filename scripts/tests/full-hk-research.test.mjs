import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {simplified} from '../hk-simplified.mjs';
import {validateAnalysis,registeredCodes} from '../lib/analysis-coverage.mjs';
import {hkGuide} from '../hk-full-guides.mjs';
const batch=JSON.parse(await fs.readFile('docs/full-hk-research.json','utf8'));
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
test('new HK scope excludes all existing A/H research and preserves every baseline byte',async()=>{
 assert.equal(batch.companies.length,2548);assert.equal(new Set(batch.companies.map(x=>x.code)).size,2548);
 assert.equal(Object.keys(batch.baselineExisting).length,5825);
 for(const t of batch.companies){assert.equal(t.market,'HK');assert(/^\d{5}$/.test(t.code));assert(!batch.baselineExisting[t.code]);}
 for(const [code,sha]of Object.entries(batch.baselineExisting))assert.equal(hash(await fs.readFile(`src/data/analyses/${code}.json`)),sha,code);
});
test('new HK research uses simplified Chinese, sourced identity and explicit unresolved tasks',async()=>{
 const registered=registeredCodes(await fs.readFile('src/data/analyses/index.ts','utf8'));
 for(const t of batch.companies){
  if(t.analysisStatus!=='draft'){assert.equal(t.readiness,'source-gap');assert(t.gaps.length);continue;}
  const raw=await fs.readFile(t.file),a=JSON.parse(raw);
  assert.equal(hash(raw),t.sha256,t.code);assert(registered.has(t.code));
  assert.deepEqual(validateAnalysis(a,t.code,batch.asOf),[],t.code);
  assert.deepEqual(simplified(a),a,t.code);assert.equal(a.evidence.language,'zh-CN');
  assert.equal(a.evidence.profileIdentity.securityCode,t.code);assert.equal(a.researchStatus,'draft');
  assert.equal(a.evidence.originalReportRead,false);assert.equal(a.evidence.manualReview,false);
  assert.equal(a.evidence.absoluteAmountsUsed,false);assert(!a.ratingSummary&&!a.targetPriceRange);
  assert.equal(a.summary.split('\n\n').length,5);assert.equal(a.businessSnapshot.groups.length,0);
  assert(a.verificationTasks.some(x=>x.includes('币种')));assert(a.verificationTasks.some(x=>x.includes('分部')));
  assert.equal(a.evidence.companyBusinessSignals.sourceId,'profile');
  try{
   const rawIssuer=JSON.parse(await fs.readFile(`src/data/analyses/_raw/full-market/${t.code}.json`,'utf8'));
   const issuerText=simplified(rawIssuer.profile.MAIN_BUSINESS||'');
   for(const term of [...a.evidence.companyBusinessSignals.products,...a.evidence.companyBusinessSignals.regions])assert(issuerText.includes(term),t.code+' unsupported issuer term '+term);
  }catch(error){if(error.code!=='ENOENT')throw error;}
 }
});
test('asset managers, lenders and service businesses do not inherit unrelated operating models',()=>{
 assert.equal(hkGuide('09999','金融-资产管理与托管').key,'assetManager');
 const credit=hkGuide('09999','金融-消费信贷');assert.equal(credit.key,'consumerCredit');assert(!credit.g.model.includes('飞机'));
 assert.equal(hkGuide('09999','工业-建筑与工程').key,'construction');
 assert.equal(hkGuide('09999','金融-交易与支付处理服务').key,'payment');
 const input={name:'騰訊控股',url:'https://example.com/繁體',code:'00700',value:1.25,product:'BEBT-908'};
 assert.deepEqual(simplified(input),{...input,name:'腾讯控股'});
});
