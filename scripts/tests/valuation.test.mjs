import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';
const v = await load('valuation');
const analytics = await load('analytics');
const {parseDisclosureDates} = await load('datasource/disclosures');
const tencent = await load('datasource/tencent');
const {fetchYearStatement} = await load('datasource/sinaFinStatements');
const {normalizeCode,normalizeStockCode} = await load('datasource/codes');
const {defaultTtl} = await load('datasource/cache');
const point = (date,np,equity=500e8) => ({date,npParent:np,npTotal:null,sharesYi:10,equityParent:equity,equityTotal:null});
const candle = (date,close=20) => ({date,open:close,high:close,low:close,close,volume:1});
test('Q1 TTM uses last Q1 rather than last Q3', () => {
 const points=[point('2024-03-31',20e8),point('2024-09-30',70e8),point('2024-12-31',100e8),point('2025-03-31',30e8)];
 assert.equal(v.buildTimelineFromStatements(points).at(-1).npTTM,110);
});
test('loss reports invalidate PE and independently refresh PB', () => {
 const timeline=v.buildTimelineFromStatements([point('2023-12-31',100e8),point('2024-12-31',-20e8,480e8)]);
 const row=v.buildRealValuationSeries([candle('2025-05-02')],timeline)[0];
 assert.equal(row.pe,null);assert.equal(row.pb,.42);
});
test('missing TTM is not forward filled from a profitable report', () => {
 const timeline=v.buildTimelineFromStatements([point('2024-12-31',100e8),point('2025-03-31',30e8)]);
 assert.equal(v.buildRealValuationSeries([candle('2025-05-02')],timeline)[0].pe,null);
});
test('qfq prices and denominators share a factor; PE/PB remain invariant', () => {
 const timeline=v.buildTimelineFromStatements([point('2024-12-31',100e8)]);
 const raw=[candle('2025-05-02')],adjustedByDate=new Map([['2025-05-02',candle('2025-05-02',10)]]);
 const a=v.buildRealValuationSeries(raw,timeline)[0];
 const b=v.buildRealValuationSeries(raw,timeline,{adjustedByDate})[0];
 assert.equal(b.close,10);assert.equal(b.rawClose,20);assert.equal(b.pe,a.pe);assert.equal(b.pb,a.pb);
});
test('share changes apply on the trading date, not the next reporting date', () => {
 const timeline=v.buildTimelineFromStatements([point('2024-12-31',100e8)]);
 const row=v.buildRealValuationSeries([candle('2025-06-02',10)],timeline,{shareHistory:[{date:'2025-01-01',sharesWan:100000},{date:'2025-06-01',sharesWan:200000}]})[0];
 assert.equal(row.pe,2);assert.equal(row.pb,.4);
});
test('announcement parser ignores translated/revised reports and retains first release', () => {
 const html="2026-04-09&nbsp;<a href='x'>小商品城：2025年年度报告</a>2026-04-17&nbsp;<a>小商品城：2025年年度报告(英文版)</a>2026-04-20&nbsp;<a>小商品城：2025年年度报告（更正）</a>";
 assert.equal(parseDisclosureDates(html).get('2025-12-31'),'2026-04-09');
});
test('a later annual announcement does not replace a newer quarter', () => {
 const points=[point('2024-03-31',20e8),point('2024-12-31',100e8),point('2025-03-31',30e8)];
 const timeline=v.buildDisclosureTimeline(points,{reportDates:new Map([['2024-12-31','2025-04-29'],['2025-03-31','2025-04-20']])});
 assert.equal(v.buildRealValuationSeries([candle('2025-05-06')],timeline)[0].pe,1.82);
});
test('an unavailable report creates a missing interval after the cutoff', () => {
 const timeline=v.buildDisclosureTimeline([point('2024-12-31',100e8),point('2025-03-31',20e8)],{reportDates:new Map([['2024-12-31','2025-04-01']])});
 const row=v.buildRealValuationSeries([candle('2025-05-06')],timeline)[0];
 assert.equal(row.pe,null);assert.equal(row.pb,null);
});
test('current metrics are the last calculated point, not overwritten quote values', () => {
 const result=v.summarizeReal([{date:'2025-01-01',pe:10,pb:1,close:20,dy:0}],{pe:99,pb:99,price:20},{years:5});
 assert.equal(result.pe,10);assert.equal(result.pb,1);assert.equal(result.dividendYield,0);
});
test('expired dividends become zero; unavailable latest values stay unavailable', () => {
 const series=analytics.buildDividendYieldByDate([{exDate:'2024-01-01',perShare:1}],[candle('2024-06-01'),candle('2025-06-02')]);
 assert.equal(series.get('2024-06-01'),5);assert.equal(series.get('2025-06-02'),0);
 const summary=v.summarizeReal([{date:'a',pe:10,pb:1,close:20,dy:5},{date:'b',pe:10,pb:1,close:20,dy:null}],{pe:10,pb:1,price:20},{years:5});
 assert.equal(summary.dividendYield,null);
});
test('UTC hosts still use the Shanghai trading cache TTL', () => {
 const OriginalDate=Date;globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:['2026-10-16T02:00:00Z']));}};
 try {assert.equal(defaultTtl(),15000);} finally {globalThis.Date=OriginalDate;}
});
test('expired cache fallback is explicitly marked stale', async () => {
 const {cached,clearCache}=await load('datasource/cache');clearCache();
 await cached('stale-test',0,async()=>({stale:false,warnings:[],value:1}));
 const result=await cached('stale-test',0,async()=>{throw Error('upstream unavailable');});
 assert.equal(result.stale,true);assert.equal(result.warnings.length,1);clearCache();
});
test('market suffixes distinguish a bank from an index', () => {
 assert.equal(normalizeCode('000001.SZ').kind,'stock');assert.equal(normalizeCode('000001.SZ').symbol,'sz000001');assert.equal(normalizeCode('000001.SH').kind,'index');
 assert.equal(normalizeStockCode('000001').symbol,'sz000001');
});
test('actual share history handles a 0.1 par value without assuming par=1',async () => {
 const original=globalThis.fetch;
 const row=(name,value)=>`<tr><td><a>${name}</a></td><td>${value}</td></tr>`;
 const html='<table><tr><td>报表日期</td><td>2025-12-31</td></tr>'+row('归属于母公司所有者的净利润','10000')+row('实收资本(或股本)','1000')+row('归属于母公司股东权益合计','20000')+row('其他权益工具','1000')+'</tbody></table>';
 // The fixture is UTF-8; production responses are GBK.
 const {TextDecoder:OriginalDecoder}=globalThis;
 globalThis.TextDecoder=class extends OriginalDecoder{constructor(){super('utf-8');}};
 globalThis.fetch=async()=>new Response(html);
 try {const [p]=await fetchYearStatement('601899',2025,[{date:'2020-01-01',sharesWan:10000}]);assert.equal(p.sharesYi,1);assert.equal(p.equityCommon,19000e4);}
 finally {globalThis.fetch=original;globalThis.TextDecoder=OriginalDecoder;}
});
test('qfq requests cannot silently consume raw price keys',async () => {
 const original=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({data:{sh600415:{day:[['2025-01-01','10','10','10','10','1']]}}}));
 try {await assert.rejects(tencent.fetchKLine('sh600415','day','qfq',320),/empty series/);}finally{globalThis.fetch=original;}
});
test('long price histories paginate at 640 rows and deduplicate dates',async () => {
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async url=>{const args=new URL(url).searchParams.get('param').split(',');assert.equal(args[4],'640');const date=++calls===1?'2025-01-03':'2025-01-02';return new Response(JSON.stringify({data:{sh600415:{qfqday:[[date,'10','10','10','10','1']]}}}));};
 try {const result=await tencent.fetchKLine('sh600415','day','qfq',3200,'2025-01-02');assert.deepEqual(result.candles.map(c=>c.date),['2025-01-02','2025-01-03']);assert.equal(calls,2);}finally{globalThis.fetch=original;}
});
test('kline falls back to the next mirror when upstream WAF returns a 501 challenge page',async () => {
 const original=globalThis.fetch;const seen=[];
 globalThis.fetch=async url=>{
  const u=String(url);seen.push(new URL(u).host);
  if(u.includes('ifzq.gtimg.cn'))return new Response('<!DOCTYPE html><html><script>location.href="//waf"</script></html>',{status:501});
  return new Response(JSON.stringify({data:{sh600415:{qfqday:[['2026-10-16','11','11.2','11.3','10.9','100']]}}}));
 };
 try {
  const r=await tencent.fetchKLine('sh600415','day','qfq',320);
  assert.deepEqual(r.candles.map(c=>c.date),['2026-10-16']);
  assert.equal(r.candles[0].close,11.2);
  assert.ok(seen.length>=2,'should have tried the fallback mirror');
  assert.ok(seen.includes('proxy.finance.qq.com'));
 }finally{globalThis.fetch=original;}
});
test('kline reports an explicit error when every mirror is blocked',async () => {
 const original=globalThis.fetch;
 globalThis.fetch=async()=>new Response('<!DOCTYPE html><html>waf</html>',{status:501});
 try {await assert.rejects(tencent.fetchKLine('sh600415','day','qfq',320),/HTTP 501|invalid json/);}
 finally{globalThis.fetch=original;}
});
test('snapshot identity never substitutes a Shenzhen bank for a Shanghai index', async () => {
 const snapshot=await load('datasource/snapshot');
 const bank=await snapshot.snapshotQuote('sz000001');
 assert.equal(bank?.kind,'stock');assert.equal(bank?.symbol,'sz000001');
 const index=await snapshot.snapshotQuote('sh000001');
 assert.ok(index === null || index.symbol === 'sh000001');
});
test('unavailable financial statements fail explicitly instead of returning estimated history', async () => {
 const {clearCache}=await load('datasource/cache');clearCache();
 const original=globalThis.fetch;
 globalThis.fetch=async url=>{
  const u=String(url);
  if(u.includes('qt.gtimg.cn')){const fields=Array(80).fill('');fields[1]='Example';fields[2]='600415';fields[3]='11';return new Response('v_sh600415="'+fields.join('~')+'";');}
  if(u.includes('fqkline'))return new Response(JSON.stringify({data:{sh600415:{day:[['2026-10-16',11,11,11,11,1]],qfqday:[['2026-10-16',11,11,11,11,1]]}}}));
  return new Response('<html></html>');
 };
 try {const ds=await load('datasource/index');await assert.rejects(ds.getValuation('600415',10),/财报数据不可用/);}
 finally{globalThis.fetch=original;clearCache();}
});
test('many custom fields fetch each statement once per year', async () => {
 const source=await load('datasource/sinaStatements');
 const original=globalThis.fetch,Decoder=globalThis.TextDecoder;let requests=0;
 globalThis.TextDecoder=class extends Decoder{constructor(){super('utf-8');}};
 globalThis.fetch=async()=>{requests++;return new Response('<table><tr><td>报表日期</td><td>2025-12-31</td></tr>'+Array.from({length:60},(_,i)=>`<tr><td style="padding-left:30px">Field${i}</td><td>1</td></tr>`).join('')+'</table>');};
 const fields=[...Array.from({length:60},(_,i)=>'bs_Field'+i),'pl_Field0','cf_Field0'];
 try {const result=await source.fetchCustomFinancials('600415',fields,2);assert.equal(requests,9);assert.equal(Object.keys(result.series).length,62);assert.equal(result.series.bs_Field0[0],1);}
 finally{globalThis.fetch=original;globalThis.TextDecoder=Decoder;}
});
