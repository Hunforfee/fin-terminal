import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { load } from './load-modules.mjs';
const codes=await load('datasource/codes');
const inputs=await load('watchlistFinancialInputs');
const status=await load('marketReadContext');
const statusValue=await load('marketReadStatus');
const fields=inputs.WATCHLIST_FINANCIAL_FIELDS;
const value=code=>({code,name:code,periods:['2025-12-31'],periodLabels:['2025年报'],series:Object.fromEntries(fields.map(f=>[f,[12]])),source:'test'});
function setup({old=null,readonly=false,remote=false,derived=false,failure=false}={}){
 const exports={},deferred=[];let live=old,raw=0,refresh=0,reads=0,forwarded;
 class Budget {constructor(_signal,_interval,_calls,readOnly){this.readOnly=readOnly;}}
 let budget;
 const fn=ts.transpileModule(fs.readFileSync('src/lib/watchlistFinancialDisplay.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInNewContext(fn,{exports,Date,Error,AbortController,require(name){
  if(name==='./datasource/codes')return codes;
  if(name==='./datasource/sinaStatements'||name==='./datasource/hkFinance')return {fetchCustomFinancials:async code=>{raw++;assert.equal(budget.readOnly,true);if(!derived)throw Error('missing');return value(code);},fetchHkCustomFinancials:async()=>{throw Error('missing');}};
  if(name==='./marketStore')return {getMarketReadStore:()=>({read:async()=>{reads++;return live;}}),getMarketStore:()=>({})};
  if(name==='./marketDataClient')return {remoteMarketDataEnabled:()=>remote,readRemoteMarketData:async(...args)=>{forwarded=args;return {companies:[],errors:[]};}};
  if(name==='./marketReadPolicy')return {databaseOnly:()=>readonly};
  if(name==='./marketReadContext')return status;
  if(name==='./marketReadStatus')return statusValue;
  if(name==='./marketUpdateContext')return {withUpstreamBudget:async(b,work)=>{const prior=budget;budget=b;try{return await work();}finally{budget=prior;}}};
  if(name==='./upstreamBudget')return {UpstreamBudget:Budget};
  if(name==='./watchlistFinancialInputs')return {...inputs,getWatchlistFinancialInputs:async symbol=>{refresh++;if(failure)throw Error('failed');live={payload:value(symbol.slice(2)),acquiredAt:'2026-10-24T00:00:00Z',source:'test',refreshAfter:new Date(Date.now()+100000).toISOString()};}};
  if(name==='./financialDisplayRefresh')return {scheduleFinancialRefresh:(key,defer,work)=>{defer(()=>work(new AbortController().signal));return {state:'pending',retryAfterMs:5000};}};
  throw Error(name);
 }});
 return {get:(list=['sh600519'])=>exports.getWatchlistFinancialDisplay(list,fn=>deferred.push(fn)),deferred,get refresh(){return refresh;},get reads(){return reads;},get raw(){return raw;},get forwarded(){return forwarded;}};
}
test('fresh persisted list returns immediately and never calls quotes, raw providers or refresh',async()=>{
 const s=setup({old:{payload:value('600519'),refreshAfter:new Date(Date.now()+100000).toISOString()}});
 const r=await s.get();assert.equal(r.companies[0].series.roe[0],12);assert.equal(s.raw,0);assert.equal(s.refresh,0);assert.equal(s.deferred.length,0);
});
test('expired values retain acquisition date and display before the deferred update starts',async()=>{
 const acquiredAt='2025-12-31T00:00:00Z';
 const s=setup({old:{payload:value('600519'),refreshAfter:acquiredAt,acquiredAt,source:'original'}});
 const r=await s.get();assert.equal(r.companies[0].refresh.state,'pending');assert.equal(s.refresh,0);
 assert.equal(r.companies[0].dataStatus.snapshots[0].acquiredAt,acquiredAt);
 await s.deferred[0]();assert.equal(s.refresh,1);
 assert.equal((await s.get()).companies[0].refresh,undefined);
});
test('cold response marks pending, keeps missing values empty, then returns persisted completion',async()=>{
 const s=setup(),r=await s.get();assert.equal(r.companies[0].periods.length,0);assert.equal(r.errors.length,0);assert.equal(s.refresh,0);
 await s.deferred[0]();assert.equal((await s.get()).companies[0].series.roe[0],12);
});
test('imported source pages can display without HTTP; diagnostic read-only mode never schedules writes',async()=>{
 const s=setup({derived:true,readonly:true}),r=await s.get();assert.equal(r.companies[0].periods.length,1);assert.equal(s.deferred.length,0);assert.equal(s.refresh,0);
 const missing=setup({readonly:true}),m=await missing.get();assert.equal(m.errors.length,1);assert.equal(missing.deferred.length,0);
});
test('remote consumers forward the same watchlist shape without touching local stores',async()=>{
 const s=setup({remote:true});await s.get(['hk00700']);assert.equal(s.reads,0);assert.equal(s.raw,0);assert.equal(s.forwarded[0],'finance-compare');assert.equal(s.forwarded[2].codes[0],'hk00700');
});
