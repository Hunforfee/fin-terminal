import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from './load-modules.mjs';
const {collectDailyPrices}=await load('marketDailyCollection');
const {collectionPhases}=await load('marketHistoryPlan');
const {MarketUpdateQueue}=await load('marketUpdateQueue');
const {marketRecord,trackValuationChanges}=await load('marketStore');
const {financialPageGaps}=await load('financialPageQuality');
const {writeFinanceStatements}=await load('marketImportRecords');
const {diagnoseMarketData}=await load('marketDiagnostics');
const {acquireSourceSlot,upstreamGroup}=await load('sourceCoordination');
const {cached,clearCache}=await load('datasource/cache');
const {scheduleMarketClose,scheduleFinancialRefresh,registerCollection}=await load('marketCollection');
const now=Date.parse('2026-10-23T09:00:00Z');
const memory=()=>{const rows=new Map();return {rows,read:async k=>structuredClone(rows.get(k)??null),write:async(r,expected)=>{if((rows.get(r.key)?.digest??null)!==expected)return false;rows.set(r.key,structuredClone(r));return true;},remove:async(k,d)=>rows.get(k)?.digest===d&&rows.delete(k),incident:async()=>{}};};
const bar=date=>({date,open:10,high:11,low:9,close:10});
const series=(dates,source='tencent')=>({symbol:'sh600415',code:'600415',period:'day',adjust:'none',source,stale:false,complete:true,candles:dates.map(bar)});

test('daily collection requests exactly one date on an empty DB and duplicate runs make no request',async()=>{
 const s=memory(),calls=[];const source=async r=>{calls.push(r);return series(['2026-10-23']);};
 await collectDailyPrices('600415','2026-10-23',s,[source],now);
 await collectDailyPrices('600415','2026-10-23',s,[source],now);
 assert.equal(calls.length,1);assert.equal(calls[0].start,'2026-10-23');assert.equal(calls[0].end,'2026-10-23');assert.equal(calls[0].count,1);
 assert.equal(s.rows.size,1);assert.ok([...s.rows.keys()].every(k=>k.startsWith('kline:')));
 assert.deepEqual(collectionPhases('daily',true),[19]);assert.deepEqual(collectionPhases('financial',true),[20]);
});
test('daily collection preserves history, rejects non-target/stale data and leaves no false success',async()=>{
 const s=memory(),key='kline:v2:sh600415:day:none:tencent:prices-only';
 await s.write(marketRecord(key,'kline','tencent',series(['2020-10-23','2026-10-22']),1,now),null);
 await assert.rejects(()=>collectDailyPrices('600415','2026-10-23',s,[async()=>series(['2026-10-22'])],now),/指定日/);
 assert.equal((await s.read(key)).payload.candles.length,2);
 await collectDailyPrices('600415','2026-10-23',s,[async()=>series(['2026-10-23'])],now);
 assert.deepEqual((await s.read(key)).payload.candles.map(c=>c.date),['2020-10-23','2026-10-22','2026-10-23']);
 await assert.rejects(()=>collectDailyPrices('600415','2026-02-30',s,[],now),/日期无效/);
});
test('broker history extends only after already stored overlap agrees; no extra historical network call',async()=>{
 const s=memory(),canonical='kline:v2:sh600415:day:none:canonical:prices-only',mirror='kline:v2:sh600415:day:none:tencent:prices-only';
 const dates=['2026-10-20','2026-10-21','2026-10-22'];
 await s.write(marketRecord(canonical,'kline','qmt',{...series(dates,'canonical'),origins:[]},1,now),null);
 await s.write(marketRecord(mirror,'kline','tencent',series(dates),1,now),null);
 let calls=0;
 await collectDailyPrices('600415','2026-10-23',s,[async()=>{calls++;return series(['2026-10-23']);}],now);
 assert.equal(calls,1);assert.equal((await s.read(canonical)).payload.candles.at(-1).date,'2026-10-23');
});
test('same stock daily and history jobs do not attach to each other; daily is claimed first and retains target date',async()=>{
 const s=memory(),q=new MarketUpdateQueue(s,()=>now);
 await q.submit('history',['600415'],false,'ten-year');
 await q.submit('daily',['600415'],false,'daily','2026-10-22');
 const daily=await q.claim();assert.equal(daily.mode,'daily');assert.equal(daily.initialize,false);assert.equal(daily.targetDate,'2026-10-22');
 await q.finish(daily.symbol,daily.lease);
 assert.equal((await q.status('history')).done,0);assert.equal((await q.status('daily')).done,1);
 assert.equal((await q.claim()).mode,'ten-year');
});
test('finance import reconciles actual saved dates, identifies missing Q3, and repeated imports report unchanged',async()=>{
 const s=memory(),input={symbol:'600415',statement:'cashflow',reportDates:['2016-03-31','2016-06-30','2016-12-31'],items:[{name:'经营活动产生的现金流量净额',vals:[0,2,4]}]};
 const first=await writeFinanceStatements(s,input,now);
 assert.equal(first.complete,false);assert.equal(first.reconciliation.length,1);
 assert.deepEqual(first.reconciliation[0].missingInputs,[{date:'2016-09-30',missing:['report']}]);
 const repeated=await writeFinanceStatements(s,input,now);
 assert.equal(repeated.reconciliation.length,1);assert.equal(repeated.reconciliation[0].status,'unchanged');
 assert.equal(repeated.skipped,true);
});
test('a reported date with irrelevant populated fields is unusable; zero and losses are valid required facts',()=>{
 const p={dates:['2016-03-31'],rows:[{kind:'field',name:'管理费用',vals:['1']}]};
 assert.equal(financialPageGaps(p,'profit',p.dates).length,1);
 p.rows.push({kind:'field',name:'归属于母公司所有者的净利润',vals:['0']});
 assert.deepEqual(financialPageGaps(p,'profit',p.dates),[]);
 p.rows[1].vals=['-25'];assert.deepEqual(financialPageGaps(p,'profit',p.dates),[]);
});
test('diagnostic reads only and identifies missing inputs without declaring uncached valuation complete',async()=>{
 const s=memory();const before=s.rows.size;
 const report=await diagnoseMarketData({read:s.read},'600415',now);
 assert.equal(s.rows.size,before);assert.ok(report.missingPages>0);assert.equal(report.valuation.cached,false);assert.equal(report.valuation.revisionMatches,false);
});
test('actual input writes evict same-process cached financial results',async()=>{
 clearCache();const s=trackValuationChanges(memory());
 await cached('finance:600415',60000,async()=>1);
 await s.write(marketRecord('source-sina-page:v1:600415:profit:2025','source-sina-page','test',{dates:['2025-12-31'],rows:[]},1000,now),null);
 assert.equal(await cached('finance:600415',60000,async()=>2),2);
});
test('persistent source gate shares provider subdomains and honors a limiter across independent callers',async()=>{
 const s=memory();assert.equal(upstreamGroup('https://push2his.eastmoney.com/a'),upstreamGroup('https://datacenter-web.eastmoney.com/b'));
 const first=await acquireSourceSlot(s,'https://push2his.eastmoney.com/a',undefined,0);
 first.observe(429,'60');await first.release();
 await assert.rejects(()=>acquireSourceSlot(s,'https://datacenter-web.eastmoney.com/b',undefined,0),/冷却中/);
 const alternative=await acquireSourceSlot(s,'https://web.ifzq.gtimg.cn/a',undefined,0);alternative.observe(200);await alternative.release();
});
test('Saturday recovery cannot suppress Sunday history audit; finance cadence is separate and skips frequent polls',async()=>{
 const s=memory();await registerCollection(s,'test',['600415']);
 await scheduleMarketClose(s,Date.parse('2026-10-24T00:00:00Z'));
 await scheduleMarketClose(s,Date.parse('2026-10-25T00:00:00Z'));
 const queue=(await s.read('market-update-queue:v1')).payload;
 assert.ok(queue.jobs.some(j=>j.mode==='ten-year'));assert.ok(queue.jobs.some(j=>j.mode==='daily'));
 const f=memory();await registerCollection(f,'test',['600415']);
 assert.equal((await scheduleFinancialRefresh(f,now)).scheduled,1);
 assert.equal((await scheduleFinancialRefresh(f,now+60000)).scheduled,0);
 assert.equal((await f.read('market-update-queue:v1')).payload.jobs[0].mode,'financial');
});
