import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {load} from './load-modules.mjs';
const {fileMarketStore, marketRecord, marketDigest} = await load('marketStore');
const {storedKLine, validateKLine} = await load('klineStorage');
const {storedMarketInput, validateDatedRows} = await load('marketInputs');
const now = Date.parse('2026-10-21T02:00:00Z');
const req = {symbol:'sh600519',period:'day',adjust:'none',count:40};
const dates = Array.from({length:60},(_,i)=>new Date(Date.parse('2026-08-22')+i*864e5).toISOString().slice(0,10));
const bars = dates.map((date,i)=>({date,open:100+i,close:101+i,high:102+i,low:99+i,volume:1000+i}));
const series = (candles=bars.slice(0,40), adjust='none',extra={})=>({symbol:req.symbol,code:'600519',period:'day',adjust,candles,source:'tencent',stale:false,...extra});
async function fixture(fn) {
  const base=path.resolve('data');await fs.mkdir(base,{recursive:true});
  const dir=await fs.mkdtemp(path.join(base,'market-test-'));
  try {await fn(fileMarketStore(dir),dir);} finally {if(!path.resolve(dir).startsWith(base+path.sep))throw Error('Unsafe test cleanup');await fs.rm(dir,{recursive:true,force:true});}
}

test('batch recent-only updates never expand into the overdue full-history review',()=>fixture(async store=>{
  const original=now-8*864e5;
  await storedKLine({...req,count:30},async()=>series(bars.slice(0,30)),store,original);
  const recent=[];
  const result=await storedKLine({...req,count:20,start:dates[40],recentOnly:true},async query=>{recent.push(query);return series(bars.slice(40));},store,now);
  assert.equal(result.candles.length,20);assert.equal(recent.length,1);
  assert.equal(recent[0].count,20);assert.equal(recent[0].start,dates[40]);assert.equal(recent[0].end,undefined);
  let full;
  await storedKLine({...req,count:60,start:dates[0]},async query=>{full=query;return series(bars);},store,now+1000);
  assert.ok(full,'Recent updates must not mark overdue full history as reviewed');
  assert.equal(full.start,dates[0]);assert.ok(full.count>=60);
}));

test('persistent K-line survives adapter recreation and reuses another query size',()=>fixture(async(store,dir)=>{
  let calls=0;
  await storedKLine(req,async()=>{calls++;return series();},store,now);
  const hit=await storedKLine({...req,count:20},async()=>{throw Error('must not fetch');},fileMarketStore(dir),now+1000);
  assert.equal(calls,1);assert.equal(hit.candles.length,20);assert.ok(hit.candles.every(c=>!('volume' in c)));assert.equal(hit.storage.backend,'persistent');
}));
test('raw range extension asks only for older gap and recent overlap, then deduplicates',()=>fixture(async store=>{
  await storedKLine({...req,count:20},async()=>series(bars.slice(20,40)),store,now);
  const calls=[];
  const result=await storedKLine(req,async r=>{calls.push(r);return series(r.end?bars.slice(0,20):bars.slice(32,40));},store,now+61000);
  assert.equal(calls.length,2);assert.equal(calls[0].end,dates[19]);assert.equal(result.candles.length,40);
  assert.equal(new Set(result.candles.map(c=>c.date)).size,40);
}));
test('refreshing raw prices updates recent candles without refetching entire history',()=>fixture(async store=>{
  await storedKLine(req,async()=>series(),store,now);
  let request;
  const result=await storedKLine(req,async r=>{request=r;return series(bars.slice(32,41));},store,now+61000);
  assert.equal(request.start,dates[32]);assert.ok(request.count<40);assert.equal(result.candles.at(-1).date,dates[40]);
}));
test('source outage returns explicitly stale stored range after restart',()=>fixture(async(store,dir)=>{
  await storedKLine(req,async()=>series(),store,now);
  const result=await storedKLine(req,async()=>{throw Error('network');},fileMarketStore(dir),now+61000);
  assert.equal(result.stale,true);assert.match(result.warnings.join(''),/上次/);
}));
test('historical raw-price conflict is quarantined without overwriting old data',()=>fixture(async store=>{
  await storedKLine(req,async()=>series(),store,now);
  const changed=bars.slice(0,40).map((c,i)=>i===0?{...c,open:1,close:2,high:3,low:1}:c);
  const result=await storedKLine(req,async()=>series(changed),store,now+61000);
  assert.equal(result.stale,true);assert.equal(result.candles[0].close,bars[0].close);
}));
test('adjusted revisions replace the entire coherent sequence and retain prior version',()=>fixture(async(store,dir)=>{
  const request={...req,adjust:'qfq'};
  await storedKLine(request,async()=>series(bars.slice(0,40),'qfq'),store,now);
  let asked;
  const changed=bars.slice(0,41).map(c=>({...c,open:c.open/2,close:c.close/2,high:c.high/2,low:c.low/2}));
  const result=await storedKLine(request,async r=>{asked=r;return series(changed,'qfq');},store,now+61000);
  assert.equal(asked.start,dates[0]);assert.ok(result.candles.every(c=>c.close<100));
  assert.ok((await fs.readdir(dir)).some(p=>p.endsWith('.history.json')));
}));
test('partial adjusted refresh never mixes new tail with old adjusted history',()=>fixture(async store=>{
  const request={...req,adjust:'qfq'};
  await storedKLine(request,async()=>series(bars.slice(0,40),'qfq'),store,now);
  const result=await storedKLine(request,async()=>series(bars.slice(30,41),'qfq',{complete:false}),store,now+61000);
  assert.equal(result.stale,true);assert.equal(result.candles[0].date,dates[0]);
}));
test('source identities, adjustment modes, impossible prices, future dates are rejected',()=>{
  for(const value of [series(undefined,'qfq'),series(undefined,'none',{symbol:'sh000001'}),
    series([{...bars[0],high:1}]),series([{...bars[0],date:'2099-01-01'}]),
    series([bars[0],bars[0]]),series([{...bars[0],date:'2026-02-30'}])])
    assert.throws(()=>validateKLine(value,req,now));
});
test('database outage still serves validated upstream values and warns about failed persistence',async()=>{
  const failed={read:async()=>{throw Error('offline');},write:async()=>{throw Error('offline');},incident:async()=>{}};
  const result=await storedKLine(req,async()=>series(),failed,now);
  assert.equal(result.storage.backend,'upstream');assert.match(result.warnings.join(''),/未确认持久化/);
});
test('concurrent same request shares fetch and file compare-and-swap protects against lost updates',()=>fixture(async store=>{
  let calls=0;const fetcher=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return series();};
  await Promise.all([storedKLine(req,fetcher,store,now),storedKLine(req,fetcher,store,now)]);assert.equal(calls,1);
  const record=marketRecord('cas','fixture','test',{a:1},1000,now);
  assert.equal(await store.write(record,null),true);
  assert.equal(await store.write(marketRecord('cas','fixture','test',{a:2},1000,now),'wrong'),false);
  assert.equal((await store.read('cas')).payload.a,1);
}));
test('a damaged persistent record is not mistaken for valid or silently overwritten',()=>fixture(async(store,dir)=>{
  const record=marketRecord('damaged','fixture','test',{a:1},1000,now);await store.write(record,null);
  await fs.writeFile(path.join(dir,marketDigest('damaged')+'.json'),'invalid');
  await assert.rejects(store.read('damaged'));
  await assert.rejects(store.write(record,null));
}));
test('financial maps persist; expired financials never silently substitute for current inputs',()=>fixture(async(store,dir)=>{
  const validate=v=>{assert.ok(v instanceof Map);};
  const value=await storedMarketInput('dates','disclosures','source',1000,async()=>new Map([['2025-12-31','2026-04-01']]),validate,store,now);
  assert.equal(value.size,1);
  const hit=await storedMarketInput('dates','disclosures','source',1000,async()=>{throw Error('must not fetch');},validate,fileMarketStore(dir),now+1);assert.equal(hit.size,1);
  await assert.rejects(storedMarketInput('dates','disclosures','source',1000,async()=>{throw Error('source down');},validate,store,now+2000),/source down/);
}));
test('partial financial histories never discard previously covered dates',()=>fixture(async store=>{
  const validate=v=>validateDatedRows(v,'date',['npParent']);
  await storedMarketInput('fin','financial','source',1000,async()=>[{date:'2025-12-31',npParent:1},{date:'2026-06-30',npParent:2}],validate,store,now);
  const merged=await storedMarketInput('fin','financial','source',1000,async()=>[{date:'2026-06-30',npParent:2}],validate,store,now+2000);
  assert.equal(merged.length,2);
  assert.equal(merged[0].date,'2025-12-31');
  assert.equal(merged[1].date,'2026-06-30');
  assert.equal((await store.read('fin')).payload.length,2);
}));

test('content hashes survive PostgreSQL JSONB key reordering',()=>{
  assert.equal(marketDigest({a:1,b:{z:2,c:3}}),marketDigest({b:{c:3,z:2},a:1}));
  assert.notEqual(marketDigest({rows:[1,2]}),marketDigest({rows:[2,1]}));
});

test('duplicate cash implementations count once and conflicting implementations fail',async()=>{
  const {parseBonusPage}=await load('datasource/sinaBonus');
  const row=amount=>`<tr>${['2025-05-01','0','0',amount,'实施','2025-06-01'].map(v=>`<td>${v}</td>`).join('')}</tr>`;
  const events=parseBonusPage(row('5.000')+row('5.000'));
  assert.equal(events.length,1);assert.equal(events[0].perShare,.5);
  assert.throws(()=>parseBonusPage(row('5.000')+row('6.000')),/不同金额/);
  assert.equal(parseBonusPage(row('')).length,0);
});

test('cash reconciliation permits only declared display rounding, not actual conflicts',async()=>{
  const {reconcileCashDividends}=await load('valuationInputs');
  const e={exDate:'2026-06-26',perShare:28.0242,perShareStock:0,precisionPerShare:.0001};
  const p={reportDate:'2025-12-31',announceDate:'2026-04-01',exDate:e.exDate,perShare:28.02423,implemented:true,cancelled:false};
  const result=reconcileCashDividends([e],[p],'2026-10-21');
  assert.equal(result[0].perShare,28.02423);assert.equal(result[0].cashSource,'sina+eastmoney-rounding-reconciled');
  const conflicting=reconcileCashDividends([e],[{...p,perShare:29}],'2026-10-21');
  assert.deepEqual(conflicting[0].cashConflict,{sina:28.0242,eastmoney:29});
  const {buildDividendYieldByDate}=await load('analytics');
  assert.equal(buildDividendYieldByDate(conflicting,[{date:'2026-06-30',open:100,close:100,high:100,low:100}]).has('2026-06-30'),false);
  assert.equal(reconcileCashDividends([e],[{...p,implemented:false}],'2026-10-21')[0].perShare,e.perShare);
});

test('rolling cash yield uses a calendar-year window and adjusts split share basis',async()=>{
  const {buildDividendYieldByDate}=await load('analytics');
  const c=date=>({date,open:10,high:10,low:10,close:10,volume:1});
  assert.equal(buildDividendYieldByDate([{exDate:'2023-03-01',perShare:1}],[c('2024-03-01')]).get('2024-03-01'),0);
  assert.equal(buildDividendYieldByDate([{exDate:'2023-03-02',perShare:1}],[c('2024-03-01')]).get('2024-03-01'),10);
  assert.equal(buildDividendYieldByDate([{exDate:'2025-06-01',perShare:1,perShareStock:1}],[c('2025-06-02')]).get('2025-06-02'),5);
});

test('cross-source checks isolate completed bars, recognize hand rounding, and reject actual mismatches',async()=>{
  const {crossCheckMainlandRaw}=await load('klineCrossCheck');
  const a=series(bars.slice(0,10));
  const b={...a,source:'sina',candles:a.candles.map(c=>({...c,volume:c.volume+.49}))};
  assert.equal(crossCheckMainlandRaw(a,b,'2026-10-21').quality.matchedBars,10);
  assert.throws(()=>crossCheckMainlandRaw(a,{...b,candles:b.candles.map(c=>({...c,close:c.close+.01}))},'2026-10-21'),/来源存在差异/);
  assert.equal(crossCheckMainlandRaw(a,{...b,candles:b.candles.map(c=>({...c,volume:c.volume*100}))},'2026-10-21').quality.matchedBars,10);
  assert.equal(crossCheckMainlandRaw(a,{...b,candles:b.candles.map(c=>({...c,close:999}))},dates[0]).quality,undefined);
});

test('screen financials are shared per company across changing groups and only missing companies fetch',()=>fixture(async store=>{
  const {storedScreenFinancials}=await load('screenFinancialStorage');
  const period='2026-06-30',calls=[];
  const producer=async codes=>{calls.push(codes);return {main:codes.map(code=>({SECURITY_CODE:code,REPORT_DATE:period,CURRENCY:'CNY',ROEJQ:10})),income:[]};};
  await storedScreenFinancials(['600519','300498'],[period],producer,store,now);
  const result=await storedScreenFinancials(['300498','600036'],[period],producer,store,now+1000);
  assert.deepEqual(calls,[['300498','600519'],['600036']]);
  assert.deepEqual(result.main.map(r=>r.SECURITY_CODE).sort(),['300498','600036']);
  assert.equal((await store.readInputs(['screen-company-input:v1:300498:eastmoney:CNY'])).length,1);
}));

test('screen financials do not cache an empty response as evidence of absent reports',()=>fixture(async store=>{
  const {storedScreenFinancials}=await load('screenFinancialStorage');let calls=0;
  const producer=async()=>{calls++;return {main:[],income:[]};};
  await storedScreenFinancials(['600519'],['2026-06-30'],producer,store,now);
  await storedScreenFinancials(['600519'],['2026-06-30'],producer,store,now+1);
  assert.equal(calls,2);
}));

test('older raw history is periodically rechecked, not permanently trusted after first storage',()=>fixture(async store=>{
  await storedKLine(req,async()=>series(),store,now);
  let asked;
  await storedKLine(req,async request=>{asked=request;return series();},store,now+8*864e5);
  assert.equal(asked.start,dates[0]);assert.ok(asked.count>=40);
}));
