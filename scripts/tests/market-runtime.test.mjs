import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from './load-modules.mjs';
const {marketRecord}=await load('marketStore');
const {storedMarketInput}=await load('marketInputs');
const {storedKLine}=await load('klineStorage');
const {cached,cacheStats,clearCache,putCache}=await load('datasource/cache');
const {reconcileCashDividends}=await load('valuationInputs');
const {buildExpectedDividendYieldByDate}=await load('dividends');
const now=Date.parse('2026-10-22T00:00:00Z');
const memory=()=>{const rows=new Map(),reads=[];return {rows,reads,read:async key=>{reads.push(key);return structuredClone(rows.get(key)??null);},write:async(record,expected)=>{if((rows.get(record.key)?.digest??null)!==expected)return false;rows.set(record.key,structuredClone(record));return true;},incident:async()=>{}};};
async function database(run){const old=process.env.MARKET_READ_MODE;process.env.MARKET_READ_MODE='database';try{return await run();}finally{if(old===undefined)delete process.env.MARKET_READ_MODE;else process.env.MARKET_READ_MODE=old;}}
const bar=date=>({date,open:10,high:11,low:9,close:10});
const series=(candles,source='canonical')=>({symbol:'sh600415',code:'600415',period:'day',adjust:'none',source,stale:false,complete:true,candles});

test('complete canonical history reads once, ignores newer mirror tails, and concurrent pages share one read',()=>database(async()=>{
 const store=memory(),key='kline:v2:sh600415:day:none:canonical:prices-only';
 await store.write(marketRecord(key,'kline','qmt',series([bar('2021-10-22'),bar('2026-10-21')]),1,now),null);
 const mirror='kline:v2:sh600415:day:none:tencent:prices-only';
 await store.write(marketRecord(mirror,'kline','tencent',series([bar('2026-10-21'),bar('2026-10-22')],'tencent'),1,now),null);
 const req={symbol:'sh600415',period:'day',adjust:'none',count:1500,start:'2021-10-22'};
 const values=await Promise.all(Array.from({length:12},()=>storedKLine(req,async()=>{throw Error('network');},store,now)));
 assert.deepEqual(store.reads,[key]);assert.ok(values.every(v=>v.source==='canonical'&&v.candles.length===2));
 const other=memory();await other.write(marketRecord(key,'kline','qmt',series([{...bar('2021-10-22'),close:11},bar('2026-10-21')]),1,now),null);
 assert.equal((await storedKLine(req,async()=>{},other,now)).candles[0].close,11);
 const old=await store.read(key);await store.write(marketRecord(key,'kline','qmt',series([bar('2021-10-22'),{...bar('2026-10-21'),close:11}]),1,now),old.digest);
 assert.equal((await storedKLine(req,async()=>{},store,now)).candles.at(-1).close,11,'A later import must be immediately visible');
}));

test('raw source-page refresh preserves imported fields and missing dates while accepting explicit zero',async()=>{
 const store=memory(),key='source-sina-page:v1:600415:balance:2025';
 const before={unit:'wan',dates:['2025-12-31','2025-09-30'],announceDates:['2026-04-01','2025-10-20'],rows:[{kind:'field',name:'资产总计',vals:['100','90']},{kind:'field',name:'短期借款',vals:['20','10']}]};
 await store.write(marketRecord(key,'source-sina-page','qmt',before,1,now),null);
 const next={unit:'万元',dates:['2025-12-31'],rows:[{kind:'field',name:'资产总计',vals:['--']},{kind:'field',name:'短期借款',vals:['0']},{kind:'field',name:'长期借款',vals:['3']}]};
 const result=await storedMarketInput(key,'source-sina-page','sina',1000,async()=>next,v=>assert.equal(new Set(v.dates).size,v.dates.length),store,now+1000);
 assert.deepEqual(result.dates,before.dates);assert.deepEqual(result.rows.find(r=>r.name==='资产总计').vals,['100','90']);
 assert.deepEqual(result.rows.find(r=>r.name==='短期借款').vals,['0','10']);assert.deepEqual(result.rows.find(r=>r.name==='长期借款').vals,['3','--']);assert.deepEqual(result.announceDates,before.announceDates);
 const old=await store.read(key);await assert.rejects(storedMarketInput(key,'source-sina-page','sina',1,async()=>({...next,unit:'元'}),()=>{},store,now+3000),/单位/);assert.equal((await store.read(key)).digest,old.digest);
});

test('partial valuation history retains total and ordinary equity fields as well as parent amounts',async()=>{
 const store=memory(),row={date:'2026-06-30',npParent:10,npTotal:12,equityParent:100,equityTotal:120,equityCommon:95,sharesYi:2};
 await store.write(marketRecord('fin','financial-history','qmt',[row],1,now),null);
 const result=await storedMarketInput('fin','financial-history','sina',1,async()=>[{date:row.date,npParent:0,npTotal:null,equityParent:null,equityTotal:null,equityCommon:null,sharesYi:null}],()=>{},store,now+1000);
 assert.deepEqual(result,[{...row,npParent:0}]);
});

test('database corruption is reported as corruption without requesting the network',()=>database(async()=>{
 let calls=0;const store={read:async()=>{throw Error('digest mismatch');}};
 await assert.rejects(storedMarketInput('bad','financial-history','qmt',1,async()=>{calls++;return [];},()=>{},store,now),/数据库读取或校验失败.*digest mismatch/);assert.equal(calls,0);
}));

test('changing the display range reuses a broader stored disclosure map without copying or refreshing it',()=>database(async()=>{
 const store=memory(),dates=new Map([['2025-12-31','2026-04-01']]);
 await store.write(marketRecord('disclosures-v3:600415:12','disclosure-dates','issuer',{$marketMap:[...dates]},1,now),null);
 let calls=0;const result=await storedMarketInput('disclosures-v3:600415:7','disclosure-dates','issuer',1000,async()=>{calls++;throw Error('network');},v=>assert.ok(v instanceof Map),store,now+1000);
 assert.deepEqual(result,dates);assert.equal(calls,0);assert.equal(store.rows.size,1);
 assert.equal(store.rows.has('disclosures-v3:600415:7'),false);
 await assert.rejects(storedMarketInput('disclosures-v3:000923:7','disclosure-dates','issuer',1,async()=>{calls++;return dates;},()=>{},store,now),/尚未入库/);
 assert.equal(calls,0,'Never use another issuer or invent missing publication dates');
}));

test('database valuation coalesces without retaining a stale result after validation failure',async()=>{
 clearCache();let calls=0;const produce=async()=>{calls++;return {stale:false,value:1};};
 await Promise.all(Array.from({length:10},()=>cached('db-valuation',0,produce,{staleOnError:false})));assert.equal(calls,1);assert.equal(cacheStats().size,0);
 await assert.rejects(cached('db-valuation',0,async()=>{throw Error('invalid current input');},{staleOnError:false}),/invalid current input/);
 await assert.rejects(cached('sync-throw',0,()=>{throw Error('sync failure');},{staleOnError:false}),/sync failure/);assert.equal(cacheStats().pending,0);
 for(let i=0;i<1300;i++)putCache('unique-'+i,i,100000);assert.equal(cacheStats().size,1024);clearCache();
});

test('an older request completing after cache invalidation cannot replace the newer value',async()=>{
 clearCache();let release;const gate=new Promise(r=>release=r);
 const older=cached('changed',60000,async()=>{await gate;return 1;});await new Promise(r=>setImmediate(r));
 clearCache();assert.equal(await cached('changed',60000,async()=>2),2);release();assert.equal(await older,1);
 assert.equal(await cached('changed',60000,async()=>3),2);clearCache();
});

test('ordinary and special dividends remain separate components for forecasts and cash conflict checks',()=>{
 const ordinary={reportDate:'2024-06-30',announceDate:'2024-10-11',perShare:.4,exDate:'2024-11-07',scheduleKnownDate:'2024-10-31',special:false,cancelled:false,implemented:true};
 const special={...ordinary,announceDate:'2024-10-12',perShare:1,special:true};
 const events=[{exDate:'2024-11-07',perShare:1.4,perShareStock:0,precisionPerShare:.0001}];
 assert.equal(reconcileCashDividends(events,[ordinary,special],'2024-11-08')[0].cashConflict,undefined);
 assert.ok(reconcileCashDividends([{...events[0],perShare:.4}],[ordinary,special],'2024-11-08')[0].cashConflict);
 const yields=buildExpectedDividendYieldByDate([ordinary,special],[bar('2024-11-01'),bar('2024-11-08')]);
 assert.ok(Math.abs(yields.get('2024-11-01')-14)<1e-12);assert.equal(yields.get('2024-11-08'),4);
 assert.doesNotThrow(()=>reconcileCashDividends(events,[{...ordinary,announceDate:null}],'2024-11-08'));
});
