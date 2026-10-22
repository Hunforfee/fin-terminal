import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { load } from './load-modules.mjs';

const source = await load('datasource/index');
const cache = await load('datasource/cache');
const { clearCache } = cache;
const codes = await load('datasource/codes');
const valuationInputs = await load('valuationInputs');
const metricCache = await load('displayMetricCache');
const route = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/api/dividend-yield/route.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, {
  exports: route,
  require(name) {
    if(name==='next/server')return {after:()=>{}};
    if(name==='@/lib/displayMetricCache')return metricCache;
    if (name === '@/lib/api') return {
      ok: data => ({ ok: true, data }), fail: error => ({ ok: false, error }),
      sp: request => new URL(request.url).searchParams,
    };
    if (name === '@/lib/datasource') return source;
    if (name === '@/lib/datasource/cache') return cache;
    if (name === '@/lib/datasource/codes') return codes;
    if (name === '@/lib/valuationInputs') return valuationInputs;
    if (['@/lib/datasource/dividendPlans', '@/lib/datasource/sinaBonus', '@/lib/dividends'].includes(name)) return {};
    throw new Error(`Unexpected import: ${name}`);
  },
});
const requestYield = async () => (await route.GET({ url: 'http://localhost/api/dividend-yield?codes=hk02388' })).data[0];

// BOCHK's real 2026H1 snapshot. The issuer reports HK$360,366m equity,
// 10,572,780,266 shares; the main-indicator BPS is CNY despite CURRENCY=HKD.
const main = {
  REPORT_DATE: '2026-06-30', REPORT_TYPE: '2026年中报', CURRENCY: 'HKD',
  BPS: 29.603934010294, EPS_TTM: 3.46623926233,
  TOTAL_MARKET_CAP: 530224930339.9, ISSUED_COMMON_SHARES: 10572780266,
  PB_TTM: 1.471351155048, PE_TTM: 12.71522614724,
};
const dividends = [
  ['2025末期', '2026-06-26', 1.255],
  ['2025三季', '2025-11-25', 0.29],
  ['2025中期', '2025-08-26', 0.29],
  ['2025一季', '2025-05-27', 0.29],
].map(([period, date, dps]) => ({
  ASSIGN_PERIOD: period, EX_DIVIDEND_DATE: date, NOTICE_DATE: date,
  PLAN_EXPLAIN: `每股派港币${dps}元`, ASSIGN_PROGRESS: '实施分配',
}));

function quoteResponse(price) {
  const fields = Array(78).fill('');
  for (const [key, value] of Object.entries({
    0: 100, 1: 'BOCHK', 2: '02388', 3: price, 4: price, 5: price,
    6: 100, 30: '2026/10/16 16:08:22', 31: 0, 32: 0,
    33: price, 34: price, 36: 100, 37: 1000, 39: 12.7,
    44: 5302.2493, 45: 5302.2493,
  })) fields[Number(key)] = String(value);
  return new Response(`v_hk02388="${fields.join('~')}";`);
}

test('HK list, single quote, dividend endpoint inputs and detail share current-price PB/dividends', async () => {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let clock = Date.now(), price = 50.15, mainCalls = 0, eventCalls = 0;
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.hostname === 'qt.gtimg.cn') return quoteResponse(price);
    if (url.searchParams.get('reportName') === 'RPT_HKF10_FN_MAININDICATOR') {
      mainCalls++;
      return Response.json({ success: true, result: { pages: 1, data: [main] } });
    }
    if (url.searchParams.get('reportName') === 'RPT_HKF10_INFO_DIVIDEND') {
      eventCalls++;
      return Response.json({ success: true, result: { pages: 1, data: dividends } });
    }
    throw new Error(`Unexpected upstream: ${url}`);
  };
  Date.now = () => clock;
  clearCache();
  try {
    const list = (await source.getQuotes(['hk02388']))[0];
    const single = await source.getQuote('hk02388');
    const detail = await source.getValuation('hk02388', 5);
    const yieldInput = await source.getHkCurrentValuation('hk02388', single.price, '2026-10-16');
    const yieldRow = await requestYield();
    assert.equal(list.pb, 1.471);
    assert.equal(list.pe, 12.715);
    assert.equal(single.pe, list.pe);
    assert.equal(detail.pe, list.pe);
    assert.equal(detail.marketComparison.pe, 12.7);
    assert.equal(list.dividendYield, 4.24);
    assert.equal(single.pb, list.pb);
    assert.equal(detail.pb, list.pb);
    assert.equal(detail.dividendYield, list.dividendYield);
    assert.equal(yieldInput.dividendYield, list.dividendYield);
    assert.equal(yieldRow.dy, list.dividendYield);
    assert.equal(yieldRow.method, 'hk-static');
    assert.equal(yieldRow.fiscalYear, '2025');
    assert.equal(detail.dividendYieldMethod, 'hk-static');
    assert.equal(detail.dividendFiscalYear, '2025');
    assert.equal(detail.dividendPerShare.total, 2.125);
    assert.equal(detail.fin.bps.toFixed(8), '34.08431755');
    assert.equal(eventCalls, 1, 'all consumers share slow dividend records');
    const slowMainCalls = mainCalls;

    // Expire even the non-trading quote TTL, but keep financial/event inputs cached.
    clock += 600_001;
    price = 100.30;
    const nextList = (await source.getQuotes(['hk02388']))[0];
    const nextDetail = await source.getValuation('hk02388', 5);
    assert.equal(nextList.pb, 2.943);
    assert.equal(nextList.dividendYield, 2.12);
    assert.equal(nextDetail.pb, nextList.pb);
    assert.equal(nextDetail.pe, nextList.pe);
    assert.equal(nextDetail.dividendYield, nextList.dividendYield);
    assert.equal((await requestYield()).dy, nextList.dividendYield, 'the HTTP route also recalculates rather than retaining its old price');
    assert.equal(mainCalls, slowMainCalls, 'price changes do not refetch slow financials');
    assert.equal(eventCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    clearCache();
  }
});

test('a stale single-quote cache cannot combine an old HK price with new financials', async()=>{
  const nativeFetch=globalThis.fetch,nativeNow=Date.now;
  let clock=Date.now(),fail=false;
  globalThis.fetch=async input=>{
    const url=new URL(input);
    if(url.hostname==='qt.gtimg.cn'){
      if(fail)throw Error('offline');
      return quoteResponse(50.15);
    }
    if(url.searchParams.get('reportName')==='RPT_HKF10_FN_MAININDICATOR')return Response.json({success:true,result:{pages:1,data:[main]}});
    if(url.searchParams.get('reportName')==='RPT_HKF10_INFO_DIVIDEND')return Response.json({success:true,result:{pages:1,data:dividends}});
    throw Error('offline');
  };
  Date.now=()=>clock;clearCache();
  try{
    const current=await source.getQuote('hk02388');assert.equal(current.pb,1.471);
    clock+=600_001;fail=true;
    // The producer can fall back to a disk snapshot. Either it returns a stale
    // snapshot or the cache marks its old quote stale; neither is a current price.
    const stale=await source.getQuote('hk02388');
    assert.equal(stale.stale,true);
    assert.equal(stale.pe,null);assert.equal(stale.pb,null);assert.equal(stale.dividendYield,null);
    assert.equal((await requestYield()).dy,null);
  }finally{globalThis.fetch=nativeFetch;Date.now=nativeNow;clearCache();}
});
