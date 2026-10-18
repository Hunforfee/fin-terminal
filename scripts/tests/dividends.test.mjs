import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';
const {buildExpectedDividendYieldByDate: forecast}=await load('dividends');
const {parseDividendPlans,fetchDividendPlans}=await load('datasource/dividendPlans');
const {buildRealValuationSeries,summarizeReal,buildTimelineFromStatements}=await load('valuation');
const candle=(date,close=10)=>({date,close,open:close,high:close,low:close,volume:1});
const plan=(reportDate,announceDate,perShare,extra={})=>({reportDate,announceDate,perShare,exDate:null,scheduleKnownDate:null,special:false,cancelled:false,...extra});

test('a board proposal changes expected yield before ex-date, without looking ahead',()=>{
 const rows=[plan('2023-12-31','2024-04-01',.3),plan('2024-12-31','2025-04-01',.5,{exDate:'2025-06-18',scheduleKnownDate:'2025-06-10'})];
 const values=forecast(rows,[candle('2025-03-31'),candle('2025-04-01'),candle('2025-04-02'),candle('2025-06-19')]);
 assert.equal(values.get('2025-03-31'),3);assert.equal(values.get('2025-04-01'),3);assert.equal(values.get('2025-04-02'),5);assert.equal(values.get('2025-06-19'),5);
});

test('annual plus interim replaces old periods instead of adding two annual dividends',()=>{
 const rows=[plan('2023-12-31','2024-04-01',.3),plan('2024-06-30','2024-08-01',.2),plan('2024-12-31','2025-04-01',.4),plan('2025-06-30','2025-08-01',.25)];
 assert.equal(forecast(rows,[candle('2025-08-02')]).get('2025-08-02'),6.5);
});

test('moving an interim distribution from H1 to Q3 does not create a third annual payment',()=>{
 const rows=[plan('2024-06-30','2024-12-14',.21),plan('2024-12-31','2025-04-30',.733),plan('2025-09-30','2025-12-31',.21),plan('2025-12-31','2026-04-30',.79)];
 assert.equal(forecast(rows,[candle('2026-05-01')]).get('2026-05-01'),10);
});

test('zero distribution immediately replaces the previous annual amount; unknown is not zero',()=>{
 const base=[plan('2023-12-31','2024-04-01',.3)];
 assert.equal(forecast([...base,plan('2024-12-31','2025-04-01',0)],[candle('2025-04-02')]).get('2025-04-02'),0);
 assert.equal(forecast([...base,plan('2024-12-31','2025-04-01',null)],[candle('2025-04-02')]).get('2025-04-02'),null);
 assert.equal(forecast([],[candle('2025-04-02')]).get('2025-04-02'),null);
});

test('unannounced cancellation does not change the past; announced cancellation replaces same report',()=>{
 const rows=[plan('2024-12-31','2025-04-01',.5),plan('2024-12-31','2025-05-01',0,{cancelled:true})];
 const out=forecast(rows,[candle('2025-04-30'),candle('2025-05-01'),candle('2025-05-02')]);
 assert.equal(out.get('2025-04-30'),5);assert.equal(out.get('2025-05-01'),5);assert.equal(out.get('2025-05-02'),0);
});

test('stock split changes per-share forecast on the ex-date, preserving yield with the price',()=>{
 const rows=[plan('2024-12-31','2025-04-01',1)];
 const out=forecast(rows,[candle('2025-06-01',20),candle('2025-06-02',10)],[{exDate:'2025-06-02',perShare:0,perShareStock:1}]);
 assert.equal(out.get('2025-06-01'),5);assert.equal(out.get('2025-06-02'),5);
});

test('special dividends are not repeated after ex-date; expiry stops repeating stale regular plans',()=>{
 const special=plan('2024-12-31','2025-04-01',2,{special:true,exDate:'2025-06-02',scheduleKnownDate:'2025-05-20'});
 const out=forecast([special],[candle('2025-05-21'),candle('2025-06-02')]);
 assert.equal(out.get('2025-05-21'),20);assert.equal(out.get('2025-06-02'),0);
 assert.equal(forecast([plan('2023-12-31','2024-04-01',.5)],[candle('2025-08-01')]).get('2025-08-01'),0);
});

test('parser keeps per-ten units, zero/unknown and cancellation effective date distinct',()=>{
 const row={REPORT_DATE:'2024-12-31 00:00:00',PLAN_NOTICE_DATE:'2025-04-01 00:00:00',NOTICE_DATE:'2025-06-01 00:00:00',EX_DIVIDEND_DATE:'2025-06-18 00:00:00',PRETAX_BONUS_RMB:5,ASSIGN_PROGRESS:'实施分配'};
 assert.equal(parseDividendPlans([row])[0].perShare,.5);
 assert.equal(parseDividendPlans([{...row,PRETAX_BONUS_RMB:null,IMPL_PLAN_PROFILE:'不分配不转增'}])[0].perShare,0);
 assert.equal(parseDividendPlans([{...row,PRETAX_BONUS_RMB:null,ASSIGN_PROGRESS:'董事会预案'}])[0].perShare,null);
 assert.equal(parseDividendPlans([{...row,PRETAX_BONUS_RMB:null,IMPL_PLAN_PROFILE:'10送3转5'}])[0].perShare,0);
 assert.equal(parseDividendPlans([{...row,PRETAX_BONUS_RMB:null,ASSIGN_PROGRESS:'预披露',IMPL_PLAN_PROFILE:'金额不超过上半年净利润'}]).length,0);
 const cancelled=parseDividendPlans([{...row,ASSIGN_PROGRESS:'取消分配'}])[0];
 assert.equal(cancelled.announceDate,'2025-06-01');assert.equal(cancelled.perShare,0);
});

test('current, history and percentile use expected yield while static remains separately available',()=>{
 const timeline=buildTimelineFromStatements([{date:'2024-12-31',npParent:100e8,npTotal:null,sharesYi:10,equityParent:500e8,equityTotal:null}]);
 const days=Array.from({length:10},(_,i)=>candle(`2025-06-${String(i+1).padStart(2,'0')}`));
 const expected=new Map(days.map((c,i)=>[c.date,i+1]));
 const stat=new Map(days.map(c=>[c.date,3]));
 const adjusted=new Map(days.map(c=>[c.date,{...c,close:5}]));
 const history=buildRealValuationSeries(days,timeline,{dyByDate:expected,staticDyByDate:stat,adjustedByDate:adjusted});
 const out=summarizeReal(history,{pe:10,pb:1,price:10},{years:5});
 assert.equal(history.at(-1).dy,10);assert.equal(history.at(-1).dyStatic,3);
 assert.equal(out.dividendYield,10);assert.equal(out.staticDividendYield,3);assert.equal(out.stats.dy.percentile,90);
});

test('dividend source failure is rejected rather than disguised as no dividend',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async()=>new Response(JSON.stringify({success:false,result:null}),{status:200});
 try{await assert.rejects(fetchDividendPlans('600415'),/分红方案数据不可用/);}finally{globalThis.fetch=original;}
});
