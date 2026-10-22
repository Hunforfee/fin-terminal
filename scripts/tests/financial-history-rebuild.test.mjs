import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {load} from './load-modules.mjs';
const {rebuildFinancialHistoryInput:getFinancialHistoryInput}=await load('financialHistoryInputs');
const {marketRecord}=await load('marketStore');
const {storedMarketInput}=await load('marketInputs');
const {requiredFinancialReports}=await load('marketHistoryPlan');
const v=await load('valuation');
const plan=await load('marketHistoryPlan');
const now=Date.parse('2026-10-23T02:00:00Z');
function memory(){const rows=new Map();return {rows,read:async k=>structuredClone(rows.get(k)??null),
 readInputs:async keys=>keys.map(k=>rows.get(k)).filter(Boolean).map(r=>structuredClone(r)),
 write:async(r,expected)=>{if((rows.get(r.key)?.digest??null)!==expected)return false;rows.set(r.key,structuredClone(r));return true;},incident:async()=>{}};}
async function save(s,key,kind,payload,at=now){const old=await s.read(key);await s.write(marketRecord(key,kind,'fixture',payload,7*864e5,at),old?.digest??null);}
const page=(dates,name,vals)=>({dates,unit:'万元',rows:[{kind:'field',name,vals:vals.map(String)}]});
const point=(date,npParent,equityParent=100e8)=>({date,npParent,npTotal:null,equityParent,equityTotal:null,sharesYi:null});
const candle=date=>({date,open:10,high:10,low:10,close:10,volume:1});

test('database-only rebuild adds a quarter from new pages even while the imported summary is fresh',async()=>{
 const s=memory(),key='statements-v3:600415:11';
 await save(s,key,'financial-history',[point('2015-12-31',10e8),point('2016-12-31',12e8)],now-1000);
 await save(s,'source-sina-page:v1:600415:profit:2016','source-sina-page',page(['2016-09-30'],'归属于母公司所有者的净利润',[90000]));
 await save(s,'source-sina-page:v1:600415:balance:2016','source-sina-page',page(['2016-09-30'],'归属于母公司股东权益合计',[1000000]));
 const originalFetch=globalThis.fetch,env=process.env.MARKET_READ_MODE;
 globalThis.fetch=()=>{throw Error('unexpected network');};process.env.MARKET_READ_MODE='database';
 try{
  const rows=await getFinancialHistoryInput('600415',11,s,now);
  assert.equal(rows.find(p=>p.date==='2016-09-30').npParent,9e8);
  assert.equal(rows.find(p=>p.date==='2015-12-31').npParent,10e8);
  assert.equal(rows.find(p=>p.date==='2016-09-30').sharesYi,null);
  const digest=(await s.read(key)).digest;
  await getFinancialHistoryInput('600415',11,s,now+1);assert.equal((await s.read(key)).digest,digest);
  await save(s,'source-sina-page:v1:600415:profit:2016','source-sina-page',page(['2016-09-30','2016-06-30'],'归属于母公司所有者的净利润',[90000,60000]),now+2);
  const updated=await getFinancialHistoryInput('600415',11,s,now+3);
  assert.equal(updated.find(p=>p.date==='2016-06-30').npParent,6e8);
  assert.notEqual((await s.read(key)).digest,digest);
  assert.ok(Date.parse((await s.read(key)).refreshAfter)>now+3);
  // A source can be stored during another derived build. Its content revision,
  // rather than the newer summary's timestamp, must determine invalidation.
  await save(s,'source-sina-page:v1:600415:profit:2016','source-sina-page',page(['2016-09-30','2016-06-30'],'归属于母公司所有者的净利润',[95000,60000]),now+1);
  assert.equal((await getFinancialHistoryInput('600415',11,s,now+4)).find(p=>p.date==='2016-09-30').npParent,9.5e8);
 }finally{globalThis.fetch=originalFetch;if(env===undefined)delete process.env.MARKET_READ_MODE;else process.env.MARKET_READ_MODE=env;}
});

test('rebuild preserves more precise imported amounts when the raw page is older and renews expired derived metadata',async()=>{
 const s=memory(),key='statements-v3:600415:11';
 await save(s,'source-sina-page:v1:600415:profit:2015','source-sina-page',page(['2015-12-31'],'归属于母公司所有者的净利润',[10000]),now-2000);
 await save(s,key,'financial-history',[point('2015-12-31',100000001.23)],now-1000);
 assert.equal((await getFinancialHistoryInput('600415',11,s,now))[0].npParent,100000001.23);
 await getFinancialHistoryInput('600415',11,s,now+1800e3+1);
 assert.ok(Date.parse((await s.read(key)).refreshAfter)>now+1800e3+1);
});

test('a rejected derived write is a failure, not apparent completion',async()=>{
 const s=memory();await save(s,'statements-v3:600415:11','financial-history',[point('2025-12-31',1e8)]);
 s.write=async()=>false;
 await assert.rejects(getFinancialHistoryInput('600415',11,s,now),/写入冲突/);
});

test('trading-day shares price a disclosed report without retroactively assigning a future baseline to it',()=>{
 const points=[point('2015-09-30',3e8),point('2015-12-31',10e8),point('2016-09-30',8e8)];
 const timeline=v.buildDisclosureTimeline(points,{reportDates:new Map([['2015-09-30','2015-10-20'],['2015-12-31','2016-03-30'],['2016-09-30','2016-10-18']])});
 assert.equal(timeline.at(-1).shares,null);assert.equal(timeline.at(-1).npTTM,15);
 const history=v.buildRealValuationSeries([candle('2016-10-21'),candle('2016-10-24'),candle('2016-10-25')],timeline,
  {shareHistory:[{date:'2016-10-23',baseline:true,sharesWan:500000},{date:'2016-10-25',sharesWan:1000000}]});
 assert.equal(history[0].pe,null);assert.ok(history[0].missingInputs.includes('shares'));
 assert.equal(history[1].pe,33.33);assert.equal(history[1].pb,5);assert.equal(history[1].missingInputs,undefined);
 assert.equal(history[2].pe,66.67);assert.equal(history[2].pb,10);
});

test('known losses do not masquerade as missing inputs, and missing disclosures still suppress the amount path',()=>{
 const shares=[{date:'2025-01-01',sharesWan:100000}];
 const known=v.buildDisclosureTimeline([point('2024-12-31',-10e8)],{reportDates:new Map([['2024-12-31','2025-04-01']])});
 const loss=v.buildRealValuationSeries([candle('2025-05-06')],known,{shareHistory:shares})[0];
 assert.equal(loss.pe,null);assert.equal(loss.missingInputs,undefined);assert.equal(loss.pb,1);
 const unknown=v.buildDisclosureTimeline([point('2024-12-31',10e8)]);
 const missing=v.buildRealValuationSeries([candle('2025-05-06')],unknown,{shareHistory:shares})[0];
 assert.equal(missing.pe,null);assert.equal(missing.pb,null);assert.ok(missing.missingInputs.includes('equity'));
});

test('a partial but fresh annual page can be refreshed, while database-only reads never trigger a forced network request',async()=>{
 const s=memory(),key='source-sina-page:v1:600415:profit:2016';
 await save(s,key,'source-sina-page',page(['2016-12-31'],'营业收入',[100]));
 let calls=0;
 const producer=async()=>{calls++;return page(['2016-12-31','2016-09-30'],'营业收入',[100,80]);};
 const value=await storedMarketInput(key,'source-sina-page','fixture',1000,producer,()=>{},s,now,undefined,{forceRefresh:true});
 assert.equal(calls,1);assert.equal(value.dates.length,2);
 const env=process.env.MARKET_READ_MODE;process.env.MARKET_READ_MODE='database';
 try{await storedMarketInput(key,'source-sina-page','fixture',1000,producer,()=>{},s,now+1,undefined,{forceRefresh:true});assert.equal(calls,1);}
 finally{if(env===undefined)delete process.env.MARKET_READ_MODE;else process.env.MARKET_READ_MODE=env;}
});

test('required quarterly reports respect publication deadlines and verified listing dates',()=>{
 assert.deepEqual(requiredFinancialReports(2016,'2002-05-09',now),['2016-03-31','2016-06-30','2016-09-30','2016-12-31']);
 assert.deepEqual(requiredFinancialReports(2026,'2002-05-09',now),['2026-03-31','2026-06-30']);
 assert.deepEqual(requiredFinancialReports(2016,'2016-08-01',now),['2016-09-30','2016-12-31']);
 assert.deepEqual(requiredFinancialReports(2025,undefined,Date.parse('2026-03-01T00:00:00Z')),['2025-03-31','2025-06-30','2025-09-30']);
});

test('annual collection refreshes a cached partial year before accepting it as complete',async()=>{
 const exported={},calls=[],all=['2016-12-31','2016-09-30','2016-06-30','2016-03-31'];
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/marketHistoryCollection.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  exports:exported,Error,Date,AbortController,
  require(name){
   if(name==='./marketHistoryPlan')return plan;
   if(name==='./marketStore')return {getMarketStore:()=>({read:async key=>key.startsWith('security-basics:')?{payload:{listingDate:'2002-05-09'}}:key.startsWith('kline:')?null:{refreshAfter:'2099-01-01',payload:{dates:all}}})};
   if(name==='./datasource/codes')return {normalizeStockCode:()=>({market:'SH',code:'600415',symbol:'sh600415'})};
   if(name==='./marketSecurityBasics')return {securityBasicsKey:s=>'security-basics:v1:'+s};
   if(name==='./marketImportedBars')return {importedBarsKey:s=>'kline:'+s};
   if(name==='./datasource/sinaStatements')return {fetchStatementSourcePage:async(code,id,year,options)=>{calls.push({id,year,refresh:!!options?.forceRefresh});return {dates:options?.forceRefresh?all:['2016-12-31']};}};
   if(name==='./datasource/sinaFinancial')return {fetchIndicatorSourceYear:async()=>({dates:all})};
   return {};
  },
 });
 await exported.collectHistoryPhase('sh600415',17,new AbortController().signal);
 assert.deepEqual(calls.map(c=>[c.id,c.year,c.refresh]),[['balance',2016,false],['balance',2016,true],['profit',2016,false],['profit',2016,true],['cashflow',2016,false],['cashflow',2016,true]]);
});
