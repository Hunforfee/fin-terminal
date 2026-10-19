import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from './load-modules.mjs';
const learning=await load('companyLearning');
const {parseBusinessComposition}=await load('datasource/business');
const storage=await load('personalStorage');
const a={symbol:'sh600519',code:'600519',name:'贵州茅台',industry:'食品饮料',origin:'watchlist'};
const b={symbol:'sz000858',code:'000858',name:'五粮液',industry:'食品饮料',origin:'industry'};
const c={symbol:'sh600036',code:'600036',name:'招商银行',industry:'银行',origin:'universe'};
const date='2026-10-19';

test('same-day selection survives pool changes and reloads',()=>{
  const first=learning.chooseLearningCompany([a,b,c],learning.emptyLearningState(),date);
  assert.equal(first.symbol,a.symbol);
  const state=learning.setLearningDay(learning.emptyLearningState(),first);
  assert.deepEqual(learning.chooseLearningCompany([c],learning.readLearningState(JSON.stringify(state)),date),first);
});
test('selection deterministic, avoids completed companies and rotates industries',()=>{
  const empty=learning.emptyLearningState();
  assert.deepEqual(learning.chooseLearningCompany([a,b,c],empty,date),learning.chooseLearningCompany([c,b,a],empty,date));
  const state=learning.setLearningDay(learning.toggleLearned(empty,a,'2026-10-18'),{...a,date:'2026-10-18',skipped:[]});
  assert.equal(learning.chooseLearningCompany([a,b,c],state,date).symbol,c.symbol);
});
test('swap never revisits a skipped company and exhaustion preserves original state',()=>{
  let state=learning.emptyLearningState();const seen=[];
  for(let i=0;i<3;i++){
    const day=learning.chooseLearningCompany([a,b,c],state,date,i>0);
    assert.ok(day);assert.ok(!seen.includes(day.symbol));seen.push(day.symbol);state=learning.setLearningDay(state,day);
  }
  const before=JSON.stringify(state);
  assert.equal(learning.chooseLearningCompany([a,b,c],state,date,true),null);
  assert.equal(JSON.stringify(state),before);
});
test('mark/unmark preserves current selection and unrelated records',()=>{
  const initial=learning.setLearningDay(learning.toggleLearned(learning.emptyLearningState(),b,date),{...a,date,skipped:[]});
  const marked=learning.toggleLearned(initial,a,date);
  assert.equal(marked.completed.length,2);assert.deepEqual(marked.days,initial.days);
  assert.deepEqual(learning.toggleLearned(marked,a,date),initial);
});
test('invalid and duplicate records fail without replacing the input',()=>{
  assert.deepEqual(learning.readLearningState(null),learning.emptyLearningState());
  for(const input of ['{','null',JSON.stringify({version:1,days:[{...a,date:'2026-02-30',skipped:[]}],completed:[]}),JSON.stringify({version:1,days:[],completed:[{...a,date},{...a,date}]})]){
    assert.throws(()=>learning.readLearningState(input));
  }
  assert.throws(()=>learning.chooseLearningCompany([],learning.emptyLearningState(),'2026-02-30'));
});
test('learning data joins account sync and remains account-scoped',()=>{
  assert.equal(storage.isCloudKey(learning.COMPANY_LEARNING_KEY),true);
  assert.notEqual(storage.storageKey(learning.COMPANY_LEARNING_KEY,'one'),storage.storageKey(learning.COMPANY_LEARNING_KEY,'two'));
  assert.notEqual(storage.storageKey(learning.COMPANY_LEARNING_KEY,null),storage.storageKey(learning.COMPANY_LEARNING_KEY,'one'));
});
test('annual financials reject interim, future, other-stock and foreign-currency rows',()=>{
  const base={SECURITY_CODE:'600519',CURRENCY:'CNY',REPORT_DATE:'2025-12-31',NOTICE_DATE:'2026-03-30',UPDATE_DATE:'2026-03-30',OPERATE_INCOME_PK:100,PARENTNETPROFIT:0};
  const rows=[base,{...base,REPORT_DATE:'2026-06-30'},{...base,SECURITY_CODE:'000858'},{...base,CURRENCY:'HKD'},{...base,REPORT_DATE:'2026-12-31',NOTICE_DATE:'2027-03-30'},{...base,NOTICE_DATE:'2026-11-01'},{...base,UPDATE_DATE:'2026-11-01'}];
  const result=learning.parseLearningAnnual(rows,'600519',date);
  assert.equal(result.length,1);assert.equal(result[0].revenue,100);assert.equal(result[0].profit,0);assert.equal(result[0].roe,null);
});
test('restatements use latest rows, retain missing values, and limit to five actual years',()=>{
  const rows=Array.from({length:8},(_,i)=>({SECURITY_CODE:'600519',CURRENCY:'CNY',REPORT_DATE:`${2025-i}-12-31`,NOTICE_DATE:`${2026-i}-03-30`,OPERATE_INCOME_PK:100-i}));
  rows.push({...rows[0],UPDATE_DATE:'2026-05-01',OPERATE_INCOME_PK:null});
  const result=learning.parseLearningAnnual(rows,'600519',date);
  assert.equal(result.length,5);assert.equal(result[0].revenue,null);assert.equal(result.at(-1).period,'2021-12-31');
  for(const value of [null,undefined,'',false,'bad',Infinity])assert.equal(learning.learningNumber(value),null);
  assert.equal(learning.learningNumber('0'),0);
});
test('business mix keeps a single latest report and dimension',()=>{
  const row={REPORT_DATE:'2026-06-30',MAINOP_TYPE:2,ITEM_NAME:'产品甲',MAIN_BUSINESS_INCOME:30,MBI_RATIO:0.6};
  const result=parseBusinessComposition([row,{...row,ITEM_NAME:'产品乙',MAIN_BUSINESS_INCOME:20,MBI_RATIO:0.4},{...row,MAINOP_TYPE:1,ITEM_NAME:'重复行业'},{...row,REPORT_DATE:'2025-12-31',ITEM_NAME:'过期产品'}]);
  assert.equal(result.dimension,'产品');assert.equal(result.reportDate,'2026-06-30');
  assert.deepEqual(result.segments.map(s=>s.name),['产品甲','产品乙']);assert.equal(result.segments[0].incomeRatio,0.6);
  assert.equal(parseBusinessComposition(null).segments.length,0);
});
test('AI summary requires all six sections and known evidence citations',()=>{
  const sections=learning.LEARNING_SECTIONS.map(id=>({id,text:'待核实的归纳',sources:['business']}));
  assert.deepEqual(learning.parseLearningAi('```json\n'+JSON.stringify({sections})+'\n```',['business']),sections);
  assert.throws(()=>learning.parseLearningAi(JSON.stringify({sections:sections.slice(1)}),['business']));
  assert.throws(()=>learning.parseLearningAi(JSON.stringify({sections}),['finance']));
  assert.throws(()=>learning.parseLearningAi(JSON.stringify({sections:sections.map(s=>({...s,sources:[]}))}),['business']));
});
