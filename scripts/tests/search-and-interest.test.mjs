import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from './load-modules.mjs';
const {parseSearchRows}=await load('datasource/eastmoney');
const {normalizeCode,normalizeStockCode}=await load('datasource/codes');
const {searchResultPath}=await load('searchRouting');
const {PRESET_FORMULAS,evalFormula}=await load('financeFormulas');
const {parseInterestExpenses,withInterestFields}=await load('datasource/interestExpenses');
const {fetchCustomFinancials}=await load('datasource/sinaStatements');

test('eastmoney market 0 resolves Shenzhen, Beijing and shared index codes separately',()=>{
 const samples=[['002714','牧原股份','0.002714','深A','AStock','sz002714','stock'],['000001','平安银行','0.000001','深A','AStock','sz000001','stock'],['300750','宁德时代','0.300750','深A','AStock','sz300750','stock'],['920185','贝特瑞','0.920185','京A','NEEQ','bj920185','stock'],['899050','北证50','0.899050','指数','34','bj899050','index'],['399300','沪深300','0.399300','指数','Index','sz399300','index'],['000001','上证指数','1.000001','指数','Index','sh000001','index'],['00700','腾讯控股','116.00700','港股','HK','hk00700','stock'],['159915','创业板ETF','0.159915','基金','Fund','sz159915','etf']];
 for(const [Code,Name,QuoteID,SecurityTypeName,Classify,symbol,kind] of samples){
  const hits=parseSearchRows([{Code,Name,QuoteID,SecurityTypeName,Classify,MktNum:QuoteID.split('.')[0]}]);
  assert.equal(hits.length,1,Name);assert.equal(hits[0].symbol,symbol,Name);assert.equal(hits[0].kind,kind,Name);
 }
 assert.deepEqual(parseSearchRows([{Code:'TCTZF',Name:'腾讯粉单',QuoteID:'153.TCTZF'}]),[]);
 assert.deepEqual(parseSearchRows([{Code:'017512',Name:'场外基金',QuoteID:'150.017512',Classify:'OTCFUND'}]),[]);
});

test('saved wrong market paths are corrected without changing stock/index identity',()=>{
 assert.equal(searchResultPath({code:'002714',market:'BJ',kind:'stock'}),'/stock/sz002714');
 assert.equal(searchResultPath({code:'02714',market:'SZ',kind:'stock'}),'/stock/hk02714');
 assert.equal(searchResultPath({code:'000001',market:'BJ',kind:'stock'}),'/stock/sz000001');
 assert.equal(searchResultPath({code:'000001',market:'SH',kind:'index'}),'/index/sh000001');
 assert.equal(searchResultPath({code:'920185',kind:'stock'}),'/stock/bj920185');
 assert.equal(normalizeCode('920185').market,'BJ');assert.equal(normalizeStockCode('200002').market,'SZ');
});

test('interest coverage uses actual interest expense rather than net finance expense',()=>{
 const f=PRESET_FORMULAS.find(f=>f.id==='p-interest-coverage');
 const values=evalFormula(f.expr,{'pl_利润总额':[100,100,100,100,-100],'pl_利息费用':[10,null,0,-1,10],'pl_财务费用':[-50,-50,-50,-50,-50]},5,f);
 assert.deepEqual(values,[11,null,null,null,-9]);
 assert.equal(f.nullAsZero,undefined);assert.ok(!f.expr.includes('pl_财务费用'));
 assert.ok(PRESET_FORMULAS.every(f=>!f.name.includes('自算')));
});

test('raw interest and profit use the same report and convert yuan to wan once',()=>{
 const rows=parseInterestExpenses([{REPORT_DATE:'2025-12-31 00:00:00',TOTAL_PROFIT:5407571550.51,FE_INTEREST_EXPENSE:79492675.78,FINANCE_EXPENSE:-10968698.64},{REPORT_DATE:'2025-09-30',TOTAL_PROFIT:1e6,FE_INTEREST_EXPENSE:null}]);
 assert.equal(rows.get('2025-12-31').get('pl_利息费用'),7949.267578);
 assert.equal(rows.get('2025-09-30').get('pl_利息费用'),null);
 const catalog=[{id:'profit',label:'利润表',unit:'万元',total:0,groups:[]}];
 assert.equal(withInterestFields(catalog)[0].total,2);assert.equal(withInterestFields(withInterestFields(catalog))[0].total,2);
});

test('interest expense fields flow through financial API data pipeline, not only the formula string',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async url=>{
  assert.ok(String(url).includes('RPT_F10_FINANCE_GINCOME'));
  return new Response(JSON.stringify({success:true,result:{pages:1,data:[{REPORT_DATE:'2025-12-31',TOTAL_PROFIT:1000000,FE_INTEREST_EXPENSE:100000}]}}),{status:200});
 };
 try{
  const data=await fetchCustomFinancials('600415',['pl_利润总额','pl_利息费用'],5,'小商品城');
  assert.deepEqual(data.periods,['2025-12-31']);assert.deepEqual(data.series['pl_利润总额'],[100]);assert.deepEqual(data.series['pl_利息费用'],[10]);
 }finally{globalThis.fetch=original;}
});
