import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {load} from './load-modules.mjs';
const {PRESET_FORMULAS,evalFormula}=await load('financeFormulas');
const {buildFinancialSummary}=await load('analytics');
const {formatAiDataContext}=await load('aiDataContext');
const {calendarRangeStart,intervalVolumes}=await load('marketDataIntegrity');
const {numOrNull}=await load('datasource/codes');
const tencent=await load('datasource/tencent');
const hk=await load('datasource/hkFinance');

test('every built-in formula propagates missing fields instead of creating zero balances',()=>{
  for(const f of PRESET_FORMULAS){
    assert.notEqual(f.nullAsZero,true,f.id);
    assert.deepEqual(evalFormula(f.expr,{},1,f),[null],f.id);
  }
  const fcf=PRESET_FORMULAS.find(f=>f.id==='p-fcf');
  const expr=fcf.expr;
  assert.deepEqual(evalFormula(expr,{'cf_经营活动产生的现金流量净额':[100,100], 'cf_购建固定资产、无形资产和其他长期资产所支付的现金':[null,0]},2,fcf),[null,100]);
  const debt=PRESET_FORMULAS.find(f=>f.id==='p-debt-ratio');
  assert.deepEqual(evalFormula(debt.expr,{'bs_资产总计':[100,100], 'bs_负债合计':[null,0]},2,debt),[null,0]);
  assert.ok(PRESET_FORMULAS.filter(f=>/turnover/.test(f.id)).every(f=>f.name.includes('期末余额')));
});

test('static/forward PE differences cannot masquerade as disclosed earnings growth',()=>{
  const summary=buildFinancialSummary({code:'600519',price:100,pe:10,pb:1,peStatic:20,peForward:5,totalMarketCap:1000});
  assert.deepEqual(summary.profitGrowth,[null]);
  assert.equal(summary.provenance,'derived');
  assert.match(summary.note,/加权平均/);
});

test('AI context keeps HKD prices, unverified currency, stale and derived flags visible',()=>{
  const q={code:'00700',market:'HK',price:400,totalMarketCap:30000,pe:15,pb:3,ts:'2026-10-20',source:'test',stale:true};
  const f=buildFinancialSummary(q);
  const text=formatAiDataContext({market:'HK',quote:q,valuation:null,financial:f,profile:null});
  assert.match(text,/400港元/);assert.match(text,/30000亿港元/);
  assert.match(text,/历史快照，非实时/);assert.match(text,/非已披露财报/);
  assert.match(text,/净利同比 缺失/);assert.ok(!text.includes('平台核验过'));
  const missing=formatAiDataContext({market:'HK',quote:null,valuation:null,financial:{...f,provenance:'fetched',periods:['2026-06-30']},profile:null});
  assert.match(missing,/币种未注明/);
});

test('AI context preserves expected dividend basis and financial warnings',()=>{
  const text=formatAiDataContext({market:'SH',quote:null,financial:null,profile:null,valuation:{pe:10,pb:1,roe:10,dividendYield:5,dividendYieldMethod:'announced-forward',source:'test',basis:'real',warnings:['财报可能重述'],fin:{report:'2026-06-30'}}});
  assert.match(text,/不是确定的未来分红/);assert.match(text,/财报可能重述/);assert.match(text,/不等同于披露的加权平均ROE/);
});

test('empty and boolean quote values are missing, while valid zeros and losses remain distinct',()=>{
  for(const v of ['', '  ', null,undefined,true,false,NaN,Infinity])assert.equal(numOrNull(v),null);
  assert.equal(numOrNull('0'),0);assert.equal(numOrNull('-5'),-5);
  const f=Array(78).fill('');f[1]='公司';f[2]='600519';f[3]='10';
  assert.equal(tencent.parseQuoteLine('sz000001',f.join('~')),null);
});

test('calendar chart ranges clamp month ends and minute bars use interval volumes',()=>{
  assert.equal(calendarRangeStart(12,new Date('2024-02-29T04:00:00Z')),'2023-02-28');
  assert.equal(calendarRangeStart(6,new Date('2026-03-31T04:00:00Z')),'2025-09-30');
  assert.equal(calendarRangeStart(60,new Date('2026-10-20T04:00:00Z')),'2021-10-20');
  assert.deepEqual(intervalVolumes([{volume:10},{volume:30},{volume:30},{volume:5}]),[10,20,0,null]);
});

test('HK K lines never silently label raw prices as adjusted',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({data:{hk00700:{day:[['2026-10-20','100','101','102','99','123']]}}});
  try{
    await assert.rejects(tencent.fetchKLine('hk00700','day','qfq',10),/empty series/);
    const series=await tencent.fetchKLine('hk00700','day','none',10);
    assert.equal(series.adjust,'none');
    assert.equal(series.candles[0].volume,1.23, 'HK shares normalize to the same hundred-share unit as A shares');
  }finally{globalThis.fetch=original;}
});

test('HK disclosed metrics do not relabel gross margin or divide by attributable profit',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({result:{data:[{REPORT_DATE:'2026-06-30',REPORT_TYPE:'2026年中报',CURRENCY:'HKD',GROSS_PROFIT_RATIO:57,NETCASH_OPERATE:100,HOLDER_PROFIT:50,ROE_AVG:10}]}});
  try{
    const result=await hk.fetchHkFinancials('00700.HK','00700',2);
    assert.equal(result.series.mainMargin[0],null);
    assert.equal(result.series.ocfToProfit[0],null);
    assert.equal(result.currency,'CNY');
  }finally{globalThis.fetch=original;}
});

test('K-line API passes full multi-year counts and validates dates before fetching',async()=>{
  const source=fs.readFileSync('src/app/api/kline/route.ts','utf8');
  const route={},calls=[];
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:route,require(name){
    if(name==='@/lib/api')return {marketOk:async work=>({status:200,data:await work()}),ok:data=>({status:200,data}),fail:(error,status)=>({error,status}),sp:r=>new URL(r.url).searchParams};
    if(name==='@/lib/datasource')return {getKLine:async(...args)=>{calls.push(args);return {candles:[]};}};
    throw Error(name);
  }});
  const get=query=>route.GET({url:'http://localhost/api/kline?code=600519&'+query});
  assert.equal((await get('count=1870&start=2021-10-20')).status,200);
  assert.equal(calls[0][3],1870);assert.equal(calls[0][4],'2021-10-20');
  for(const q of ['count=-1','count=NaN','count=1.5','start=2026-02-30'])assert.equal((await get(q)).status,400);
  assert.equal(calls.length,1);
});

test('HK current book values ignore future report dates and impossible calendar dates',async()=>{
  const {parseHkFundamental}=await load('datasource/hkFundamental');
  const latest=parseHkFundamental([
    {REPORT_DATE:'2099-12-31',BPS:999},
    {REPORT_DATE:'2026-02-30',BPS:888},
    {REPORT_DATE:'2026-06-30',BPS:20},
  ]);
  assert.equal(latest.reportDate,'2026-06-30');
  const original=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({result:{data:[{REPORT_DATE:'2099-12-31',REPORT_TYPE:'2099年报'},{REPORT_DATE:'2026-06-30',REPORT_TYPE:'2026年中报'}]}});
  try{assert.deepEqual((await hk.fetchHkIndicatorPoints('00700.HK',2)).map(p=>p.date),['2026-06-30']);}
  finally{globalThis.fetch=original;}
});
