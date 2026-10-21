import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from './load-modules.mjs';
const {MarketUpdateQueue,updateSymbols}=await load('marketUpdateQueue');
const {UpstreamBudget}=await load('upstreamBudget');
const {withUpstreamBudget}=await load('marketUpdateContext');
const {fetchText}=await load('datasource/http');
const memory=()=>{let saved=null;return {read:async()=>structuredClone(saved),write:async(r,expected)=>{if((saved?.digest??null)!==expected)return false;saved=structuredClone(r);return true;},incident:async()=>{}};};
const fixture=()=>{let now=1800000000000;const store=memory();return {store,clock:()=>now,advance:n=>now+=n};};

test('normalizes stock symbols, deduplicates and bounds submitted scope',()=>{
  assert.deepEqual(updateSymbols(['600519','sh600519','00700']),['hk00700','sh600519']);
  for(const value of [[],Array(1001).fill('600519'),['invalid'],['sh000300'],null])assert.throws(()=>updateSymbols(value));
});
test('different users share one stock task and the global worker lease',async()=>{
  const f=fixture(),a=new MarketUpdateQueue(f.store,f.clock),b=new MarketUpdateQueue(f.store,f.clock);
  await Promise.all([a.submit('one',['600519']),b.submit('two',['600519'])]);
  const tasks=await Promise.all([a.claim(),b.claim()]);assert.equal(tasks.filter(Boolean).length,1);
  const task=tasks.find(Boolean);await a.finish(task.symbol,task.lease);
  assert.equal((await b.status('two')).done,1);assert.equal((await a.status('one')).done,1);
  assert.equal(await a.status('other'),null);
});
test('a second group click returns the user active task without appending work',async()=>{
  const f=fixture(),q=new MarketUpdateQueue(f.store,f.clock);
  const first=await q.submit('one',['600519']);const second=await q.submit('one',['300498']);
  assert.equal(first.id,second.id);assert.equal(second.total,1);
});
test('fresh completions are skipped, and old completed results stay immutable',async()=>{
  const f=fixture(),q=new MarketUpdateQueue(f.store,f.clock);
  await q.submit('one',['600519']);let t=await q.claim();await q.finish(t.symbol,t.lease);
  f.advance(61000);let next=await q.submit('two',['600519']);assert.equal(next.skipped,1);assert.equal(next.finished,true);
  f.advance(11*60e3);await q.submit('three',['600519']);assert.equal((await q.status('one')).done,1);
  t=await q.claim();assert.ok(t);assert.equal((await q.status('one')).finished,true);
});
test('lease expiry recovers work and rejects a late result from the old worker',async()=>{
  const f=fixture(),a=new MarketUpdateQueue(f.store,f.clock),b=new MarketUpdateQueue(f.store,f.clock);
  await a.submit('one',['600519']);const old=await a.claim();
  f.advance(6*60e3);assert.equal(await b.claim(),null);f.advance(61000);const current=await b.claim();assert.ok(current);
  assert.equal(await a.finish(old.symbol,old.lease),false);assert.equal(await b.renew(current.symbol,current.lease),true);
  await b.finish(current.symbol,current.lease);assert.equal((await a.status('one')).done,1);
});
test('rate limits open a global circuit and retries are capped at three',async()=>{
  const f=fixture(),q=new MarketUpdateQueue(f.store,f.clock);
  await q.submit('one',['600519','300498']);const t=await q.claim();await q.finish(t.symbol,t.lease,'limited',true);
  assert.equal(await q.claim(),null);assert.ok((await q.status('one')).pausedUntil>f.clock());
  f.advance(6*60e3);
  for(let i=0;i<6;i++){const task=await q.claim();if(task)await q.finish(task.symbol,task.lease,'failed');f.advance(16*60e3);}
  const result=await q.status('one');assert.equal(result.failed,2);assert.equal(result.finished,true);
  f.advance(61000);const retried=await q.submit('one',result.errors.map(e=>e.symbol),true);assert.equal(retried.waiting,2);
  await assert.rejects(q.submit('unknown',['600519'],true),/只能重试/);
});
test('queue state survives a fresh adapter and per-user result is private',async()=>{
  const f=fixture();await new MarketUpdateQueue(f.store,f.clock).submit('one',['600519']);
  const resumed=new MarketUpdateQueue(f.store,f.clock);assert.equal((await resumed.status('one')).waiting,1);assert.equal(await resumed.status('two'),null);
});
test('HTTP budget serializes actual upstream requests and stops at first limiter response',async()=>{
  const original=globalThis.fetch;let active=0,maxActive=0,calls=0;
  globalThis.fetch=async()=>{calls++;active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,5));active--;return new Response('ok');};
  try {
    await withUpstreamBudget(new UpstreamBudget(new AbortController().signal,1),()=>Promise.all([fetchText('https://one.test'),fetchText('https://two.test')]));
    assert.equal(maxActive,1);assert.equal(calls,2);
    globalThis.fetch=async()=>{calls++;return new Response('limited',{status:429});};
    const budget=new UpstreamBudget(new AbortController().signal,1);
    await withUpstreamBudget(budget,async()=>{await assert.rejects(fetchText('https://one.test',{retries:0}));await assert.rejects(fetchText('https://two.test',{retries:0}),/限流/);});
    assert.equal(calls,3);assert.equal(budget.limited,true);
  }finally{globalThis.fetch=original;}
});
test('foreground browsing does not inherit a background limiter',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response('ok');};
  try {
    const limited=new UpstreamBudget(new AbortController().signal,1);limited.observe(429);
    await Promise.all([withUpstreamBudget(limited,()=>assert.rejects(fetchText('https://background.test',{retries:0}),/限流/)),
      fetchText('https://foreground.test',{retries:0}).then(value=>assert.equal(value,'ok'))]);
    assert.equal(calls,1);
  }finally{globalThis.fetch=original;}
});
test('one challenged mirror is not retried, while existing alternate mirrors remain usable',async()=>{
  const original=globalThis.fetch;const calls=[];
  globalThis.fetch=async url=>{calls.push(String(url));return new Response('body',{status:String(url).includes('blocked.test')?501:200});};
  try{
    const budget=new UpstreamBudget(new AbortController().signal,1);
    await withUpstreamBudget(budget,async()=>{
      await assert.rejects(fetchText('https://blocked.test/prices',{retries:1}));
      assert.equal(await fetchText('https://alternate.test/prices',{retries:0}),'body');
    });
    assert.equal(budget.limited,false);assert.deepEqual(calls,['https://blocked.test/prices','https://alternate.test/prices']);
  }finally{globalThis.fetch=original;}
});
