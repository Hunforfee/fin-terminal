import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { load } from './load-modules.mjs';
const { searchSources } = await load('searchSources');
const { fetchSearchSuggestions } = await load('searchSuggestions');
const { fetchText } = await load('datasource/http');
const { marketSourceCooldown } = await load('datasource/sourceCooldown');
const hit = (code, kind='stock') => ({ code, kind, market:'A', name:code });

test('a fast source releases results and cancels a stalled mirror', async () => {
 let loser;
 const result = await searchSources([async()=>[hit('600011')], signal=>{loser=signal;return new Promise(()=>{});}], [], 1000, 5);
 assert.deepEqual(result,[hit('600011')]);assert.equal(loser.aborted,true);
});

test('an empty reply waits for useful results; near replies deduplicate by market and asset kind', async () => {
 const result = await searchSources([async()=>[],async()=>{await delay(10);return [hit('600011')];}],[],100,5);
 assert.deepEqual(result,[hit('600011')]);
 const merged = await searchSources([async()=>[hit('000001')],async()=>[hit('000001'),hit('000001','index')]],[],100,5);
 assert.equal(merged.length,2);assert.equal(merged[1].kind,'index');
});

test('all failures or a stalled search end with a retryable error, while genuine empty responses remain empty', async () => {
 await assert.rejects(searchSources([async()=>{throw Error('network');}],[],100,5),/重试/);
 let signal;
 await assert.rejects(searchSources([s=>{signal=s;return new Promise(()=>{});}],[],15,5),/重试/);
 assert.equal(signal.aborted,true);
 assert.deepEqual(await searchSources([async()=>[]],[],100,5),[]);
});

test('browser search caches normalized successes, retries failures, and exposes a bounded timeout', async () => {
 const original=globalThis.fetch;
 let calls=0;
 try {
  globalThis.fetch=async()=>{calls++;return Response.json({ok:true,data:[hit('600011')]});};
  const signal=new AbortController().signal;
  assert.deepEqual(await fetchSearchSuggestions(' HNGJ ',signal),[hit('600011')]);
  assert.deepEqual(await fetchSearchSuggestions('hngj',signal),[hit('600011')]);assert.equal(calls,1);
  globalThis.fetch=async()=>{calls++;return Response.json({ok:false},{status:503});};
  await assert.rejects(fetchSearchSuggestions('retry-unique',signal),/重试/);
  globalThis.fetch=async()=>{calls++;return Response.json({ok:true,data:[hit('600011')]});};
  assert.equal((await fetchSearchSuggestions('retry-unique',signal)).length,1);assert.equal(calls,3);
  globalThis.fetch=async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  // AbortSignal.timeout timers are unref'ed; keep this isolated test alive.
  const keepingAlive=setTimeout(()=>{},1000);
  try {await assert.rejects(fetchSearchSuggestions('timeout-unique',signal,10),/搜索超时/);}finally{clearTimeout(keepingAlive);}
  const controller=new AbortController();
  const pending=fetchSearchSuggestions('cancel-unique',controller.signal);controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
 }finally{globalThis.fetch=original;}
});

test('cancelling autocomplete neither retries nor trips the shared source circuit', async () => {
 const original=globalThis.fetch;
 const url='https://autocomplete-cancellation.test/query';let calls=0;
 try {
  globalThis.fetch=async(_url,{signal})=>{calls++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  for(let i=0;i<3;i++){
   const controller=new AbortController();
   const pending=fetchText(url,{signal:controller.signal,retries:2});
   await delay(1);controller.abort();await assert.rejects(pending);
  }
  assert.equal(calls,3);assert.equal(marketSourceCooldown.active(url),null);
 }finally{globalThis.fetch=original;marketSourceCooldown.clear();}
});
