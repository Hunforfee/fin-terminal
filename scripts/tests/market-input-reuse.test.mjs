import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { load } from './load-modules.mjs';
const { storedMarketInput } = await load('marketInputs');

test('concurrent page and worker reads share one source fetch, then reuse its stored record', async () => {
  let record=null,calls=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const store={read:async()=>record,write:async value=>{record=value;return true;},incident:async()=>{}};
  const producer=async()=>{calls++;await gate;return [{date:'2026-10-20',value:12}];};
  const reads=Array.from({length:20},()=>storedMarketInput('shared','financial-input','source',60000,producer,()=>{},store));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);release();
  const values=await Promise.all(reads);assert.equal(values.length,20);
  const again=await storedMarketInput('shared','financial-input','source',60000,producer,()=>{},store);
  assert.equal(again[0].value,12);assert.equal(calls,1);
});

test('a failed shared fetch releases the lock; different stores never share private results', async () => {
  let calls=0;
  const makeStore=()=>({read:async()=>null,write:async()=>true,incident:async()=>{}});
  const first=makeStore(),second=makeStore();
  const producer=async()=>{calls++;throw Error('source offline');};
  const results=await Promise.allSettled(Array.from({length:8},()=>storedMarketInput('key','kind','source',1000,producer,()=>{},first)));
  assert.equal(calls,1);assert.ok(results.every(r=>r.status==='rejected'));
  const value=await storedMarketInput('key','kind','source',1000,async()=>42,()=>{},first);assert.equal(value,42);
  const other=await storedMarketInput('key','kind','source',1000,async()=>99,()=>{},second);assert.equal(other,99);
});

test('persistent freshness and later database writes are not hidden by a second memory TTL', async () => {
  const exported={};let now=1000,record={payload:{value:1},refreshAfter:new Date(1005).toISOString()},calls=0;
  class Clock extends Date {static now(){return now;}}
  const store={read:async()=>record,write:async value=>{record=value;return true;},incident:async()=>{}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/marketInputs.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{
    exports:exported,Date:Clock,
    require(name){
      if(name==='./marketStore')return {getMarketStore:()=>store,marketRecord:(key,kind,source,payload,ttl,time)=>({key,kind,source,payload,refreshAfter:new Date(time+ttl).toISOString()})};
      if(name==='./datasource/cache')return {cached(){throw Error('Persistent inputs must not get a second TTL');}};
      if(name==='./marketRefresh')return {withMarketRefresh:(_store,_key,work)=>work()};
      if(name==='./marketRetention')return {retainMarketPayload:(_kind,value)=>value};
      if(name==='./marketReadPolicy')return {databaseOnly:()=>false};
      if(name==='./hkDividendEvents')return {};
      throw Error(name);
    },
  });
  const read=()=>exported.cachedMarketInput('shared','kind','source',60000,async()=>{calls++;return {value:3};},()=>{});
  assert.equal((await read()).value,1);
  record={...record,payload:{value:2}};assert.equal((await read()).value,2);
  now=1006;assert.equal((await read()).value,3);assert.equal(calls,1);
});

test('a verified-empty dividend reply cannot erase stored HK dividend history', async () => {
  const incidents=[];
  const prior=[
    { exDate:'2026-06-10', noticeDate:'2026-06-08', dps:0.46088, period:'2025末期', special:false, eventId:'hk00322:2026-06-10' },
    { exDate:'2025-09-11', noticeDate:'2025-08-29', dps:0.29, period:'2025中期', special:false, eventId:'hk00322:2025-09-11' },
  ];
  let record=null;
  const store={read:async()=>record,write:async value=>{record=value;return true;},incident:async(key,type,detail)=>{incidents.push({key,type,detail});}};
  const input=producer=>storedMarketInput('hk-dividend-events-v4:hk00322','hk-recent-dividend-events','eastmoney:test',-1000,producer,()=>{},store);
  // 首次落库两条派息历史
  const first=await input(async()=>prior);
  assert.equal(first.length,2);
  // 刷新时上游「确认无派息」返回空数组：历史必须保留，且记录一次来源收缩事件
  const second=await input(async()=>[]);
  assert.equal(second.length,2);
  assert.deepEqual(second.map(r=>r.exDate),['2025-09-11','2026-06-10']);
  assert.equal(second[1].dps,0.46088);
  assert.equal(incidents.length,1);
  assert.equal(incidents[0].type,'source_history_shrank');
  assert.deepEqual(incidents[0].detail.missingEvents,['hk00322:2026-06-10','hk00322:2025-09-11']);
  // 上游带回更薄的真实数据时同样只增不删
  const third=await input(async()=>[{ exDate:'2026-09-10', noticeDate:'2026-08-28', dps:0.29, period:'2026中期', special:false, eventId:'hk00322:2026-09-10' }]);
  assert.equal(third.length,3);
  assert.deepEqual(third.map(r=>r.exDate),['2025-09-11','2026-06-10','2026-09-10']);
});
