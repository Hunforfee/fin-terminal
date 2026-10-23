import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from './load-modules.mjs';
const em=await load('datasource/eastmoneyStatements');
const {fetchStatementSourcePage,fetchCustomFinancials}=await load('datasource/sinaStatements');
const {fetchIndicatorSourceYear}=await load('datasource/sinaFinancial');
const {storedMarketInput}=await load('marketInputs');
const {marketRecord}=await load('marketStore');
const {clearCache}=await load('datasource/cache');
const {UpstreamBudget}=await load('upstreamBudget');
const {withUpstreamBudget}=await load('marketUpdateContext');
const {retainMarketPayload}=await load('marketRetention');
const {marketSourceCooldown}=await load('datasource/sourceCooldown');
const now=Date.parse('2026-10-23T04:00:00Z');
const row=(code='600519',market='SH')=>({SECUCODE:`${code}.${market}`,SECURITY_CODE:code,CURRENCY:'CNY',
  REPORT_DATE:'2025-03-31 00:00:00',NOTICE_DATE:'2025-04-20 00:00:00',UPDATE_DATE:'2026-04-20 00:00:00',
  PARENT_NETPROFIT:123456789,NETPROFIT:124000000,BASIC_EPS:1.234,DILUTED_EPS:1.2,
  TOTAL_PARENT_EQUITY:300000000,TOTAL_ASSETS:500000000,TOTAL_LIABILITIES:200000000,SHARE_CAPITAL:200000000,
  NETCASH_OPERATE:0,BPS:3,MGJYXJJE:0,MGWFPLR:1.5,ZCFZL:40,XSJLL:20,LD:1.8,SD:null,ROEJQ:8,EPSXS:1.2});
const memory=()=>{const rows=new Map();return {rows,read:async k=>structuredClone(rows.get(k)??null),
  write:async(r,expected)=>{if((rows.get(r.key)?.digest??null)!==expected)return false;rows.set(r.key,structuredClone(r));return true;},incident:async()=>{}};};
const restoreEnv=values=>{for(const [k,v] of Object.entries(values))if(v===undefined)delete process.env[k];else process.env[k]=v;};
async function networkFixture(run,primaryStatus=200){
  const original=globalThis.fetch,env=Object.fromEntries(['MARKET_READ_MODE','MARKET_DATA_STORE','MARKET_DATA_MODE'].map(k=>[k,process.env[k]]));
  process.env.MARKET_DATA_STORE='off';delete process.env.MARKET_READ_MODE;delete process.env.MARKET_DATA_MODE;clearCache();marketSourceCooldown.clear();
  const calls=[];
  globalThis.fetch=async raw=>{
    const url=new URL(String(raw));calls.push(url);
    if(url.hostname==='money.finance.sina.com.cn')return new Response('empty',{status:primaryStatus});
    assert.equal(url.hostname,'datacenter.eastmoney.com');
    const [,code,market]=url.searchParams.get('filter').match(/SECUCODE="(\d+)\.(SH|SZ|BJ)"/);
    return Response.json({success:true,result:{data:[row(code,market)],pages:1}});
  };
  try{return await run(calls);}finally{globalThis.fetch=original;restoreEnv(env);clearCache();marketSourceCooldown.clear();}
}

test('fallback keeps CNY amounts, real zero cash flows and per-share units distinct',()=>{
  const pl=em.parseEastmoneyStatement([row()],'600519','profit',2025,now);
  assert.equal(pl.rows.find(r=>r.name==='归属于母公司所有者的净利润').vals[0],'12345.6789');
  assert.equal(pl.rows.find(r=>r.name==='基本每股收益(元)').vals[0],'1.234');
  assert.equal(pl.rows.find(r=>r.name==='稀释每股收益(元)').vals[0],'1.2');
  assert.equal(em.parseEastmoneyStatement([row()],'600519','cashflow',2025,now).rows[0].vals[0],'0');
  const bs=em.parseEastmoneyStatement([row()],'600519','balance',2025,now);
  assert.equal(bs.rows.find(r=>r.name==='实收资本(或股本)').vals[0],'20000');
  assert.equal(bs.rows.some(r=>/股数|每股面值/.test(r.name)),false,'capital is never invented actual shares');
  assert.equal(pl.announceDates,undefined,'current NOTICE_DATE / UPDATE_DATE are not proof of first publication');
  assert.match(em.financialPageSource(pl),/^eastmoney:/);
  assert.equal(pl.sourceEvidence.eastmoney.rows[0].UPDATE_DATE,row().UPDATE_DATE);
});
test('wrong security/currency, future dates, duplicate quarters and malformed amounts are rejected',()=>{
  for(const patch of [{SECUCODE:'000001.SZ'},{SECURITY_CODE:'000001'},{CURRENCY:'HKD'},
    {REPORT_DATE:'2024-03-31'},{REPORT_DATE:'2025-02-30'},{NOTICE_DATE:'2027-01-01'},{PARENT_NETPROFIT:'bad'}])
    assert.throws(()=>em.parseEastmoneyStatement([{...row(),...patch}],'600519','profit',2025,now));
  assert.throws(()=>em.parseEastmoneyStatement([row(),row()],'600519','profit',2025,now),/重复/);
});
test('indicator fallback preserves missing values and does not replace ROE/ROA/EPS with different definitions',()=>{
  const page=em.parseEastmoneyIndicators([row()],'600519',2025,now);
  assert.equal(page.rows.get('每股经营性现金流(元)')[0],'0');
  assert.equal(page.rows.has('速动比率'),false);
  for(const name of ['净资产收益率(%)','资产报酬率(%)','摊薄每股收益(元)'])assert.equal(page.rows.has(name),false);
  assert.equal(page.rows.get('资产负债率(%)')[0],'40');
});
test('every mainland exchange uses the same fallback, with no sample-stock whitelist',()=>networkFixture(async calls=>{
  for(const code of ['600519','000001','920799']){
    const pl=await fetchStatementSourcePage(code,'profit',2025);
    assert.equal(pl.rows.find(r=>r.name==='归属于母公司所有者的净利润').vals[0],'12345.6789');
    assert.match(em.financialPageSource(pl),/^eastmoney:/);
  }
  assert.equal(calls.filter(u=>u.hostname==='datacenter.eastmoney.com').length,3);
  assert.ok(calls.every(u=>!u.hostname.includes('mcp')));
}));
test('a valid Sina page is reused without requesting a backup provider',()=>networkFixture(async calls=>{
  const original=globalThis.fetch;let count=0;
  globalThis.fetch=async url=>{
    count++;assert.equal(new URL(String(url)).hostname,'money.finance.sina.com.cn');
    // A genuinely usable balance sheet includes its required financial inputs.
    return new Response(Buffer.from('3c74723e3c74643eb1a8b1edc8d5c6da3c2f74643e3c74643e323032352d30332d33313c2f74643e3c2f74723e3c74723e3c7464207374796c653d2270616464696e672d6c6566743a33307078223ed7cab2fad7dcbcc63c2f74643e3c74643e31303c2f74643e3c2f74723e3c74723e3c7464207374796c653d2270616464696e672d6c6566743a33307078223eb8bad5aebacfbcc63c2f74643e3c74643e343c2f74643e3c2f74723e3c74723e3c7464207374796c653d2270616464696e672d6c6566743a33307078223eb9e9caf4d3dac4b8b9abcbbeb9c9b6abc8a8d2e6bacfbcc63c2f74643e3c74643e363c2f74643e3c2f74723e','hex'));
  };
  try{
    const value=await fetchStatementSourcePage('600519','balance',2025);
    assert.equal(value.rows[0].vals[0],'10');assert.match(em.financialPageSource(value),/^sina:/);
    await fetchStatementSourcePage('600519','balance',2025);assert.equal(count,1);
  }finally{globalThis.fetch=original;}
}));
test('custom financial API exposes the real fallback contributor instead of a Sina-only label',()=>networkFixture(async()=>{
  const value=await fetchCustomFinancials('600519',['pl_归属于母公司所有者的净利润'],1);
  assert.match(value.source,/eastmoney:/);assert.equal(value.source.includes('sina-statements'),false);
  assert.equal(value.series['pl_归属于母公司所有者的净利润'][0],12345.6789);
}));
test('empty general-industry financials try verified bank/securities/insurance tables, never a different stock',async()=>{
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async raw=>{
    const url=new URL(String(raw)),report=url.searchParams.get('reportName');calls.push(report);
    assert.match(url.searchParams.get('filter'),/600036.SH/);
    return Response.json(report==='RPT_F10_FINANCE_BBALANCE'
      ? {success:true,result:{data:[row('600036','SH')],pages:1}}
      : {success:false,message:'返回数据为空',result:null});
  };
  try{
    const value=await em.fetchEastmoneyStatement('600036','balance',2025);
    assert.deepEqual(calls,['RPT_F10_FINANCE_GBALANCE','RPT_F10_FINANCE_BBALANCE']);
    assert.equal(value.sourceEvidence.eastmoney.reportName,'RPT_F10_FINANCE_BBALANCE');
    calls.length=0;await em.fetchEastmoneyStatement('600036','balance',2025);
    assert.deepEqual(calls,['RPT_F10_FINANCE_BBALANCE'],'reuse only the verified sector hint');
  }finally{globalThis.fetch=original;}
});
for(const status of [403,429])test(`Sina HTTP ${status} does not prevent all four Eastmoney fallback reports`,()=>networkFixture(async calls=>{
  const budget=new UpstreamBudget(new AbortController().signal,0,15);
  await withUpstreamBudget(budget,async()=>{
    for(const id of ['balance','profit','cashflow'])await fetchStatementSourcePage('600519',id,2025);
    assert.equal((await fetchIndicatorSourceYear('600519',2025)).rows.get('每股净资产_调整前(元)')[0],'3');
  });
  assert.equal(calls.filter(u=>u.hostname==='money.finance.sina.com.cn').length,1);
  assert.equal(calls.filter(u=>u.hostname==='datacenter.eastmoney.com').length,4);
  assert.equal(budget.limited,false);assert.equal(budget.rateLimited,true);
},status));
test('partial cross-provider refresh retains cells with their actual source, including explicit zero',async()=>{
  const store=memory(),key='source-sina-page:v1:600519:balance:2025';
  const prior={dates:['2025-03-31'],unit:'wan',rows:[{kind:'field',name:'资产总计',vals:['100']},{kind:'field',name:'短期借款',vals:['5']}]};
  await store.write(marketRecord(key,'source-sina-page','qmt',prior,1,now),null);
  const next=em.parseEastmoneyStatement([{...row(),TOTAL_ASSETS:null,SHORT_LOAN:0}],'600519','balance',2025,now);
  const value=await storedMarketInput(key,'source-sina-page','public',1000,async()=>next,()=>{},store,now+1000,em.financialPageSource);
  assert.equal(value.rows.find(r=>r.name==='资产总计').vals[0],'100');
  assert.equal(value.rows.find(r=>r.name==='短期借款').vals[0],'0');
  assert.equal(value.fieldSources['资产总计'][0],'qmt');assert.match(value.fieldSources['短期借款'][0],/^eastmoney:/);
  assert.match((await store.read(key)).source,/eastmoney:.* \+ qmt/);
});
test('indicator fallback matrix retains existing ROE and is readable with zero network in database mode',async()=>{
  const store=memory(),key='source-sina-indicators:v1:600519:2025';
  await store.write(marketRecord(key,'source-sina-indicators','sina',{
    dates:['2025-03-31'],rows:{$marketMap:[['净资产收益率(%)',['9']]]}},1,now),null);
  const next=em.parseEastmoneyIndicators([row()],'600519',2025,now);
  const value=await storedMarketInput(key,'source-sina-indicators','public',1000,async()=>next,()=>{},store,now+1000,em.financialPageSource);
  assert.equal(value.rows.get('净资产收益率(%)')[0],'9');assert.equal(value.fieldSources['净资产收益率(%)'][0],'sina');
  const env=process.env.MARKET_READ_MODE;process.env.MARKET_READ_MODE='database';
  try{
    const saved=await storedMarketInput(key,'source-sina-indicators','public',1,()=>{throw Error('network forbidden');},()=>{},store,now+5000);
    assert.equal(saved.rows.get('每股净资产_调整前(元)')[0],'3');
  }finally{restoreEnv({MARKET_READ_MODE:env});}
});
test('cell provenance stays aligned when retention removes old report columns without changing retention years',()=>{
  const page={dates:['2025-03-31','2000-03-31'],unit:'wan',rows:[{kind:'field',name:'资产总计',vals:['1','2']}],fieldSources:{资产总计:['eastmoney','sina']}};
  const result=retainMarketPayload('source-sina-page',page,now);
  assert.deepEqual(result.dates,['2025-03-31']);assert.deepEqual(result.fieldSources['资产总计'],['eastmoney']);
});
