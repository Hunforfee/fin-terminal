import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { load } from './load-modules.mjs';
const records = await load('marketImportRecords');
const hkRecords = await load('marketHkImportRecords');
const bars = await load('marketImportedBars');
const market = await load('marketStore');
const auth = await load('marketImportAuth');
const session = await load('auth/session');
const retention = await load('marketRetention');
const now = Date.parse('2026-10-21T13:00:00Z');
function store() {
  const data = new Map();
  return { data, read: async key => data.get(key) ?? null,
    async write(row, expected) { if ((data.get(row.key)?.digest ?? null) !== expected) return false; data.set(row.key, structuredClone(row)); return true; },
    async remove(key) { data.delete(key); return true; }, incident: async () => {},
    seed(key, kind, payload) { data.set(key, market.marketRecord(key, kind, 'test', payload, 1e8, now)); },
  };
}
test('a small finance upload preserves other quarters, fields, and known values', async () => {
  const s=store(), key='source-sina-page:v1:600415:profit:2025';
  s.seed(key,'source-sina-page',{dates:['2025-06-30','2025-03-31'],unit:'万元',announceDates:['2025-08-20','2025-04-20'],rows:[
    {kind:'group',name:'利润表',vals:[]},
    {kind:'field',name:'营业收入',vals:['200','100']},
    {kind:'field',name:'净利润',vals:['20','10']},
  ]});
  const input={symbol:'600415',statement:'profit',reportDates:['2025-03-31','2025-09-30'],items:[{name:'营业收入',vals:[null,300]}]};
  await records.writeFinanceStatements(s,input,now);
  const p=(await s.read(key)).payload, dates=p.dates;
  assert.equal(dates.length,3);assert.equal(p.rows.find(r=>r.name==='营业收入').vals[dates.indexOf('2025-03-31')],'100');
  assert.equal(p.rows.find(r=>r.name==='净利润').vals[dates.indexOf('2025-06-30')],'20');
  assert.equal(p.announceDates[dates.indexOf('2025-06-30')],'2025-08-20');
  assert.equal((await records.writeFinanceStatements(s,input,now)).skipped,true);
});
test('financial history merges fields and all span records; shares reach the valuation field', async () => {
  const s=store();
  s.seed('statements-v3:600415:6','financial-history',[{date:'2024-12-31',npParent:123,equityParent:456,eps:1.2,sharesYi:9}]);
  const input={symbol:'600415',shareUnit:'shares',reportDates:['2025-06-30','2024-12-31'],items:[{code:'npParent',vals:[20,null]},{code:'equityParent',vals:[200,null]},{code:'totalShares',vals:[1e9,null]}]};
  await records.writeFinancialHistory(s,input,now);
  const p=(await s.read('statements-v3:600415:12')).payload;
  assert.equal(p.find(r=>r.date==='2024-12-31').eps,1.2);
  assert.equal(p.find(r=>r.date==='2024-12-31').npParent,123);
  assert.equal(p.find(r=>r.date==='2025-06-30').sharesYi,10);
  assert.equal(p.find(r=>r.date==='2025-06-30').npParent,200000);
  s.data.delete('statements-v3:600415:2');
  await records.writeFinancialHistory(s,input,now);assert.ok(await s.read('statements-v3:600415:2'));
});
test('partial dividends keep history and provenance and reject future implemented events', async () => {
  const s=store(), key='implemented-dividends-v4:600415';
  s.seed(key,'implemented-dividends',[{exDate:'2024-07-01',perShare:.1,cashSource:'sina',precisionPerShare:.0001,perShareStock:0}]);
  const rows=[{exDate:'2025-07-01',perShare:.2,cashSource:'sina',precisionPerShare:.0001}];
  await records.writeDividendImplemented(s,'sh600415',rows,now);
  const p=(await s.read(key)).payload;assert.equal(p.length,2);assert.equal(p[1].cashSource,'sina');
  assert.equal((await records.writeDividendImplemented(s,'sh600415',rows,now)).skipped,true);
  await assert.rejects(records.writeDividendImplemented(s,'sh600415',[{exDate:'2027-01-01',perShare:1}],now));
  const plan=(date,ex)=>({reportDate:date,announceDate:null,exDate:ex,perShare:.1,implemented:true});
  await records.writeDividendPlans(s,'sh600415',[plan('2023-12-31','2024-07-01')],now);
  await records.writeDividendPlans(s,'sh600415',[plan('2024-12-31','2025-07-01')],now);
  assert.equal((await s.read('dividend-plans-v2:600415')).payload.length,2);
});
function route(s) {
  const exported={};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/api/market/import/route.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{
    exports:exported,Buffer,Date,require(name){
      if(name==='next/server')return {NextResponse:{json:(body,o)=>({body,status:o?.status??200})}};
      if(name==='@/lib/marketStore')return {...market,getMarketStore:()=>s};
      if(name==='@/lib/marketImportedBars')return bars;
      if(name==='@/lib/marketImportRecords')return records;
      if(name==='@/lib/marketHkImportRecords')return hkRecords;
      if(name==='@/lib/marketImportAuth')return auth;
      throw Error(name);
    },
  });return exported;
}
const candle=(date,price=10)=>({date,open:price,high:price,low:price,close:price});
test('admin route validates before any mutation, merges batches, and never deletes on failure',async()=>{
  const prior={...process.env};process.env.AUTH_SESSION_SECRET='isolated-tests-only-secret-32-characters';process.env.MARKET_IMPORT_ADMIN_IDS='admin-test';
  const token=session.createSession({id:'admin-test',phone:'admin_test'},process.env.AUTH_SESSION_SECRET);
  const request=(candles,csrf=true,cookie=token)=>({url:'https://site.test/api/market/import',headers:new Headers({origin:'https://site.test',...(csrf?{'x-fin-csrf':'1'}:{})}),cookies:{get:()=>cookie?{value:cookie}:undefined},text:async()=>JSON.stringify({type:'kline',record:{symbol:'sh600415',candles}})});
  try {
    const s=store(),api=route(s);
    assert.equal((await api.POST(request([candle('2025-01-02')],false))).status,403);
    assert.equal((await api.POST(request([candle('2025-01-02')],true,null))).status,401);
    assert.equal((await api.POST(request([candle('2025-01-02')]))).status,200);
    const key=bars.importedBarsKey('sh600415'), before=(await s.read(key)).digest;
    assert.equal((await api.POST(request([{...candle('2025-01-02'),low:10.01}]))).status,400);
    assert.equal((await s.read(key))?.digest,before,'invalid OHLC must leave the complete existing record intact');
    assert.equal((await api.POST(request([candle('2025-01-03')]))).status,200);
    assert.equal((await s.read(key)).payload.candles.length,2);
    assert.equal((await api.POST(request([candle('2025-01-02')]))).body.result.skipped,true);
    const write=s.write; s.write=async(row,expected)=>row.key===key?false:write(row,expected);
    const failed=await api.POST(request([candle('2025-01-06')]));
    assert.ok(failed.status>=400);assert.equal((await s.read(key)).payload.candles[0].close,10);
    assert.equal((await s.read(key)).payload.candles.length,2);
  } finally {for(const k of ['AUTH_SESSION_SECRET','MARKET_IMPORT_ADMIN_IDS'])if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k];}
});

test('invalid units, duplicate fields, future financials and Hong Kong currency fail without writes',async()=>{
  const s=store(),input={symbol:'600415',statement:'profit',reportDates:['2025-03-31'],items:[{name:'营业收入',vals:[100]}]};
  for(const change of [{unit:'yuan'},{currency:'HKD'},{basis:'quarter'},{reportDates:['2027-03-31']},{items:[...input.items,...input.items]},{items:[{name:'营业收入',vals:[true]}]},{announceDates:['2024-01-01']}])
    await assert.rejects(records.writeFinanceStatements(s,{...input,...change},now));
  await assert.rejects(records.writeDividendImplemented(s,'hk00700',[{exDate:'2025-01-01',perShare:1}],now));
  assert.equal(s.data.size,0);
});
test('ten-year pruning keeps disclosure dates aligned with the remaining financial columns',()=>{
  const p=retention.retainMarketPayload('source-sina-page',{dates:['2010-09-30','2016-12-31'],announceDates:['2010-10-20','2017-03-30'],rows:[{kind:'field',name:'营业收入',vals:['1','2']}]},now);
  assert.deepEqual(p.dates,['2016-12-31']);assert.deepEqual(p.announceDates,['2017-03-30']);assert.deepEqual(p.rows[0].vals,['2']);
});
test('batch imports reject inconsistent overlaps and duplicates and survive ten-year boundary pruning',async()=>{
  const s=store();
  await bars.importDailyPrices(s,{symbol:'sh600415',source:'qmt',candles:[candle('2016-10-20'),candle('2025-01-02')]},now-864e5);
  await bars.importDailyPrices(s,{symbol:'sh600415',source:'qmt',mergeBatch:true,candles:[candle('2025-01-03')]},now);
  const key=bars.importedBarsKey('sh600415'),old=(await s.read(key)).digest;
  await assert.rejects(bars.importDailyPrices(s,{symbol:'sh600415',source:'qmt',mergeBatch:true,candles:[candle('2025-01-02',10.001)]},now),/冲突/);
  await assert.rejects(bars.importDailyPrices(s,{symbol:'sh600415',source:'qmt',mergeBatch:true,candles:[candle('2025-01-03'),candle('2025-01-03')]},now));
  assert.equal((await s.read(key)).digest,old);assert.equal((await s.read(key)).payload.candles.length,2);
});
test('Hong Kong statement imports refuse amount conflicts unless an admin snapshot overwrite is requested',async()=>{
  const s=store(),key='source-hk-statement:v1:00639.HK:balance:2025-12-31';
  const rows=[{date:'2025-12-31',itemCode:'004001001',itemName:'固定资产',amount:100}];
  s.seed(key,'source-hk-statement',[{date:'2025-12-31',itemCode:'004001001',itemName:'固定资产',amount:86}]);
  await assert.rejects(hkRecords.writeHkStatements(s,{symbol:'hk00639',statement:'balance',rows:[{...rows[0],amount:115}]},now),/金额冲突/);
  assert.equal((await s.read(key)).payload[0].amount,86);
  const r=await hkRecords.writeHkStatements(s,{symbol:'hk00639',statement:'balance',rows:[{...rows[0],amount:115}]},now,{overwrite:true});
  assert.equal((await s.read(key)).payload[0].amount,115);
  assert.equal(r.skipped,undefined);
  assert.equal((await hkRecords.writeHkStatements(s,{symbol:'hk00639',statement:'balance',rows:[{...rows[0],amount:115}]},now)).skipped,true);
  // 覆盖同样保留 null 不擦除语义
  await hkRecords.writeHkStatements(s,{symbol:'hk00639',statement:'balance',rows:[{...rows[0],amount:null}]},now,{overwrite:true});
  assert.equal((await s.read(key)).payload[0].amount,115);
  assert.equal(s.data.size,1);
});
test('Hong Kong indicator imports land on the site key, merge fields, and prune by retention',async()=>{
  const s=store(),key='source-hk-indicators:v1:00639.HK';
  const points=[
    {date:'2026-06-30',raw:{ROE_AVG:12.5,BASIC_EPS:0.8},currency:'港元',kind:'semi',label:'中报'},
  ];
  const r=await hkRecords.writeHkIndicators(s,{symbol:'hk00639',points},now);
  assert.equal(r.dates,1);assert.equal(r.skipped,undefined);
  const p=(await s.read(key)).payload;
  assert.equal(p.length,1);assert.equal(p[0].raw.BASIC_EPS,0.8);
  assert.equal((await s.read(key)).source,'import:hkf10:main:reported');
  assert.equal((await hkRecords.writeHkIndicators(s,{symbol:'hk00639',points},now)).skipped,true);
  // 字段级合并：旧有新字段不擦除，导入值覆盖同名字段
  await hkRecords.writeHkIndicators(s,{symbol:'hk00639',points:[{date:'2026-06-30',raw:{ROE_AVG:13},currency:'港元',kind:'semi',label:'中报'}]},now);
  const q=(await s.read(key)).payload[0].raw;
  assert.equal(q.BASIC_EPS,0.8);assert.equal(q.ROE_AVG,13);
  await assert.rejects(hkRecords.writeHkIndicators(s,{symbol:'hk00639',points:[{date:'2015-06-30',raw:{ROE_AVG:1},currency:'港元',kind:'semi',label:'中报'}]},now),/超出保留期/);
  await assert.rejects(hkRecords.writeHkIndicators(s,{symbol:'hk00639',points:[{date:'2027-06-30',raw:{ROE_AVG:1},currency:'港元',kind:'semi',label:'中报'}]},now));
  await assert.rejects(hkRecords.writeHkIndicators(s,{symbol:'hk00639',points:[]},now));
  await assert.rejects(hkRecords.writeHkIndicators(s,{symbol:'600415',points:[{date:'2026-06-30',raw:{},currency:'CNY',kind:'semi',label:'中报'}]},now));
  // 更早报告期保留在库（导入快照不含也不删除）
  s.seed(key,'source-hk-indicators',[{date:'2018-06-30',raw:{ROE_AVG:2},currency:'港元',kind:'semi',label:'中报'}]);
  await hkRecords.writeHkIndicators(s,{symbol:'hk00639',points:[{date:'2026-06-30',raw:{ROE_AVG:14},currency:'港元',kind:'semi',label:'中报'}]},now);
  assert.equal((await s.read(key)).payload.length,2);
});
test('a correctly signed non-admin cookie cannot access import records or write data',async()=>{
  const prior={...process.env};
  try{
    process.env.AUTH_SESSION_SECRET='isolated-tests-only-secret-32-characters';process.env.MARKET_IMPORT_ADMIN_IDS='admin-test';
    const token=session.createSession({id:'other-account',phone:'other_account'},process.env.AUTH_SESSION_SECRET);
    const request={url:'https://site.test/api/market/import',headers:new Headers({origin:'https://site.test','x-fin-csrf':'1'}),cookies:{get:()=>({value:token})}};
    const s=store(),api=route(s);assert.equal((await api.POST(request)).status,403);assert.equal((await api.GET(request)).body.authorized,false);assert.equal(s.data.size,0);
  }finally{for(const k of ['AUTH_SESSION_SECRET','MARKET_IMPORT_ADMIN_IDS'])if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k];}
});

test('recognizes binary32 serialization without accepting actual price changes or truncating old history',async()=>{
  assert.equal(bars.equivalentRawPrice(16.950001,16.95),true);
  assert.equal(bars.equivalentRawPrice(Math.fround(16.95),16.95),true);
  assert.equal(bars.equivalentRawPrice(10.000001,10),false);
  assert.equal(bars.equivalentRawPrice(10.94,10.97),false);
  const s=store();
  await bars.importDailyPrices(s,{symbol:'sh600415',source:'tdx',candles:[candle('2025-01-02',16.950001)]},now);
  assert.equal((await s.read(bars.importedBarsKey('sh600415'))).payload.origins[0].source,'tdx');
  await bars.importDailyPrices(s,{symbol:'sh600415',source:'qmt',mergeBatch:true,candles:[candle('2025-01-02',16.95),candle('2025-01-03',17)]},now);
  const row=await s.read(bars.importedBarsKey('sh600415'));
  assert.equal(row.payload.candles[0].close,16.95);assert.equal(row.payload.origins.at(-1).source,'qmt');
});
test('actual shares have an explicit unit and replace the obsolete wrong field, without inferring capital',async()=>{
  const s=store();
  const input={symbol:'000923',reportDates:['2025-12-31','2026-06-30'],items:[{code:'npParent',vals:[100,20]},{code:'equityParent',vals:[200,220]},{code:'totalShares',vals:[652728961,652728961]}]};
  await assert.rejects(records.writeFinancialHistory(s,input,now),/shareUnit/);
  const malformed={...input,shareUnit:'shares',items:input.items.map(it=>it.code==='totalShares'?{...it,vals:[65272.8961,65272.8961]}:it)};
  await assert.rejects(records.writeFinancialHistory(s,malformed,now),/股数/);
  s.seed('statements-v3:000923:6','financial-history',[{date:'2025-12-31',npParent:1,equityParent:2,totalShares:0.000652728961}]);
  await records.writeFinancialHistory(s,{...input,shareUnit:'shares'},now);
  const p=(await s.read('statements-v3:000923:6')).payload;
  assert.equal(p[0].sharesYi,6.52728961);assert.equal('totalShares' in p[0],false);
  await records.writeShareHistory(s,{symbol:'sz000923',unit:'shares',rows:[{date:'2025-12-31',shares:652728961}]},now);
  assert.equal((await s.read('shares-v3:000923')).payload[0].sharesWan,65272.8961);
  await assert.rejects(records.writeShareHistory(s,{symbol:'sz000923',unit:'wan',rows:[{date:'2025-12-31',shares:652728961}]},now));
  await assert.rejects(records.writeShareHistory(s,{symbol:'sz000923',unit:'shares',rows:[{date:'2025-12-31',shares:652728960}]},now),/冲突/);
});
