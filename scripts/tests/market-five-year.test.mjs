import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from './load-modules.mjs';
const {marketRecord}=await load('marketStore');
const {storedMarketInput}=await load('marketInputs');
const {storedKLine,aggregateDaily}=await load('klineStorage');
const {importDailyPrices,importedBarsKey,extendImportedPrices}=await load('marketImportedBars');
const {registerCollection,scheduleMarketClose,closeTarget}=await load('marketCollection');
const {MarketUpdateQueue}=await load('marketUpdateQueue');
const {withUpstreamBudget}=await load('marketUpdateContext');
const {UpstreamBudget}=await load('upstreamBudget');
const {fetchText}=await load('datasource/http');
const memory=()=>{const rows=new Map();return {rows,read:async k=>structuredClone(rows.get(k)??null),write:async(r,expected)=>{if((rows.get(r.key)?.digest??null)!==expected)return false;rows.set(r.key,structuredClone(r));return true;},incident:async()=>{}};};
const candles=dates=>dates.map(date=>({date,open:10,high:11,low:9,close:10.5}));
const series=(dates,adjust='none')=>({symbol:'sh600519',code:'600519',period:'day',adjust,source:'tencent',stale:false,complete:true,candles:candles(dates)});
const now=Date.parse('2026-10-21T12:00:00Z');

test('database mode reuses expired financial inputs but never fills a miss from upstream',async()=>{
 const previous=process.env.MARKET_READ_MODE;process.env.MARKET_READ_MODE='database';
 const store=memory();let calls=0;
 try{
  await store.write(marketRecord('known','financial-history','qmt',[{date:'2026-06-30',npParent:10}],-1,now),null);
  const producer=async()=>{calls++;return 99;};
  assert.equal((await storedMarketInput('known','financial-history','source',1,producer,()=>{},store,now))[0].npParent,10);
  await assert.rejects(storedMarketInput('missing','kind','source',1,producer,()=>{},store,now),/尚未入库/);
  assert.equal(calls,0);
 }finally{if(previous===undefined)delete process.env.MARKET_READ_MODE;else process.env.MARKET_READ_MODE=previous;}
});

test('database-only requests cannot join a collector network promise',async()=>{
 const previous=process.env.MARKET_READ_MODE;process.env.MARKET_READ_MODE='database';
 const store=memory();let release;const gate=new Promise(r=>release=r);
 try{
  const collecting=withUpstreamBudget(new UpstreamBudget(new AbortController().signal,1),()=>storedMarketInput('busy','kind','source',1000,async()=>{await gate;return 1;},()=>{},store));
  await new Promise(r=>setImmediate(r));
  await assert.rejects(storedMarketInput('busy','kind','source',1000,async()=>2,()=>{},store),/尚未入库/);
  release();assert.equal(await collecting,1);
 }finally{release?.();if(previous===undefined)delete process.env.MARKET_READ_MODE;else process.env.MARKET_READ_MODE=previous;}
});

test('database policy permits live quotes and search, and refuses historic HTTP calls before fetch',async()=>{
 const old=process.env.MARKET_READ_MODE,original=globalThis.fetch;process.env.MARKET_READ_MODE='database';let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response('ok');};
 try{
  await assert.rejects(fetchText('https://money.finance.sina.com.cn/report',{retries:0}),/尚未入库/);
  await fetchText('https://qt.gtimg.cn/q=sh600519',{retries:0});
  await fetchText('https://smartbox.gtimg.cn/s3/?q=600519',{retries:0});
  assert.equal(calls,2);
 }finally{globalThis.fetch=original;if(old===undefined)delete process.env.MARKET_READ_MODE;else process.env.MARKET_READ_MODE=old;}
});

test('imported raw bars extend only after a matching source overlap; conflicts preserve the database',async()=>{
 const store=memory(),dates=['2026-10-14','2026-10-15','2026-10-16','2026-10-19'];
 await importDailyPrices(store,{symbol:'600519',source:'qmt',candles:candles(dates)},now);
 const key=importedBarsKey('sh600519'),row=await store.read(key);
 const tail=series([...dates.slice(1),'2026-10-20']);
 const combined=await extendImportedPrices(store,row,tail,now+1);
 assert.equal(combined.candles.length,5);assert.equal(combined.origins.length,2);
 assert.equal(combined.origins[0].source,'qmt');assert.equal(combined.origins[1].source,'tencent');
 const stable=await store.read(key),conflict=series([...dates.slice(1),'2026-10-20']);conflict.candles[0].close=10.8;
 await assert.rejects(extendImportedPrices(store,stable,conflict,now+2),/不一致/);
 assert.equal((await store.read(key)).digest,stable.digest);
 await assert.rejects(extendImportedPrices(store,stable,series(['2026-10-20']),now+2),/重叠/);
 await assert.rejects(extendImportedPrices(store,stable,series(dates,'qfq'),now+2),/口径/);
});

test('QMT imports reject duplicates, future dates, invalid OHLC and shrinking replacements',async()=>{
 const store=memory(),valid=candles(['2026-10-19','2026-10-20']);
 for(const bad of [[valid[0],valid[0]],candles(['2026-12-01']),[{...valid[0],high:5}]])await assert.rejects(importDailyPrices(store,{symbol:'600519',source:'qmt',candles:bad},now));
 await importDailyPrices(store,{symbol:'600519',source:'qmt',candles:valid},now);
 await assert.rejects(importDailyPrices(store,{symbol:'600519',source:'qmt',candles:valid.slice(1)},now),/覆盖减少/);
});

test('database week/month views derive from shared daily bars without network access',async()=>{
 const store=memory(),old=process.env.MARKET_READ_MODE;
 await importDailyPrices(store,{symbol:'600519',source:'qmt',candles:candles(['2026-10-16','2026-10-19','2026-10-20'])},now);
 process.env.MARKET_READ_MODE='database';
 try{
  const week=await storedKLine({symbol:'sh600519',period:'week',adjust:'none',count:100},async()=>{throw Error('network');},store,now);
  assert.equal(week.candles.length,2);assert.equal(week.candles[1].date,'2026-10-20');
  await assert.rejects(storedKLine({symbol:'sh600519',period:'day',adjust:'qfq',count:100},async()=>{},store,now),/尚未入库/);
  assert.equal(aggregateDaily(candles(['2026-10-19','2026-10-20']),'month').length,1);
 }finally{if(old===undefined)delete process.env.MARKET_READ_MODE;else process.env.MARKET_READ_MODE=old;}
});

test('intraday bars are excluded from imports and subsequent canonical updates',async()=>{
 const store=memory(),morning=Date.parse('2026-10-21T02:00:00Z');
 const dates=['2026-10-16','2026-10-19','2026-10-20','2026-10-21'];
 await importDailyPrices(store,{symbol:'600519',source:'qmt',candles:candles(dates)},morning);
 const row=await store.read(importedBarsKey('sh600519'));assert.equal(row.payload.candles.at(-1).date,'2026-10-20');
 const next=await extendImportedPrices(store,row,series(dates),morning+1);assert.equal(next.candles.at(-1).date,'2026-10-20');
});

test('complete IPO history outranks a newer short source tail in database mode',async()=>{
 const store=memory(),old=process.env.MARKET_READ_MODE;
 const dates=['2026-09-07','2026-09-08','2026-09-09','2026-10-19','2026-10-20'];
 await importDailyPrices(store,{symbol:'600519',source:'qmt',listingDate:dates[0],candles:candles(dates)},now);
 const tail=series(['2026-10-19','2026-10-20','2026-10-21']);
 await store.write(marketRecord('kline:v2:sh600519:day:none:tencent:prices-only','kline','tencent',tail,60000,now),null);
 process.env.MARKET_READ_MODE='database';
 try{
  const result=await storedKLine({symbol:'sh600519',period:'day',adjust:'none',count:1500,start:'2021-10-21'},async()=>{throw Error('network');},store,now);
  assert.equal(result.source,'canonical');assert.deepEqual(result.candles.map(c=>c.date),dates);assert.equal(result.complete,true);
 }finally{if(old===undefined)delete process.env.MARKET_READ_MODE;else process.env.MARKET_READ_MODE=old;}
});

test('multi-phase jobs checkpoint and resume, and a recent update cannot satisfy ten-year completion',async()=>{
 const store=memory();let clock=now;const q=new MarketUpdateQueue(store,()=>clock);
 await q.submit('one',['600519']);let t=await q.claim();await q.finish(t.symbol,t.lease);clock+=61000;
 await q.submit('one',['600519'],false,'ten-year');t=await q.claim();assert.equal(t.phase,0);assert.equal(t.mode,'ten-year');
 await q.finish(t.symbol,t.lease,undefined,false,1);assert.equal((await q.status('one')).finished,false);
 clock+=1001;t=await new MarketUpdateQueue(store,()=>clock).claim();assert.equal(t.phase,1);
 await q.finish(t.symbol,t.lease,'source offline');clock+=61000;t=await q.claim();assert.equal(t.phase,1);
 await q.finish(t.symbol,t.lease);assert.equal((await q.status('one')).done,1);
});

test('close scheduler deduplicates overlapping groups and only schedules once per close date',async()=>{
 const store=memory();await registerCollection(store,'one',['600519','300498']);await registerCollection(store,'two',['600519']);
 for(const symbol of ['sh600519','sz300498'])await store.write(marketRecord(`market-coverage:v1:${symbol}:10`,'market-coverage','test',{status:'ready'},60000,now),null);
 assert.equal(closeTarget(Date.parse('2026-10-21T08:29:00Z')),'2026-10-20');
 assert.equal(closeTarget(Date.parse('2026-10-21T08:30:00Z')),'2026-10-21');
 assert.equal(closeTarget(Date.parse('2026-10-24T08:30:00Z')),'2026-10-23');
 assert.equal((await scheduleMarketClose(store,now)).scheduled,2);
 assert.equal((await scheduleMarketClose(store,now)).scheduled,0);
 const q=new MarketUpdateQueue(store,()=>now);assert.ok(await q.claim());assert.equal(await q.claim(),null);
 await registerCollection(store,'one',[]);await registerCollection(store,'two',[]);
 assert.equal((await scheduleMarketClose(store,now+864e5)).scheduled,0);
});

test('daily updates schedule every registered stock; neither ready nor not-ready stocks initialize history',async()=>{
 const store=memory();await registerCollection(store,'one',['600519','300498']);
 await store.write(marketRecord('market-coverage:v1:sh600519:10','market-coverage','test',{status:'ready'},60000,now),null);
 assert.equal((await scheduleMarketClose(store,now)).scheduled,2);
 const q=new MarketUpdateQueue(store,()=>now);
 const claimed=[];let t;while((t=await q.claim())){claimed.push(t);await q.finish(t.symbol,t.lease);}
 const ready=claimed.find(c=>c.symbol==='sh600519');
 const unready=claimed.find(c=>c.symbol==='sz300498');
 assert.ok(ready&&ready.initialize===false,'已就绪标的应跳过初始化');
 assert.ok(unready&&unready.initialize===false,'未就绪标的也只能更新指定日');
});

test('close pass is lightweight daily, Sunday recovery is full history',async()=>{
 const store=memory();await registerCollection(store,'one',['600519']);
 const close=await scheduleMarketClose(store,Date.parse('2026-10-21T08:30:00Z')); // 周三 16:30 北京
 assert.equal(close.scheduled,1);
 const rec=await store.read('market-update-queue:v1');
 assert.equal(rec.payload.jobs[0].mode,'daily');
 const store2=memory();await registerCollection(store2,'one',['600519']);
 const full=await scheduleMarketClose(store2,Date.parse('2026-10-25T02:00:00Z')); // 周日 10:00 北京
 assert.equal(full.scheduled,1);
 const rec2=await store2.read('market-update-queue:v1');
 assert.equal(rec2.payload.jobs[0].mode,'ten-year');
});
