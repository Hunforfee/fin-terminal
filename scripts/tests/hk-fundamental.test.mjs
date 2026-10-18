import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';
const { parseHkFundamental, computeHkValuation, fetchHkFundamental } = await load('datasource/hkFundamental');
const { parseQuoteLine } = await load('datasource/tencent');

test('hk quote snapshots must not carry pb or dividend yield from positional fields', () => {
  // 真实腾讯港股行情：字段 72 是 52 周低 411.0，字段 58 是年内涨幅 2.92%
  // 2026-10-16 收盘后的真实响应（78 个字段）
  const line = '100~腾讯控股~00700~417.800~417.800~424.000~18752869.0~0~0~417.800~0~0~0~0~0~0~0~0~0~417.800~0~0~0~0~0~0~0~0~0~18752869.0~2026/10/16 16:08:22~0.000~0.00~428.800~415.800~417.800~18752869.0~7901198756.124~0~15.26~~0~0~3.11~37989.0701~37989.0701~TENCENT~1.27~658.700~411.000~1.07~-3.13~0~0~0~0~0~14.01~2.92~0.21~100~-29.63~-1.65~GP~20.41~11.00~-0.81~-1.92~-6.15~9092644829.00~9092644829.00~14.46~5.315~421.333~-29.45~HKD~1~50';
  const q = parseQuoteLine('hk00700', line);
  assert.equal(q.price, 417.8);
  assert.equal(q.low52w, 411);
  assert.equal(q.pb, null, 'PB 必须留空，不能把 52 周低当成 PB');
  assert.equal(q.dividendYield ?? null, null, '股息率必须留空，不能把年内涨幅当成股息率');
});

test('pb and dividend yield are derived from BPS / DPS and price', () => {
  const f = parseHkFundamental([
    { REPORT_DATE: '2026-06-30 00:00:00', REPORT_TYPE: '2026年中报', BPS: 124.919978879778, DPS_HKD: 5.3, PB_TTM: 2.9049 },
  ]);
  assert.equal(f.reportDate, '2026-06-30');
  const v = computeHkValuation(f, 417.8);
  assert.equal(v.pb, 3.345);
  assert.equal(v.dividendYield, 1.27);
});

test('a stock with no dividend keeps yield null instead of zero', () => {
  const f = parseHkFundamental([{ REPORT_DATE: '2026-06-30', BPS: 10.455, DPS_HKD: null }]);
  const v = computeHkValuation(f, 50.4);
  assert.equal(v.pb, 4.821);
  assert.equal(v.dividendYield, null);
});

test('missing fundamentals or price leaves valuation empty rather than guessing', () => {
  assert.deepEqual(computeHkValuation(null, 100), {
    pb: null, dividendYield: null, reportDate: null, reportType: null,
  });
  const f = parseHkFundamental([{ REPORT_DATE: '2026-06-30', BPS: 5, DPS_HKD: 0.5 }]);
  assert.equal(computeHkValuation(f, null).pb, null);
});

test('eastmoney hk fundamental request uses securities report and reports upstream failure', async () => {
  const original = globalThis.fetch;
  let seen = '';
  globalThis.fetch = async (url) => {
    seen = String(url);
    return new Response(JSON.stringify({
      success: true,
      result: { pages: 1, data: [{ REPORT_DATE: '2026-06-30 00:00:00', BPS: 2.2898, DPS_HKD: 0.46088 }] },
    }));
  };
  try {
    const f = await fetchHkFundamental('00322');
    assert.equal(f.bps, 2.2898);
    assert.match(seen, /RPT_HKF10_FN_MAININDICATOR/);
    assert.match(seen, /SECURITY_CODE%3D%2200322%22/);
  } finally {
    globalThis.fetch = original;
  }

  globalThis.fetch = async () => new Response(JSON.stringify({ success: false, result: null }));
  try {
    await assert.rejects(() => fetchHkFundamental('00700'), /港股财务指标不可用/);
  } finally {
    globalThis.fetch = original;
  }
});
