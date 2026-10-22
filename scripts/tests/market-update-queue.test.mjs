import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from './load-modules.mjs';
const {MarketUpdateQueue,updateSymbols}=await load('marketUpdateQueue');
const {appendRunLog,getRunLog}=await load('marketUpdateRunLog');
const {UpstreamBudget}=await load('upstreamBudget');
const {withUpstreamBudget}=await load('marketUpdateContext');
const {fetchText}=await load('datasource/http');
const memory=()=>{const rows=new Map();return {read:async(key)=>rows.has(key)?structuredClone(rows.get(key)):null,write:async(r,expected)=>{if((rows.get(r.key)?.digest??null)!==expected)return false;rows.set(r.key,structuredClone(r));return true;},incident:async()=>{}};};
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

test('cancel stops queued work and drops an in-flight phase result',async()=>{
  const f=fixture(),q=new MarketUpdateQueue(f.store,f.clock);
  await q.submit('one',['600519','300498','hk00700']);
  const t=await q.claim();
  const stopped=await q.cancel('one');
  assert.ok(stopped);assert.equal(stopped.finished,true);
  assert.equal(stopped.errors.filter(e=>e.message==='已手动停止').length,3);
  assert.equal(await q.claim(),null,'停止后不应再有可领取任务');
  assert.equal(await q.finish(t.symbol,t.lease),false,'在飞阶段的结果必须被丢弃');
  const status=await q.status('one');assert.equal(status.finished,true);assert.equal(status.failed,3);
  f.advance(61000);
  const restarted=await q.submit('one',['600519']);assert.equal(restarted.waiting,1,'冷却一分钟后允许重新提交');
});
test('cancel only touches the requesting user and ignores idle owners',async()=>{
  const f=fixture(),q=new MarketUpdateQueue(f.store,f.clock);
  assert.equal(await q.cancel('nobody'),null);
  await q.submit('one',['600519']);
  assert.equal((await q.cancel('two')),null,'他人无法停止别人的任务');
  assert.equal((await q.status('one')).waiting,1);
});
test('intermediate phase failure is not cleared when the final gate passes',async()=>{
  const f=fixture(),q=new MarketUpdateQueue(f.store,f.clock);
  await q.submit('one',['600519']);
  const t1=await q.claim();
  // 中途阶段（如当日抓取）失败但推进到末段
  await q.finish(t1.symbol,t1.lease,'近期价格未确认完整入库',false,t1.phase+1);
  f.advance(2000);
  const t2=await q.claim();
  assert.equal(t2.phaseErrors?.[String(t1.phase)],'近期价格未确认完整入库');
  // 末段校验通过（旧数据在库）也不得清成 done
  await q.finish(t2.symbol,t2.lease);
  const r=await q.status('one');
  assert.equal(r.done,0);assert.equal(r.failed,1);assert.equal(r.finished,true);
  assert.deepEqual(r.errors,[{symbol:'sh600519',message:'近期价格未确认完整入库'}]);
});
test('clean final gate pass with no earlier phase errors still marks done',async()=>{
  const f=fixture(),q=new MarketUpdateQueue(f.store,f.clock);
  await q.submit('one',['600519']);
  const t=await q.claim();
  await q.finish(t.symbol,t.lease);
  const r=await q.status('one');
  assert.equal(r.done,1);assert.equal(r.failed,0);assert.equal(r.errors.length,0);
});
test('finishing a job appends a run-log entry with mode, owner and reasons',async()=>{
  const f=fixture(),q=new MarketUpdateQueue(f.store,f.clock);
  await q.submit('one',['600519']);
  const t=await q.claim();
  await q.finish(t.symbol,t.lease);
  await new Promise(r=>setTimeout(r,10)); // recordRun 为即发即忘，等其落库
  const row=await f.store.read('market-update-run-log:v1');
  assert.equal(row?.payload?.runs?.length,1);
  const run=row.payload.runs[0];
  assert.equal(run.owner,'one');assert.equal(run.mode,'recent');
  assert.equal(run.done,1);assert.equal(run.failed,0);assert.equal(run.total,1);assert.deepEqual(run.errors,[]);
});
test('run-log keeps a bounded rolling window',async()=>{
  const f=fixture();
  for(let i=0;i<65;i++)await appendRunLog(f.store,{id:'r'+i,owner:'o',mode:'daily',startedAt:0,finishedAt:i,total:1,done:1,failed:0,errors:[]});
  const runs=await getRunLog(f.store);
  assert.equal(runs.length,60);
  assert.equal(runs[0].id,'r64');assert.equal(runs.at(-1).id,'r5');
});
test('systemCloseProgress aggregates only scheduled runs',async()=>{
  const f=fixture(),q=new MarketUpdateQueue(f.store,f.clock);
  assert.equal(await q.systemCloseProgress(),null);
  await q.submit('one',['600519'],false,'recent');
  assert.equal(await q.systemCloseProgress(),null,'普通用户任务不计入调度场进度');
  await q.submit('system:close:2026-10-22:0',['600519','300498','hk00700'],false,'daily');
  const live=await q.systemCloseProgress();
  assert.ok(live);assert.equal(live.active,true);assert.equal(live.total,3);
  assert.equal(live.mode,'daily');assert.equal(live.date,'2026-10-22');
  assert.equal(live.done+live.failed+live.running+live.waiting,3);
});
