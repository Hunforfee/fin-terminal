import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {load} from './load-modules.mjs';
const {parseEastmoneyShareHistory,fetchEastmoneyShareHistory}=await load('datasource/eastmoneyCapital');
const {parseEastmoneyImplementedDividends}=await load('datasource/eastmoneyBonus');
const {fetchShareHistory}=await load('datasource/sinaFinance');
const {fetchDividends}=await load('datasource/sinaBonus');
const {fetchDividendPlans}=await load('datasource/dividendPlans');
const {getValuationDividends}=await load('valuationInputs');
const {SourceCooldown,marketSourceCooldown}=await load('datasource/sourceCooldown');
const {fetchText}=await load('datasource/http');
const {withUpstreamBudget}=await load('marketUpdateContext');
const {UpstreamBudget}=await load('upstreamBudget');
const {storedMarketInput}=await load('marketInputs');
const {marketRecord}=await load('marketStore');
const {clearCache}=await load('datasource/cache');
const now=Date.parse('2026-10-23T02:00:00Z');
const equity=(code='600519',market='SH')=>({SECUCODE:`${code}.${market}`,SECURITY_CODE:code,END_DATE:'2025-06-18',
  NOTICE_DATE:'2025-06-17',TOTAL_SHARES:1250081601,SHARE_CAPITAL:1,INFO_CODE:'AN20250617000001'});
const bonus=(code='600519',market='SH')=>({SECUCODE:`${code}.${market}`,SECURITY_CODE:code,REPORT_DATE:'2024-12-31',
  PLAN_NOTICE_DATE:'2025-04-01',NOTICE_DATE:'2025-06-10',EX_DIVIDEND_DATE:'2025-06-18',
  ASSIGN_PROGRESS:'实施分配',PRETAX_BONUS_RMB:10.125,BONUS_IT_RATIO:null,BONUS_RATIO:null,IT_RATIO:null,IMPL_PLAN_PROFILE:'10派10.125元(含税)'});
afterEach(()=>{clearCache();marketSourceCooldown.clear();});
async function fixture(run){
  const original=globalThis.fetch,env=Object.fromEntries(['MARKET_DATA_STORE','MARKET_READ_MODE','MARKET_DATA_MODE'].map(k=>[k,process.env[k]])),calls=[];
  process.env.MARKET_DATA_STORE='off';delete process.env.MARKET_READ_MODE;delete process.env.MARKET_DATA_MODE;
  clearCache();marketSourceCooldown.clear();
  globalThis.fetch=async raw=>{
    const u=new URL(String(raw));calls.push(u);
    if(u.hostname==='money.finance.sina.com.cn')return new Response('limited',{status:429});
    const report=u.searchParams.get('reportName'),filter=u.searchParams.get('filter');
    const code=filter.match(/(?:SECURITY_CODE|SECUCODE)="(\d+)/)[1],market=code.startsWith('6')?'SH':code.startsWith('92')?'BJ':'SZ';
    const rows=report==='RPT_F10_EH_EQUITY'?[equity(code,market)]:[bonus(code,market)];
    return Response.json({success:true,result:{data:rows,pages:1,count:1}});
  };
  try{return await run(calls);}finally{globalThis.fetch=original;for(const [k,v] of Object.entries(env))if(v===undefined)delete process.env[k];else process.env[k]=v;}
}
test('capital uses integer share quantities, effective dates and disclosed identity across all mainland exchanges',()=>{
  for(const [code,market] of [['600519','SH'],['000001','SZ'],['920799','BJ']]){
    const result=parseEastmoneyShareHistory([equity(code,market)],code,now)[0];
    assert.equal(result.sharesWan,125008.1601);assert.equal(result.date,'2025-06-18');assert.equal(result.source,'eastmoney-equity');
    assert.equal(result.noticeDate,'2025-06-17');assert.equal(result.reference,'AN20250617000001');
  }
});
test('share evidence rejects wrong issuers, fractions, capital-only values and conflicting same-day quantities',()=>{
  for(const patch of [{SECUCODE:'000001.SZ'},{TOTAL_SHARES:1.5},{TOTAL_SHARES:null},{END_DATE:'2025-02-30'}])
    assert.throws(()=>parseEastmoneyShareHistory([{...equity(),...patch}],'600519',now));
  assert.throws(()=>parseEastmoneyShareHistory([equity(),{...equity(),TOTAL_SHARES:1250081602}],'600519',now),/冲突/);
  assert.equal(parseEastmoneyShareHistory([equity(),{...equity(),END_DATE:'2027-01-01'}],'600519',now).length,1);
});
test('both share history and implemented cash dividends continue after Sina is limited',()=>fixture(async calls=>{
  const budget=new UpstreamBudget(new AbortController().signal,0,12);
  await withUpstreamBudget(budget,async()=>{
    for(const code of ['600519','000001','920799']){
      assert.equal((await fetchShareHistory(code))[0].source,'eastmoney-equity');
      const dividends=await fetchDividends(code);assert.equal(dividends[0].perShare,1.0125);
      assert.equal(dividends[0].cashSource,'eastmoney-implemented');
    }
  });
  assert.equal(calls.filter(u=>u.hostname==='money.finance.sina.com.cn').length,1);assert.equal(budget.limited,false);
}));
test('proposal and implementation readers coalesce the same public response without treating a proposal as paid cash',()=>fixture(async calls=>{
  const [events,plans]=await Promise.all([getValuationDividends('600519'),fetchDividendPlans('600519')]);
  assert.equal(events[0].cashSource,'eastmoney-implemented');assert.equal(plans[0].implemented,true);
  assert.equal(calls.filter(u=>u.hostname==='datacenter-web.eastmoney.com').length,1);
}));
test('only already disclosed implemented events enter cash sums; future, cancelled and proposed records are excluded',()=>{
  const result=parseEastmoneyImplementedDividends([bonus(),{...bonus(),REPORT_DATE:'2025-06-30',ASSIGN_PROGRESS:'董事会预案'},
    {...bonus(),REPORT_DATE:'2025-09-30',EX_DIVIDEND_DATE:'2027-01-01'}],'600519',now);
  assert.equal(result.length,1);assert.equal(result[0].perShare,1.0125);assert.equal(result[0].perShareStock,0);
  assert.equal(result[0].implementationEvidence[0].noticeDate,'2025-06-10');
  assert.equal(parseEastmoneyImplementedDividends([{...bonus(),ASSIGN_PROGRESS:'取消分配'}],'600519',now).length,0);
  assert.throws(()=>parseEastmoneyImplementedDividends([{...bonus(),PRETAX_BONUS_RMB:null}],'600519',now),/金额/);
  assert.throws(()=>parseEastmoneyImplementedDividends([{...bonus(),NOTICE_DATE:'2025-06-20'}],'600519',now),/晚于除息/);
});
test('explicit pure stock distributions have zero cash, split factors and fine precision are preserved',()=>{
  const [stock]=parseEastmoneyImplementedDividends([{...bonus(),PRETAX_BONUS_RMB:null,IMPL_PLAN_PROFILE:'10送3转增5'}],'600519',now);
  assert.equal(stock.perShare,0);assert.equal(stock.perShareStock,.8);
  const [cash]=parseEastmoneyImplementedDividends([{...bonus(),PRETAX_BONUS_RMB:1e-7}],'600519',now);
  assert.equal(cash.perShare,1e-8);assert.equal(cash.precisionPerShare,1e-8);
  assert.throws(()=>parseEastmoneyImplementedDividends([bonus(),{...bonus(),PRETAX_BONUS_RMB:20}],'600519',now),/冲突/);
});
test('share pagination must be stable and complete, with no repeated pages silently accepted',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({success:true,result:{data:[equity()],pages:2,count:2}});
  try{await assert.rejects(fetchEastmoneyShareHistory('600519'),/重复/);}finally{globalThis.fetch=original;}
});
test('source cooldown respects Retry-After, expires, and never blocks another host',()=>{
  let clock=now;const breaker=new SourceCooldown(()=>clock,2);
  breaker.observe('https://one.test/a',429,'12');
  assert.equal(breaker.active('https://one.test/b').until,now+12000);assert.equal(breaker.active('https://two.test/a'),null);
  breaker.succeeded('https://one.test/earlier');assert.ok(breaker.active('https://one.test/a'),'an older successful request cannot clear an active limiter');
  clock+=12001;assert.equal(breaker.active('https://one.test/a'),null);
  breaker.failed('https://one.test/a');breaker.failed('https://one.test/b');assert.equal(breaker.active('https://one.test/a').status,0);
  breaker.observe('https://two.test/a',403);breaker.observe('https://three.test/a',429);assert.equal(breaker.active('https://one.test/a'),null,'state capacity is bounded');
});
test('HTTP cooldown is shared across budgets, without retrying a limited host or bypassing read-only policy',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async url=>{calls++;return new Response('ok',{status:String(url).includes('one.test')?429:200,headers:{'retry-after':'60'}});};
  try{
    await assert.rejects(fetchText('https://one.test/a',{retries:3}),/429/);
    const budget=new UpstreamBudget(new AbortController().signal,0);
    await withUpstreamBudget(budget,async()=>{
      await assert.rejects(fetchText('https://one.test/b',{retries:0}),/冷却/);assert.equal(budget.rateLimited,true);
      assert.equal(await fetchText('https://two.test/b',{retries:0}),'ok');
    });
    assert.equal(calls,2);
    await withUpstreamBudget(new UpstreamBudget(new AbortController().signal,0,5,true),()=>assert.rejects(fetchText('https://two.test/b'),/尚未入库/));
    assert.equal(calls,2);
  }finally{globalThis.fetch=original;}
});
test('two connection failures open a short circuit, while caller cancellation sends no request',async()=>{
  const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('socket reset');};
  try{
    for(let i=0;i<2;i++)await assert.rejects(fetchText('https://offline.test/a',{retries:0}));
    await assert.rejects(fetchText('https://offline.test/b',{retries:0}),/暂时不可用/);assert.equal(calls,2);
    const abort=new AbortController();abort.abort(Error('cancelled'));
    await withUpstreamBudget(new UpstreamBudget(abort.signal,0),()=>assert.rejects(fetchText('https://other.test/a'),/cancelled/));assert.equal(calls,2);
  }finally{globalThis.fetch=original;}
});
test('thinner dividend refresh keeps older evidence and rejects conflicting cash before any write',async()=>{
  const data=new Map(),store={read:async k=>structuredClone(data.get(k)??null),write:async r=>{data.set(r.key,structuredClone(r));return true;},incident:async()=>{}};
  const key='implemented-dividends-v4:600519',prior=[{exDate:'2024-06-18',perShare:1,perShareStock:0},{exDate:'2025-06-18',perShare:1.0125,perShareStock:0}];
  data.set(key,marketRecord(key,'implemented-dividends','verified-import',prior,1,now));
  const value=await storedMarketInput(key,'implemented-dividends','backup',1,async()=>[prior[1]],()=>{},store,now+1000);
  assert.equal(value.length,2);
  const digest=data.get(key).digest;
  await assert.rejects(storedMarketInput(key,'implemented-dividends','backup',1,async()=>[{...prior[1],perShare:2}],()=>{},store,now+2000),/来源冲突/);
  assert.equal(data.get(key).digest,digest);
});
