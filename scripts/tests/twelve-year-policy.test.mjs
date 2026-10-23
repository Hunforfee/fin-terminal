import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from './load-modules.mjs';
const plan=await load('marketHistoryPlan');
const {marketRecord}=await load('marketStore');
const {MarketUpdateQueue}=await load('marketUpdateQueue');
const {storedKLine}=await load('klineStorage');
const {storedMarketInput}=await load('marketInputs');
const {importBatchSymbol}=await load('marketBatchImport');
const now=Date.parse('2026-10-23T10:00:00Z');
function memory(){const rows=new Map();const s={coordinated:true,read:async k=>structuredClone(rows.get(k)??null),readInputs:async keys=>keys.map(k=>structuredClone(rows.get(k))).filter(Boolean),async write(r,d){if((rows.get(r.key)?.digest??null)!==d)return false;rows.set(r.key,structuredClone(r));return true;},async writeInputs(items){let n=0;for(const it of items)if(await s.write(it.record,it.expected))n++;return n;},incident:async()=>{},rows};return s;}
test('twelve-year full plan covers every required TTM year without moving daily, financial, or readiness IDs',()=>{
 assert.equal(plan.HISTORY_YEARS,12);assert.equal(plan.historyStart(now),'2014-10-23');
 assert.equal(plan.financialEarliestYear(now),2013);
 assert.deepEqual(plan.FULL_HISTORY_PHASES.map(p=>plan.financialYearForPhase(p,now)).filter(y=>y!==null),Array.from({length:14},(_,i)=>2026-i));
 assert.deepEqual(plan.collectionPhases('daily',false),[19]);assert.deepEqual(plan.collectionPhases('financial',false),[20]);
 assert.equal(plan.FULL_HISTORY_PHASES.at(-1),12);assert.equal(plan.coverageKey('sh600415'),'market-coverage:v1:sh600415:12');
});
test('old running ten-year fills lose their lease and restart once; daily tasks keep their own phase',async()=>{
 const s=memory();await s.write(marketRecord('market-update-queue:v1','market-update-queue','internal',{
 jobs:[{id:'old',owner:'user',symbols:['sh600415'],skipped:[],createdAt:now,mode:'ten-year'}],
 items:{sh600415:{symbol:'sh600415',mode:'ten-year',state:'running',phase:18,attempts:1,nextAt:now,lease:'old-lease',leaseUntil:now+1e8}},workerAt:now,pauseUntil:0},60000,now),null);
 const q=new MarketUpdateQueue(s,()=>now),task=await q.claim();assert.equal(task.phase,0);assert.notEqual(task.lease,'old-lease');
 assert.equal(await q.finish(task.symbol,'old-lease'),false);await q.status('user');
 assert.equal(s.rows.get('market-update-queue:v1').payload.items.sh600415.lease,task.lease,'current plan lease must not be reset on each read');
 assert.equal(s.rows.get('market-update-queue:v1').payload.items.sh600415.historyYears,12);
});
test('network K-line persistence retains newly allowed years instead of applying the obsolete ten-year crop',async()=>{
 const s=memory(),request={symbol:'sh600415',period:'day',adjust:'none',count:3200,start:'2014-10-23'};
 const candles=['2014-10-23','2015-10-23','2016-10-23','2026-10-22'].map(date=>({date,open:10,high:12,low:9,close:11}));
 const result=await storedKLine(request,async()=>({symbol:'sh600415',code:'600415',period:'day',adjust:'none',source:'tencent',stale:false,complete:true,candles}),s,now);
 assert.deepEqual(result.candles.map(c=>c.date),candles.map(c=>c.date));
 assert.equal(s.rows.get('kline:v2:sh600415:day:none:tencent:prices-only').payload.candles[0].date,'2014-10-23');
});
test('narrower inputs reuse the actual fourteen-year record without refetching or changing acquisition time',async()=>{
 const s=memory(),key='disclosures-v3:600415:14',payload={$marketMap:[['2013-12-31','2014-04-01']]};
 const row=marketRecord(key,'disclosure-dates','verified',payload,1e9,now);await s.write(row,null);
 const out=await storedMarketInput('disclosures-v3:600415:13','disclosure-dates','verified',60000,async()=>{throw Error('must reuse wider input');},()=>{},s,now);
 assert.equal(out.get('2013-12-31'),'2014-04-01');assert.equal(s.rows.get(key).acquiredAt,row.acquiredAt);assert.equal(s.rows.has('disclosures-v3:600415:13'),false);
});
test('atomic batch staging and actual disclosure writer agree on the new default fourteen-year key',async()=>{
 const s=memory(),proof={source:'manual',reference:'verified original disclosure evidence',files:[{name:'evidence.json',sha256:'a'.repeat(64)}]};
 const result=await importBatchSymbol(s,[{type:'disclosure-dates',record:{symbol:'600415',items:[{date:'2013-12-31',published:'2014-04-01',basis:'issuer original annual report'}]}}],'sh600415',proof,'twelve-test',now);
 assert.equal(result.verified,true);assert.ok(s.rows.has('disclosures-v3:600415:14'));assert.equal(s.rows.has('disclosures-v3:600415:12'),false);
});

test('buffered Hong Kong original statements preserve the prior-year evidence needed at the new window edge',async()=>{
 const {retainMarketPayload}=await load('marketRetention');
 const rows=[{date:'2013-12-31',amount:10},{date:'2014-06-30',amount:20}];
 assert.deepEqual(retainMarketPayload('source-hk-statement',rows,now),rows);
 assert.deepEqual(retainMarketPayload('source-hk-indicators',rows,now),rows);
});

test('twelve-year HK valuation keeps the vendor ten-year preset and the requested display duration separate',async()=>{
 const exported={},spans=[];
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/datasource/hkFinance.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  exports:exported,Date,Map,Set,Intl,URL,URLSearchParams,
  require(name){
   if(name==='../marketHistoryPlan')return plan;
   if(name==='./http')return {fetchJson:async()=>({result:{data:[{REPORT_DATE:'2025-12-31',STD_REPORT_DATE:'2025-12-31',REPORT_TYPE:'年报',CURRENCY:'港元',ROE_YEARLY:10}]}})};
   if(name==='../marketInputs')return {cachedMarketInput:(_key,_kind,_source,_ttl,produce)=>produce(),validateDatedRows:()=>{}};
   if(name==='./hkFundamental')return {parseHkFundamental:()=>null};
   if(name==='./hkValuationHistory')return {fetchHkRatioHistory:async(_symbol,_metric,years)=>{assert.ok([5,10].includes(years));spans.push(years);return null;},attachHkValuationHistory:value=>value};
   return {};
  },
 });
 const value=await exported.buildHkValuation('00700.HK','00700',[],{price:400,pe:20},12,{pe:20,pb:3,dividendYield:1});
 assert.deepEqual(spans,[10,10]);assert.equal(value.years,12);
});
