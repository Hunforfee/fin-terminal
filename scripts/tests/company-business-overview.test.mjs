import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from './load-modules.mjs';
const {buildCompanyBusinessOverview}=await load('companyBusinessOverview');
const {parseBusinessReview}=await load('datasource/business');
const business={summary:null,scope:null,segments:[],reportDate:null,source:'test'};

test('business introduction retains complete long statements without a fixed character cutoff',()=>{
  const long='公司主营业务包括种子研发、农业生产、粮食加工与销售，'+Array.from({length:30},(_,i)=>`第${i+1}项服务覆盖种植和加工环节`).join('，')+'，业务还包含产品回收服务';
  const result=buildCompanyBusinessOverview({...business,summary:long+'。'});
  assert.equal(result.paragraphs.length,1);
  assert.equal(result.paragraphs[0],long+'。');
  assert.ok(result.paragraphs[0].length>220);assert.ok(!result.paragraphs[0].includes('…'));
});
test('business statements are retained while history and award clauses are omitted',()=>{
  const result=buildCompanyBusinessOverview({...business,summary:'公司成立于2010年，主营业务包括种子研发、生产和销售。公司荣获文明单位和先进集体等荣誉。旗下加工企业向食品厂提供粮食加工服务，荣获质量奖。'});
  const text=result.paragraphs.join('\n');
  assert.match(text,/主营业务包括种子研发、生产和销售/);assert.match(text,/向食品厂提供粮食加工服务/);
  assert.doesNotMatch(text,/荣获|质量奖|文明单位|成立于/);
});
test('revenue and gross profit contributions remain separate and missing values are not fabricated',()=>{
  const result=buildCompanyBusinessOverview({...business,reportDate:'2026-06-30',dimension:'产品',segments:[
    {name:'贸易',income:100,incomeRatio:0.7,profitRatio:0.1,grossMargin:0.02},
    {name:'服务',income:40,incomeRatio:0.28,profitRatio:0.9,grossMargin:0.6},
    {name:'未知业务',income:null,incomeRatio:null,profitRatio:null,grossMargin:null},
  ]});
  const text=result.paragraphs.join('\n');
  assert.match(text,/贸易的收入占比为70.0%/);assert.match(text,/服务贡献90.0%的毛利/);
  assert.match(text,/不能直接等同于归母净利润贡献/);assert.doesNotMatch(text,/未知业务.*0.0%/);
  assert.equal(result.compositionDate,'2026-06-30');
});
test('actual customer and operating model evidence is extracted with its reporting period',()=>{
  const result=buildCompanyBusinessOverview({...business,reviewDate:'2026-06-30',review:'公司获评行业先进集体。公司向种植大户提供种子、农资供应、技术服务与产品回收的全流程服务。公司产品经销商覆盖省内主要地区。'});
  assert.match(result.paragraphs.join('\n'),/2026-06-30报告期/);
  assert.match(result.paragraphs.join('\n'),/向种植大户提供种子、农资供应、技术服务与产品回收/);
  assert.doesNotMatch(result.paragraphs.join('\n'),/先进集体/);
  assert.equal(result.reviewDate,'2026-06-30');
});
test('missing disclosures do not create a business model, customers or operating evidence',()=>{
  assert.deepEqual(buildCompanyBusinessOverview(null),{paragraphs:[],compositionDate:null,reviewDate:null});
  const result=buildCompanyBusinessOverview({...business,reviewDate:'2026-06-30',review:'公司荣获行业先进集体。'});
  assert.equal(result.reviewDate,null);assert.deepEqual(result.paragraphs,[]);
});
test('latest dated management review is selected independent of upstream order, excluding future and impossible dates',()=>{
  const result=parseBusinessReview([
    {REPORT_DATE:'2025-12-31',BUSINESS_REVIEW:'旧的经营评述'},
    {REPORT_DATE:'2026-06-30',BUSINESS_REVIEW:'最新经营评述'},
    {REPORT_DATE:'2026-12-31',BUSINESS_REVIEW:'未来经营评述'},
    {REPORT_DATE:'2026-02-30',BUSINESS_REVIEW:'错误日期'},
  ],'2026-10-19');
  assert.deepEqual(result,{review:'最新经营评述',reviewDate:'2026-06-30'});
  assert.deepEqual(parseBusinessReview(null),{review:null,reviewDate:null});
});
