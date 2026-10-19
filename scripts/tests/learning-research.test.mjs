import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {load} from './load-modules.mjs';
const {makeLearningResearch}=await load('learningResearch');
const {parseLearningLatest,parseLearningAnnual}=await load('companyLearning');
const {buildCompanyBusinessOverview}=await load('companyBusinessOverview');
const date='2026-10-19';
const pre={code:'300498',industry:'养殖',summary:'业务结构。\n\n经营变化。',source:'公司披露与研报',generatedAt:date,moat:[{point:'优势',detail:'证据'}],competitors:[{name:'同行',code:'002714',note:'比较口径'}],bullCase:[{point:'预测',detail:'机构对下一年的预测'}],bearCase:[{point:'风险',detail:'尚需跟踪'}]};
const business={summary:'公司主营业务为养殖。',scope:null,review:null,reviewDate:'2026-06-30',industry:'养殖',groups:[],reportDate:'2026-06-30',dimension:'产品',source:'test',segments:[{name:'肉猪类',income:266e8,incomeRatio:0.57,grossMargin:-0.09,profitRatio:1.75},{name:'肉鸡类',income:174e8,incomeRatio:0.373,grossMargin:0.055,profitRatio:-0.7}]};

for (const code of ['300498', '300750', '600660']) test(`daily preview uses the original AI article for ${code}, including newly synced research`,()=>{
  const original=JSON.parse(fs.readFileSync(new URL(`../../src/data/analyses/${code}.json`,import.meta.url),'utf8'));
  const result=makeLearningResearch(original,date,business,{period:'2026-06-30',revenue:12345,profit:-12345});
  assert.equal(result.paragraphs.join('\n\n'),original.summary.trim());
  assert.equal(result.source,original.source);
  assert.deepEqual(result.advantages,original.moat.slice(0,4));
  assert.deepEqual(result.bull,original.bullCase.slice(0,4));
  assert.deepEqual(result.bear,original.bearCase.slice(0,4));
  if(original.position)assert.equal(result.introduction,original.position);
});
test('uncovered and future-dated reports are not presented as available deep research',()=>{
  assert.equal(makeLearningResearch(undefined,date,business),null);
  assert.equal(makeLearningResearch({...pre,generatedAt:'2026-11-01'},date,business),null);
  assert.equal(makeLearningResearch({...pre,generatedAt:'2026-02-30'},date,business),null);
});
test('other prepared companies retain complete paragraphs and dated institutional views',()=>{
  const result=makeLearningResearch({...pre,code:'600519'},date,business);
  assert.deepEqual(result.paragraphs,['业务结构。','经营变化。']);assert.equal(result.date,date);
  assert.equal(result.competitors[0].code,'002714');assert.equal(result.bull[0].point,'预测');
});
test('latest interim data is separate from five actual annual reports and keeps missing values',()=>{
  const row={SECURITY_CODE:'300498',CURRENCY:'CNY',REPORT_DATE:'2026-06-30',NOTICE_DATE:'2026-08-30',OPERATE_INCOME_PK:0,PARENTNETPROFIT:-43e8,NETCASH_OPERATE_PK:null};
  const annual={...row,REPORT_DATE:'2025-12-31',NOTICE_DATE:'2026-03-30',OPERATE_INCOME_PK:100e8};
  const rows=[annual,row,{...row,REPORT_DATE:'2026-09-30',NOTICE_DATE:'2026-11-01'},{...row,SECURITY_CODE:'600519',REPORT_DATE:'2026-09-30'}];
  const latest=parseLearningLatest(rows,'300498',date);
  assert.equal(latest.period,'2026-06-30');assert.equal(latest.revenue,0);assert.equal(latest.ocf,null);
  assert.equal(parseLearningAnnual(rows,'300498',date)[0].period,'2025-12-31');
  assert.equal(parseLearningLatest([{...row,CURRENCY:'HKD'}],'300498',date),null);
});
test('negative aggregate gross profit ratios are never described as a normal profit contribution share',()=>{
  const result=buildCompanyBusinessOverview(business).paragraphs.join('\n');
  assert.doesNotMatch(result,/贡献175|175.0%的毛利/);assert.match(result,/毛利率为-9.0%/);
});
