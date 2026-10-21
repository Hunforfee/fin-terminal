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
      throw Error(name);
    },
  });
  const read=()=>exported.cachedMarketInput('shared','kind','source',60000,async()=>{calls++;return {value:3};},()=>{});
  assert.equal((await read()).value,1);
  record={...record,payload:{value:2}};assert.equal((await read()).value,2);
  now=1006;assert.equal((await read()).value,3);assert.equal(calls,1);
});
