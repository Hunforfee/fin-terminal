import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from './load-modules.mjs';
const {fetchKLine}=await load('datasource/eastmoneyKline');
const {fetchDisclosureDates}=await load('datasource/disclosures');
const {MarketUpdateQueue}=await load('marketUpdateQueue');
const {getSecurityBasics}=await load('marketSecurityBasics');
const {marketRecord}=await load('marketStore');
const memory=()=>{const rows=new Map();return {rows,read:async k=>structuredClone(rows.get(k)??null),write:async(r,e)=>{if((rows.get(r.key)?.digest??null)!==e)return false;rows.set(r.key,structuredClone(r));return true;},incident:async()=>{}};};

test('independent price fallback preserves raw/qfq requests and validates source identity',async()=>{
 const original=fetch;let wrong=false;
 globalThis.fetch=async url=>{const u=new URL(url);assert.equal(u.searchParams.get('fqt'),'1');assert.equal(u.searchParams.get('secid'),'1.600415');
  return Response.json({rc:0,data:{code:wrong?'600519':'600415',market:1,klines:['2026-10-20,10,11,12,9']}});};
 try{const r=await fetchKLine('sh600415','day','qfq',1500,'2021-10-21');assert.equal(r.source,'eastmoney');assert.equal(r.adjust,'qfq');assert.equal(r.candles[0].close,11);
  wrong=true;await assert.rejects(fetchKLine('sh600415','day','qfq',1500),/证券/);
 }finally{globalThis.fetch=original;}
});

test('planned future disclosures cannot poison valid previously published dates',async()=>{
 const original=fetch;const future=new Date(Date.now()+2*864e5+8*3600e3).toISOString().slice(0,10);
 globalThis.fetch=async url=>String(url).includes('datacenter-web')?Response.json({result:{pages:1,data:[
  {REPORTDATE:'2025-12-31',NOTICE_DATE:'2026-04-20'},
  {REPORTDATE:'2026-09-30',NOTICE_DATE:future},
  {REPORTDATE:'2024-12-31',NOTICE_DATE:'2025-02-30'}]}}):new Response('');
 try{const r=await fetchDisclosureDates('600415',2020);assert.equal(r.get('2025-12-31'),'2026-04-20');assert.equal(r.has('2026-09-30'),false);assert.equal(r.has('2024-12-31'),false);
 }finally{globalThis.fetch=original;}
});

test('website listing facts validate the source security without QMT files',async()=>{
 const original=fetch;globalThis.fetch=async()=>Response.json({fxxg:[{SECUCODE:'603448.SH',SECURITY_CODE:'603448',LISTING_DATE:'2026-09-07 00:00:00'}]});
 try{const r=await getSecurityBasics('sh603448');assert.equal(r.listingDate,'2026-09-07');assert.equal(r.symbol,'sh603448');}finally{globalThis.fetch=original;}
});

test('cold recent jobs pin initialization and failed-stage retry resumes its earliest missing input',async()=>{
 const store=memory();let clock=Date.now();const queue=new MarketUpdateQueue(store,()=>clock);
 await queue.submit('one',['600415'],false,'recent');let t=await queue.claim();assert.equal(t.initialize,true);
 await queue.finish(t.symbol,t.lease,'blocked price mirror',false,1);
 clock+=1100;t=await queue.claim();assert.equal(t.phase,1);assert.equal(t.initialize,true);
 await queue.finish(t.symbol,t.lease,undefined,false,13);
 for(let i=0;i<3;i++){clock+=300000;t=await queue.claim();await queue.finish(t.symbol,t.lease,'missing price input');}
 assert.equal((await queue.status('one')).failed,1);clock+=61000;
 await queue.submit('one',['600415'],true,'recent');t=await queue.claim();assert.equal(t.phase,0);assert.equal(t.initialize,true);
 await queue.finish(t.symbol,t.lease,undefined,false,1);
 const key='market-coverage:v1:sh600415:10';await store.write(marketRecord(key,'market-coverage','test',{status:'ready'},60000),null);
 clock+=1100;t=await queue.claim();assert.equal(t.initialize,true,'mid-job coverage changes cannot change phase numbering');
});
