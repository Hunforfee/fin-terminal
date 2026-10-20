import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { canonicalCode, registeredCodes, validateAnalysis, isCompanyTarget } from '../lib/analysis-coverage.mjs';
import { sectorOf, guides } from '../hk-research-guides.mjs';
import { load } from './load-modules.mjs';
const { normalizeStockCode } = await load('datasource/codes');
const date = '2026-10-20';
const draft = JSON.parse(fs.readFileSync(new URL('../../src/data/analyses/01836.json',import.meta.url),'utf8'));
test('watchlist and UI aliases agree with the production normalizer',()=>{
  for(const value of ['sh600519','600519.SH','sz300498','300498','hk700','HK00700','00700.HK','01836']) assert.equal(canonicalCode(value),normalizeStockCode(value)?.code,value);
  for(const value of ['../600519','00000','https://example.com','hello',null]) assert.equal(canonicalCode(value),null);
});
test('registry discovery detects an existing file that is not exposed by the app',()=>{
  assert.deepEqual([...registeredCodes("export const a = {'600519': x, '00700': y};")],['600519','00700']);
  assert.equal(registeredCodes("import a from './01836.json';").has('01836'),false);
});
test('watchlist discovery excludes clear fund/index entries without confusing cross-market codes',()=>{
  for(const code of ['sh000001','000016.SH','sz399001','510300','sz159915']) assert.equal(isCompanyTarget(code),false,code);
  assert.equal(isCompanyTarget('hk02800','etf'),false);
  assert.equal(isCompanyTarget('sz000001'),true);
  assert.equal(isCompanyTarget('00016.HK'),true);
  assert.equal(isCompanyTarget('01836'),true);
});
test('source-backed drafts cannot silently become institutional or reviewed analysis',()=>{
  assert.deepEqual(validateAnalysis(draft,'01836',date),[]);
  assert(validateAnalysis({...draft,ratingSummary:{buy:0,hold:0,sell:0}},'01836',date).some(error=>error.includes('机构评级')));
  assert(validateAnalysis({...draft,viewBasis:'institutional_views'},'01836',date).some(error=>error.includes('区分假设')));
  assert(validateAnalysis({...draft,verificationTasks:[]},'01836',date).some(error=>error.includes('待核验')));
  assert(validateAnalysis({...draft,researchStatus:'reviewed'},'01836',date).some(error=>error.includes('复核记录')));
});
test('wrong issuers, future dates and unsafe sources fail validation',()=>{
  assert(validateAnalysis({...draft,code:'02460'},'01836',date).length);
  assert(validateAnalysis({...draft,generatedAt:'2026-02-30'},'01836',date).length);
  assert(validateAnalysis({...draft,generatedAt:'2027-01-01'},'01836',date).length);
  assert(validateAnalysis({...draft,sources:[{url:'javascript:alert(1)',label:'bad',kind:'issuer'}]},'01836',date).length);
});
test('business frameworks use leaf industries and issuer-specific exceptions',()=>{
  assert.equal(sectorOf('01836','非日常生活消费品-耐用消费品与服装-纺织品、服装与奢侈品-鞋类'),'manufacturingConsumer');
  assert.equal(sectorOf('00570','医疗保健-制药、生物科技和生命科学-制药-制药'),'pharma');
  assert.equal(sectorOf('01951','医疗保健-医疗保健设备与服务-医疗保健提供商与服务-保健护理服务'),'medicalService');
  assert.equal(sectorOf('09880','生物科技'),'robotics');
  assert.equal(sectorOf('03690','餐馆'),'localPlatform');
  assert.equal(sectorOf('02473','汽车零件与设备'),'lease');
  assert(!guides.robotics.peers.includes('00966'));
});
test('all 170 new drafts retain source identities, frozen ratios and unresolved verification tasks',()=>{
  const dir=new URL('../../src/data/analyses/',import.meta.url);
  const rows=fs.readdirSync(dir).filter(file=>/^\d{5}\.json$/.test(file)).map(file=>JSON.parse(fs.readFileSync(new URL(file,dir),'utf8'))).filter(row=>row.researchStatus==='draft');
  assert.equal(rows.length,170);
  for(const row of rows){
    assert.deepEqual(validateAnalysis(row,row.code,date),[],row.code);
    assert.equal(row.evidence.originalReportRead,false,row.code);
    assert.equal(row.evidence.absoluteAmountsUsed,false,row.code);
    assert.equal(row.evidence.numericalBasis,'aggregate-ratios-only',row.code);
    assert(row.evidence.metrics && row.verificationTasks.length>=5,row.code);
  }
});
