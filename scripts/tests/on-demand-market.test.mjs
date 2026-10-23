import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from './load-modules.mjs';
const {storedMarketInput}=await load('marketInputs');
const {withMarketReadStatus}=await load('marketReadContext');
const {marketRecord}=await load('marketStore');
const {withUpstreamBudget}=await load('marketUpdateContext');
const {UpstreamBudget}=await load('upstreamBudget');
const {sharedQuotes}=await load('quoteInputs');
const {storedScreenFinancials}=await load('screenFinancialStorage');
const {cached,clearCache}=await load('datasource/cache');
const {storedKLine}=await load('klineStorage');
const {cachedValuationResult}=await load('valuationResultCache');
const {importDisclosureDates,importAIndicators}=await load('marketAImportRecords');
const now=Date.parse('2026-10-23T04:00:00Z');
function memory(){const rows=new Map();return {rows,read:async key=>structuredClone(rows.get(key)??null),
  write:async(row,expected)=>{if((rows.get(row.key)?.digest??null)!==expected)return false;rows.set(row.key,structuredClone(row));return true;},
  incident:async()=>{},remove:async(key,digest)=>rows.get(key)?.digest===digest&&rows.delete(key)};}
const fail=async()=>{throw Error('source offline');};
const validate=v=>{assert.ok(Array.isArray(v)&&v.length&&Number.isFinite(v[0].amount));};
async function seed(store,key,payload,kind='financial-input'){await store.write(marketRecord(key,kind,'verified-provider',payload,1,now),null);}

test('outage fallback retains saved timestamp/digest; separate requests do not inherit warnings',async()=>{
  const s=memory();await seed(s,'saved',[{date:'2026-06-30',amount:10}]);
  const old=await s.read('saved');
  const read=()=>storedMarketInput('saved','financial-input','source',1000,fail,validate,s,now+100);
  const saved=await withMarketReadStatus(async()=>({rows:await read()}));
  assert.equal(saved.stale,true);assert.equal(saved.rows[0].amount,10);
  assert.equal(saved.dataStatus.snapshots[0].acquiredAt,old.acquiredAt);
  assert.equal((await s.read('saved')).digest,old.digest);assert.equal((await s.read('saved')).refreshAfter,old.refreshAfter);
  assert.deepEqual(await withMarketReadStatus(async()=>({fresh:true})),{fresh:true});
});

test('coalesced readers both receive fallback provenance while unrelated concurrent reads stay fresh',async()=>{
  const s=memory();await seed(s,'same',[{amount:10}]);let calls=0;
  const read=()=>withMarketReadStatus(async()=>({rows:await storedMarketInput('same','financial-input','source',1,async()=>{calls++;await new Promise(r=>setTimeout(r,5));throw Error('offline');},validate,s,now+100)}));
  const [a,b,c]=await Promise.all([read(),read(),withMarketReadStatus(async()=>({fresh:true}))]);
  assert.equal(calls,1);for(const v of [a,b]){assert.equal(v.stale,true);assert.equal(v.dataStatus.snapshots.length,1);}
  assert.equal(c.stale,undefined);
});

test('source outage on a cold input is an error; invalid current data does not replace valid history',async()=>{
  const s=memory();await assert.rejects(storedMarketInput('cold','financial-input','source',1,fail,validate,s,now),/offline/);
  await seed(s,'known',[{amount:10}]);const old=await s.read('known');
  await assert.rejects(storedMarketInput('known','financial-input','source',1,async()=>[{amount:NaN}],validate,s,now+100),/assert|false|finite/i);
  assert.equal((await s.read('known')).digest,old.digest);
});

test('background collectors cannot report a failed source as a successful saved-input collection',async()=>{
  const s=memory();await seed(s,'collect',[{amount:10}]);
  await assert.rejects(withUpstreamBudget(new UpstreamBudget(new AbortController().signal,0,10),()=>
    storedMarketInput('collect','financial-input','source',1,fail,validate,s,now+100)),/offline/);
});

test('complete old annual pages are reused; force refresh still checks corrected disclosures',async()=>{
  const s=memory(),key='source-sina-page:v1:603599:profit:2024';
  const page={unit:'wan',dates:['2024-03-31','2024-06-30','2024-09-30','2024-12-31'],rows:[{kind:'field',name:'归属于母公司所有者的净利润',vals:['1','2','3','4']}]};
  await seed(s,key,page,'source-sina-page');let calls=0;
  const get=(options={})=>storedMarketInput(key,'source-sina-page','source',1,async()=>{calls++;return page;},()=>{},s,now+100,undefined,options);
  await get();assert.equal(calls,0);await get({forceRefresh:true});assert.equal(calls,1);
});

test('a source success remains usable during a database write outage and reports persistence failure',async()=>{
  const s=memory();s.write=async()=>{throw Error('database offline');};
  const result=await withMarketReadStatus(async()=>({rows:await storedMarketInput('new','financial-input','source',1,async()=>[{amount:8}],validate,s,now)}));
  assert.equal(result.rows[0].amount,8);assert.deepEqual(result.dataStatus.persistenceFailed,['new']);assert.equal(result.stale,undefined);
});

test('memory cache replays saved-input warnings instead of presenting its derived result as fresh',async()=>{
  clearCache();const s=memory();await seed(s,'cache-input',[{amount:10}]);
  const get=()=>withMarketReadStatus(()=>cached('derived-hybrid-test',1000,async()=>({rows:await storedMarketInput('cache-input','financial-input','source',1,fail,validate,s,now+100)})));
  assert.equal((await get()).stale,true);assert.equal((await get()).dataStatus.snapshots[0].key,'cache-input');
});

test('a fallback valuation is not saved with a new acquisition time',async()=>{
  const s=memory();await seed(s,'valuation-input',[{amount:10}]);
  const v=await cachedValuationResult('sh603599',10,'disclosure',()=>withMarketReadStatus(async()=>{
    await storedMarketInput('valuation-input','financial-input','source',1,fail,validate,s,now+100);
    return {history:[{date:'2026-10-22'}],stale:false};
  }),{},s);
  assert.equal(v.stale,true);assert.equal(s.rows.has('valuation-result:v1:sh603599:10:disclosure'),false);
});

test('quote outage uses the durable provider quote with its original time',async()=>{
  const s=memory(),quote={symbol:'sh603599',code:'603599',price:10,source:'tencent',stale:false,ts:'2026-10-22T07:00:00Z'};
  await seed(s,'latest-quote:v1:sh603599:raw-provider',quote,'latest-quote');
  const result=await withMarketReadStatus(async()=>({quotes:await sharedQuotes(['sh603599'],fail,s)}));
  assert.equal(result.quotes[0].stale,true);assert.equal(result.quotes[0].ts,quote.ts);assert.equal(result.stale,true);
});

test('canonical price-tail failure leaves imported history available and unchanged',async()=>{
  const s=memory(),key='kline:v2:sh603599:day:none:canonical:prices-only';
  await seed(s,key,{symbol:'sh603599',code:'603599',period:'day',adjust:'none',source:'canonical',stale:false,complete:true,
    candles:[{date:'2026-10-20',open:10,high:11,low:9,close:10}],origins:[]},'kline');
  const old=await s.read(key);
  const result=await withMarketReadStatus(()=>storedKLine({symbol:'sh603599',period:'day',adjust:'none',count:1,recentOnly:true},fail,s,now+100));
  assert.equal(result.stale,true);assert.equal(result.candles[0].date,'2026-10-20');assert.equal((await s.read(key)).digest,old.digest);
});

test('partial screen reply retains old dates/cells; missing replies cannot renew their freshness',async()=>{
  const s=memory(),key='screen-company-input:v1:603599:eastmoney:CNY',date='2025-12-31';
  await seed(s,key,{main:[{SECURITY_CODE:'603599',REPORT_DATE:date,ROEJQ:6}],income:[],fetchedPeriods:{[date]:now-7*3600e3}},'latest-company-financial-input');
  const r=await storedScreenFinancials(['603599'],[date,'2024-12-31'],async()=>({main:[{SECURITY_CODE:'603599',REPORT_DATE:date,ROEJQ:null,XSJLL:18}],income:[]}),s,now);
  assert.equal(r.main[0].ROEJQ,6);assert.equal(r.main[0].XSJLL,18);
  assert.equal((await s.read(key)).payload.fetchedPeriods['2024-12-31'],undefined);
});

test('screen upstream failure returns only available reports with saved-data warnings',async()=>{
  const s=memory(),date='2025-12-31';
  await seed(s,'screen-company-input:v1:603599:eastmoney:CNY',{main:[{SECURITY_CODE:'603599',REPORT_DATE:date,ROEJQ:6}],income:[],fetchedPeriods:{[date]:now-7*3600e3}},'latest-company-financial-input');
  const result=await withMarketReadStatus(()=>storedScreenFinancials(['603599','600415'],[date],fail,s,now));
  assert.equal(result.main.length,1);assert.equal(result.stale,true);assert.equal(result.dataStatus.snapshots.length,1);
});

for(const type of ['disclosures','indicators'])test(`concurrent ${type} imports cannot erase a writer that wins after the merge read`,async()=>{
  const s=memory(),write=s.write;let concurrent;
  s.write=async(row,expected)=>{
    concurrent=marketRecord(row.key,row.kind,'other-writer',type==='disclosures'?{$marketMap:[['2025-06-30','2025-08-20']]}:
      {dates:['2025-06-30'],rows:{$marketMap:[['净资产收益率(%)',['9']]]}},1000,now);
    await write(concurrent,null);return write(row,expected);
  };
  const work=type==='disclosures'?()=>importDisclosureDates(s,{symbol:'603599',items:[{date:'2025-12-31',published:'2026-04-20'}]},now):
    ()=>importAIndicators(s,{symbol:'603599',year:2025,items:[{date:'2025-12-31',indicator:'净资产收益率(%)',value:6}]},now);
  await assert.rejects(work(),/版本冲突/);assert.equal((await s.read(concurrent.key)).digest,concurrent.digest);
});

test('conflicting financial cells retain original facts and keep a review warning on later cache hits',async()=>{
  const s=memory(),key='source-sina-page:v1:603599:profit:2026',issues=[];
  s.incident=async(...args)=>issues.push(args);
  const page=amount=>({unit:'万元',dates:['2026-06-30'],rows:[{kind:'field',name:'归属于母公司所有者的净利润',vals:[String(amount)]}]});
  await seed(s,key,page(10),'source-sina-page');
  const read=()=>withMarketReadStatus(async()=>({page:await storedMarketInput(key,'source-sina-page','new-source',60000,async()=>page(20),()=>{},s,now+100)}));
  for(const result of [await read(),await read()]){
    assert.equal(result.page.rows[0].vals[0],'10');assert.equal(result.stale,true);assert.match(result.dataStatus.snapshots[0].reason,/冲突/);
  }
  assert.equal(issues.filter(i=>i[1]==='financial_values_conflict').length,1);
  assert.equal(issues[0][2].conflicts[0].incoming,'20');
});

test('a cold financial summary uses validated network statements even without a writable market store',async()=>{
  const env=Object.fromEntries(['MARKET_DATA_STORE','MARKET_DATA_MODE','MARKET_READ_MODE'].map(k=>[k,process.env[k]]));
  const original=globalThis.fetch;const calls=[];clearCache();
  process.env.MARKET_DATA_STORE='off';delete process.env.MARKET_DATA_MODE;process.env.MARKET_READ_MODE='hybrid';
  globalThis.fetch=async url=>{
    const u=new URL(url);calls.push(u.hostname);
    if(u.hostname==='money.finance.sina.com.cn')return new Response('source temporarily incomplete');
    if(u.hostname==='datacenter.eastmoney.com'){
      const year=/REPORT_DATE>='(\d{4})/.exec(u.searchParams.get('filter'))[1];
      const report=year==='2026'?'2026-06-30':'2025-12-31';
      return Response.json({success:true,result:{pages:1,data:[{SECUCODE:'603599.SH',SECURITY_CODE:'603599',CURRENCY:'CNY',REPORT_DATE:report,
        NOTICE_DATE:year==='2026'?'2026-08-26':'2026-04-18',PARENT_NETPROFIT:1e8,NETPROFIT:1e8,OPERATE_INCOME:5e8,OPERATE_COST:3e8,
        TOTAL_ASSETS:10e8,TOTAL_LIABILITIES:3e8,TOTAL_PARENT_EQUITY:7e8,TOTAL_EQUITY:7e8}]}});
    }
    throw Error('unexpected upstream '+u.hostname);
  };
  try{
    const ds=await load('datasource/index');const result=await ds.getFinancial('603599');
    assert.equal(result.provenance,'fetched');assert.equal(result.revenue.at(-1),5);assert.equal(result.netProfit.at(-1),1);
    assert.equal(result.debtRatio.at(-1),30);assert.ok(!calls.includes('qt.gtimg.cn'),'real statements must not silently become quote-derived estimates');
  }finally{
    globalThis.fetch=original;for(const [k,v]of Object.entries(env))if(v===undefined)delete process.env[k];else process.env[k]=v;clearCache();
  }
});
