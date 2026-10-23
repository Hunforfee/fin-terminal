import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { load } from './load-modules.mjs';
const {marketCutoff,retainMarketPayload}=await load('marketRetention');
const {fileMarketStore,marketRecord,marketDigest}=await load('marketStore');
const {runMarketMaintenance}=await load('marketMaintenance');
const {withMarketRefresh}=await load('marketRefresh');
const {sharedQuotes}=await load('quoteInputs');
const now=Date.parse('2026-10-21T04:00:00Z');
async function fixture(run){
  const root=path.resolve('data');await fs.mkdir(root,{recursive:true});const directory=await fs.mkdtemp(path.join(root,'retention-test-'));
  try{await run(fileMarketStore(directory),directory);}finally{if(!directory.startsWith(root+path.sep))throw Error('Unsafe path');await fs.rm(directory,{recursive:true,force:true});}
}
test('twelve-calendar-year cutoff handles leap days and prunes aligned financial columns',()=>{
  assert.equal(marketCutoff(now),'2014-10-21');assert.equal(marketCutoff(Date.parse('2024-02-29T04:00Z')),'2012-02-29');
  const page={dates:['2014-09-30','2014-12-31','2026-06-30'],rows:[{kind:'field',name:'收入',vals:['1','2','3']},{kind:'group',name:'现金流',vals:[]}],unit:'万元'};
  const kept=retainMarketPayload('source-sina-page',page,now);
  assert.deepEqual(kept.dates,['2014-09-30','2014-12-31','2026-06-30']);assert.deepEqual(kept.rows[0].vals,['1','2','3']);assert.equal(kept.rows[1].kind,'group');
  const series=retainMarketPayload('watchlist-financial-inputs',{periods:page.dates,periodLabels:['old','a','b'],series:{roe:[1,2,3]}},now);
  assert.deepEqual(series.series.roe,[2,3]);assert.deepEqual(series.periodLabels,['a','b']);
});
test('share boundary preserves a labelled opening state; personal notes and research are untouched',()=>{
  // 十二年窗口另保留两年输入缓冲，并在缓冲边界携带有标签的股本期初状态。
  // 最早需要的报告点是 2016-09-30，日期粒度截止点（2016-10-21）上合成的基线状态
  // 晚于该报告点，sharesAt 取不到股本会整点丢弃；缓冲后 2015-05-13 的真实变更事件
  // 以原日期保留，窗口左边界即有生效股本。
  const shares=retainMarketPayload('share-events',[{date:'2010-01-01',sharesWan:100},{date:'2015-05-13',sharesWan:120},{date:'2025-01-01',sharesWan:130}],now);
  assert.deepEqual(shares,[{date:'2012-10-21',sharesWan:100,baseline:true},{date:'2015-05-13',sharesWan:120},{date:'2025-01-01',sharesWan:130}]);
  const noPrior=retainMarketPayload('share-events',[{date:'2015-05-13',sharesWan:120},{date:'2025-01-01',sharesWan:130}],now);
  assert.deepEqual(noPrior,[{date:'2015-05-13',sharesWan:120},{date:'2025-01-01',sharesWan:130}]);
  const note={date:'2000-01-01',text:'投资记录'};assert.equal(retainMarketPayload('personal-note',note,now),note);
  const map=retainMarketPayload('disclosure-dates',new Map([['2010-12-31','2011-03-01'],['2025-12-31','2026-03-01']]),now);
  assert.deepEqual([...map],[['2025-12-31','2026-03-01']]);
});
test('retention sweeps trim stored prices, remove abandoned snapshots, preserve current history and active queues',()=>fixture(async(store)=>{
  const candles=[{date:'2014-10-20',open:1,close:1,high:1,low:1},{date:'2014-10-21',open:1,close:1,high:1,low:1},{date:'2016-01-01',open:1,close:1,high:1,low:1},{date:'2026-10-20',open:2,close:2,high:2,low:2}];
  const payload={symbol:'sh600519',candles};
  const legacy={...marketRecord('legacy-price','kline','test',payload,1000,now),payload,digest:marketDigest(payload)};
  await store.write(legacy,null);
  await store.write(marketRecord('abandoned-quote','latest-quote','test',{price:1},1000,now-31*864e5),null);
  await store.write(marketRecord('queue','market-update-queue','internal',{state:'running'},1000,now-31*864e5),null);
  const result=await runMarketMaintenance(store,now,500);
  assert.equal(result.trimmed,1);assert.equal(result.removed,1);
  const price=await store.read('legacy-price');assert.deepEqual(price.payload.candles.map(c=>c.date),['2014-10-21','2016-01-01','2026-10-20']);
  assert.equal(price.acquiredAt,legacy.acquiredAt);assert.equal(price.refreshAfter,legacy.refreshAfter);
  assert.equal(await store.read('abandoned-quote'),null);assert.ok(await store.read('queue'));
  assert.equal((await runMarketMaintenance(store,now+1000)).skipped,true);
}));
test('shared-store refresh leases serialize work and release on failure without holding a database connection',()=>fixture(async(store)=>{
  let running=0,max=0;
  await Promise.all(Array.from({length:3},()=>withMarketRefresh(store,'one-company',async()=>{running++;max=Math.max(max,running);await new Promise(r=>setTimeout(r,10));running--;})));
  assert.equal(max,1);
  await assert.rejects(withMarketRefresh(store,'failure',async()=>{throw Error('upstream failed');}),/upstream failed/);
  assert.equal(await withMarketRefresh(store,'failure',async()=>42),42);
}));
test('overlapping quote batches fetch each missing stock once and reuse the same durable snapshot',()=>fixture(async(store)=>{
  const requested=[];
  const fetcher=async symbols=>{requested.push(...symbols);await new Promise(r=>setTimeout(r,15));return symbols.map(symbol=>({symbol,code:symbol.slice(2),price:10,source:'test',stale:false}));};
  const [a,b]=await Promise.all([sharedQuotes(['sh600519','sz000858'],fetcher,store),sharedQuotes(['sz000858','sz000001'],fetcher,store)]);
  assert.equal(a.length,2);assert.equal(b.length,2);assert.equal(requested.filter(s=>s==='sz000858').length,1);
  const next=await sharedQuotes(['sz000001','sh600519'],fetcher,store);assert.equal(next.length,2);assert.equal(requested.length,3);
}));
test('maintenance deletion uses CAS and cannot delete a newer quote written during cleanup',()=>fixture(async(store)=>{
  const old=marketRecord('snapshot','latest-quote','test',{price:1},1000,now-31*864e5);await store.write(old,null);
  const original=store.remove;
  store.remove=async(key,digest)=>{const previous=await store.read(key);await store.write(marketRecord(key,'latest-quote','test',{price:2},60000,now),previous.digest);return original(key,digest);};
  await runMarketMaintenance(store,now,500);
  assert.equal((await store.read('snapshot')).payload.price,2);
}));
