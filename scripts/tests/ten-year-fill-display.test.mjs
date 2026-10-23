import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from './load-modules.mjs';
const plan=await load('marketHistoryPlan');
const {retainMarketPayload}=await load('marketRetention');
const {MarketUpdateQueue}=await load('marketUpdateQueue');
const {marketRecord}=await load('marketStore');
const {takePrioritized,readWatchlistDisplay,requestLimiter}=await load('watchlistDisplay');
const now=Date.parse('2026-10-22T02:00:00Z');
function memory(){const rows=new Map();return {rows,read:async key=>structuredClone(rows.get(key)??null),write:async(row,expected)=>{if((rows.get(row.key)?.digest??null)!==expected)return false;rows.set(row.key,structuredClone(row));return true;}};}
test('ten-year plan covers all twelve statement years needed at the TTM boundary',()=>{
 assert.equal(plan.historyStart(now),'2016-10-22');assert.equal(plan.historyStart(Date.parse('2024-02-29T04:00Z')),'2014-02-28');
 assert.equal(plan.HISTORY_BAR_COUNT,3000);
 const years=plan.FULL_HISTORY_PHASES.map(p=>plan.financialYearForPhase(p,now)).filter(y=>y!==null);
 assert.deepEqual(years,Array.from({length:12},(_,i)=>2026-i));assert.equal(plan.FULL_HISTORY_PHASES.at(-1),12);
 assert.equal(plan.collectionPhaseLabel(12),'完整性检查');assert.equal(plan.collectionPhaseLabel(13),'公司资料');
});
test('five-year coverage does not expand a daily task into initialization',async()=>{
 const s=memory();await s.write(marketRecord('market-coverage:v1:sh600519:5','market-coverage','test',{status:'ready'},60000,now),null);
 const q=new MarketUpdateQueue(s,()=>now);await q.submit('daily',['600519'],false,'daily');
 assert.equal((await q.claim()).initialize,false);
 assert.equal(plan.coverageKey('sh600519'),'market-coverage:v1:sh600519:10');
});
test('old unfinished five-year queue records restart under the ten-year plan with a new lease',async()=>{
 const s=memory();await s.write(marketRecord('market-update-queue:v1','market-update-queue','internal',{
 jobs:[{id:'old',owner:'user',symbols:['sh600519'],skipped:[],createdAt:now,mode:'five-year'}],
 items:{sh600519:{symbol:'sh600519',mode:'five-year',state:'running',phase:10,attempts:1,nextAt:now,lease:'old',leaseUntil:now+1e8}},workerAt:now,pauseUntil:0},60000,now),null);
 const q=new MarketUpdateQueue(s,()=>now),task=await q.claim();
 assert.equal(task.mode,'ten-year');assert.equal(task.phase,0);assert.equal(task.initialize,true);
 assert.notEqual(task.lease,'old');assert.equal(await q.finish('sh600519','old'),false);
});
test('manual ten-year fills run independently from daily tasks and cannot silently change scope',async()=>{
 const s=memory(),q=new MarketUpdateQueue(s,()=>now);
 await q.submit('auto',['600519'],false,'daily');
 await q.submit('user',['600519'],false,'ten-year');
 const daily=await q.claim();assert.equal(daily.mode,'daily');await q.finish(daily.symbol,daily.lease);
 assert.equal((await q.status('user')).done,0);assert.equal((await q.claim()).mode,'ten-year');
 const other=new MarketUpdateQueue(memory(),()=>now);
 await other.submit('user',['600519'],false,'ten-year');
 await assert.rejects(other.submit('user',['hk00700'],false,'ten-year'),/其他范围/);
});
test('ten-year valuation inputs retain the pre-window financial evidence but display prices do not',()=>{
 const points=[{date:'2010-12-31'},{date:'2015-12-31'},{date:'2016-06-30'},{date:'2026-06-30'}];
 assert.deepEqual(retainMarketPayload('financial-history',points,now).map(p=>p.date),['2015-12-31','2016-06-30','2026-06-30']);
 assert.deepEqual(retainMarketPayload('kline',{candles:points},now).candles.map(p=>p.date),['2026-06-30']);
});
test('page changes prioritize new visible stocks without restarting or duplicating the background queue',()=>{
 const pending=new Set(['a','b','c','d','e']);
 assert.deepEqual(takePrioritized(pending,['d','c'],2),['d','c']);
 assert.deepEqual(takePrioritized(pending,['e','d'],2),['e','a']);
 assert.deepEqual(takePrioritized(pending,[],2),['b']);
});
test('display snapshots are bounded by age, filtered to the current watchlist and preserve unknowns',()=>{
 const quote={symbol:'hk00700',code:'00700',name:'腾讯控股'};
 const raw=JSON.stringify({version:1,at:now,quotes:[quote,{symbol:'sh600519',code:'600519',name:'贵州茅台'}],otherAssets:[],financials:[{code:'00700'}],dividendYields:[['hk00700',null],['sh600519',0]],deductedPes:[]});
 const saved=readWatchlistDisplay(raw,['hk00700'],now+1000);
 assert.deepEqual(saved.quotes,[quote]);assert.deepEqual(saved.dividendYields,[['hk00700',null]]);assert.deepEqual(saved.financials,[]);
 assert.equal(readWatchlistDisplay(raw,['hk00700'],now+8*864e5),null);
 assert.equal(readWatchlistDisplay('broken',[],now),null);
});
test('financial loading stays within two concurrent requests and queued work honours cancellation',async()=>{
 const abort=new AbortController(),limited=requestLimiter(2,abort.signal);let running=0,max=0;
 await Promise.all(Array.from({length:8},()=>limited(async()=>{running++;max=Math.max(max,running);await new Promise(r=>setTimeout(r,5));running--;})));
 assert.equal(max,2);abort.abort(Error('cancelled'));
 await assert.rejects(limited(async()=>{throw Error('must not start');}),/cancelled/);
});
