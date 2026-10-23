import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {load} from './load-modules.mjs';
const {marketRecord}=await load('marketStore');
const {storedMarketInput,validateDatedRows}=await load('marketInputs');
const {acquireSourceSlot,upstreamGroup}=await load('sourceCoordination');
const {SourceCooldown}=await load('datasource/sourceCooldown');
const {runMarketMaintenance}=await load('marketMaintenance');
const {readStoredFinancialSummary}=await load('storedFinancialSummary');
const {fetchDividendPlans}=await load('datasource/dividendPlans');
const {clearCache}=await load('datasource/cache');
const plan=await load('marketHistoryPlan');
const {missingIndicatorReports}=await load('financialPageQuality');
const now=Date.parse('2026-10-23T09:00:00Z');
function memory(){const rows=new Map();return {rows,read:async k=>structuredClone(rows.get(k)??null),
 write:async(r,expected)=>{if((rows.get(r.key)?.digest??null)!==expected)return false;rows.set(r.key,structuredClone(r));return true;},
 remove:async(k,d)=>rows.get(k)?.digest===d&&rows.delete(k),incident:async()=>{},
 scan:async()=>({records:[...rows.values()],cursor:'',done:true})};}
function compile(file,require){const exported={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{
 compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,
 {exports:exported,require,Date,Error,Buffer,console,AbortController,setTimeout,clearTimeout,setInterval,clearInterval});return exported;}

test('indicator completeness checks each period column and accepts genuine zero',()=>{
 const dates=['2016-03-31','2016-06-30','2016-09-30','2016-12-31'];
 const entries=[['ROE',['0','--',null,'-1']]];
 for(const rows of [new Map(entries),{$marketMap:entries}])
  assert.deepEqual(missingIndicatorReports({dates,rows},dates),['2016-06-30','2016-09-30']);
 assert.deepEqual(missingIndicatorReports(null,dates),dates);
});

test('supplier Retry-After beyond thirty minutes survives both cooldown layers',async()=>{
 const breaker=new SourceCooldown(()=>now);
 breaker.observe('https://source.test/a',429,'7200');assert.equal(breaker.active('https://source.test/b').until,now+7200e3);
 const s=memory(),start=Date.now(),slot=await acquireSourceSlot(s,'https://push2his.eastmoney.com/a',undefined,0);
 slot.observe(429,'7200');await slot.release();
 assert.ok((await s.read('market-source-gate:v1:eastmoney')).payload.cooldownUntil>=start+7200e3);
 assert.equal(upstreamGroup('https://proxy.finance.qq.com/a'),upstreamGroup('https://ifzq.gtimg.cn/b'));
});

test('only a successful complete zero-count dividend response is accepted as empty',async()=>{
 const original=globalThis.fetch;
 try{
  clearCache();globalThis.fetch=async()=>Response.json({success:true,result:{pages:0,count:0,data:[]}});
  assert.deepEqual(await fetchDividendPlans('600415'),[]);
  for(const body of [{success:false,result:null},{success:true,result:null},{success:true,result:{pages:1,count:1,data:[]}}]){
   clearCache();globalThis.fetch=async()=>Response.json(body);
   await assert.rejects(fetchDividendPlans('600415'),/分红|分页/);
  }
 }finally{globalThis.fetch=original;clearCache();}
});

test('implemented dividend facts persist when proposal reconciliation fails, without claiming verification',async()=>{
 const s=memory();
 const api=compile('src/lib/valuationInputs.ts',name=>{
  if(name==='./marketInputs')return {validateDatedRows,cachedMarketInput:(key,kind,source,ttl,producer,validate,sourceOf)=>storedMarketInput(key,kind,source,ttl,producer,validate,s,Date.now(),sourceOf)};
  if(name==='./datasource/dividendPlans')return {fetchDividendPlans:async()=>{throw Error('proposal source unavailable');}};
  if(name==='./datasource/sinaBonus')return {fetchDividends:async()=>[{exDate:'2025-06-01',perShare:0.3,cashSource:'sina'}]};
  if(name==='./marketStore')return {getMarketStore:()=>s};
  throw Error(name);
 });
 const events=await api.getValuationDividends('600415');
 assert.equal(events[0].perShare,0.3);assert.equal(events[0].reconciliationPending,true);
 const saved=await s.read('implemented-dividends-v4:600415');
 assert.match(saved.source,/reconciliation-pending/);assert.equal(saved.payload[0].perShare,0.3);
});

test('maintenance preserves explicitly verified empty dividend records',async()=>{
 const s=memory();
 for(const [kind,key] of [['implemented-dividends','impl'],['announced-dividend-plans','plans']])
  await s.write(marketRecord(key,kind,'eastmoney:verified-empty:fixture',[],864e5,now),null);
 await s.write(marketRecord('unknown-empty','implemented-dividends','unverified',[],864e5,now),null);
 await runMarketMaintenance(s,now,500);
 assert.ok(await s.read('impl'));assert.ok(await s.read('plans'));assert.equal(await s.read('unknown-empty'),null);
});

test('a failed financial supplier does not prevent other independent inputs, or globally pause daily prices',async()=>{
 const calls=[],finished=[];
 const worker=compile('src/lib/marketUpdateWorker.ts',name=>{
  if(name==='./marketStore')return {getMarketStore:()=>({read:async()=>({payload:{status:'ready'},refreshAfter:'2099-01-01'})})};
  if(name==='./marketUpdateQueue')return {MarketUpdateQueue:class{async claim(){return {symbol:'sh600415',mode:'financial',phase:0,lease:'test'};}async renew(){return true;}async finish(...args){finished.push(args);return true;}}};
  if(name==='./marketHistoryPlan')return plan;
  if(name==='./marketHistoryCollection')return {coverageKey:s=>s};
  if(name==='./marketUpdateContext')return {withUpstreamBudget:(_budget,fn)=>fn()};
  if(name==='./upstreamBudget')return {UpstreamBudget:class{limited=false;rateLimited=true;}};
  if(name==='./datasource/codes')return {normalizeStockCode:()=>({symbol:'sh600415',code:'600415',market:'SH'})};
  if(name==='./datasource/valueScreen')return {getValueScreenMeta:()=>({periods:[]}),fetchValueScreenReports:async()=>{calls.push('financial');throw Error('HTTP 429');}};
  if(name==='./valuationInputs')return {getValuationPlans:async()=>{calls.push('plans');throw Error('unavailable');},getValuationDividends:async()=>{calls.push('dividends');return [];}};
  if(name==='./marketInputs')return {validateDatedRows:()=>{},cachedMarketInput:async()=>{calls.push('shares');return [];}};
  if(name==='./watchlistFinancialInputs')return {getWatchlistFinancialInputs:async()=>{calls.push('display');}};
  if(name==='./marketFillGaps')return {recordGapAfterFailure:async()=>{}};
  return {};
 });
 const result=await worker.runMarketUpdateTick();
 assert.equal(result.ok,false);assert.deepEqual(calls,['financial','plans','dividends','shares','display']);
 assert.equal(finished[0][3],false,'source-specific cooldown must not pause the global queue');
});

test('stored summary uses the same CNY statements, aligns periods, preserves losses and does not need network',async()=>{
 const s=memory(),put=async(key,payload)=>s.write(marketRecord(key,key.startsWith('source-sina-indicators:')?'source-sina-indicators':'source-sina-page','fixture',payload,864e5,now),null);
 const dates=['2025-06-30','2024-06-30'];
 await put('source-sina-page:v1:600415:profit:2025',{unit:'wan',dates,rows:[
  {kind:'field',name:'营业收入',vals:['20000','10000']},{kind:'field',name:'营业成本',vals:['12000','7000']},
  {kind:'field',name:'归属于母公司所有者的净利润',vals:['-2000','1000']}]});
 await put('source-sina-page:v1:600415:balance:2025',{unit:'万元',dates,rows:[
  {kind:'field',name:'资产总计',vals:['100000','80000']},{kind:'field',name:'负债合计',vals:['40000','30000']}]});
 await put('source-sina-indicators:v1:600415:2025',{dates,rows:{$marketMap:[['净资产收益率(%)',['-2','1']]]}});
 const original=globalThis.fetch;globalThis.fetch=()=>{throw Error('must not fetch');};
 try{
  const summary=await readStoredFinancialSummary(s,'600415',now);
  assert.deepEqual(summary.revenue,[1,2]);assert.deepEqual(summary.netProfit,[0.1,-0.2]);
  assert.deepEqual(summary.roe,[1,-2]);assert.deepEqual(summary.profitGrowth,[null,-300]);
  assert.deepEqual(summary.grossMargin,[30,40]);assert.equal(summary.debtRatio[1],40);
  assert.equal(summary.provenance,'fetched');assert.equal(summary.currency,'CNY');assert.match(summary.note,/非TTM/);
  assert.equal(await readStoredFinancialSummary(s,'000923',now),null);
 }finally{globalThis.fetch=original;}
});
