import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';
const { parseHkFundamental, computeHkValuation, fetchHkFundamental, parseHkDividends, parseHkDps, sumTtmDividend } =
  await load('datasource/hkFundamental');
const { parseQuoteLine } = await load('datasource/tencent');

// 2026-10-16 收盘后的真实响应（78 个字段）
const TENCENT_LINE =
  '100~腾讯控股~00700~417.800~417.800~424.000~18752869.0~0~0~417.800~0~0~0~0~0~0~0~0~0~417.800~0~0~0~0~0~0~0~0~0~18752869.0~2026/10/16 16:08:22~0.000~0.00~428.800~415.800~417.800~18752869.0~7901198756.124~0~15.26~~0~0~3.11~37989.0701~37989.0701~TENCENT~1.27~658.700~411.000~1.07~-3.13~0~0~0~0~0~14.01~2.92~0.21~100~-29.63~-1.65~GP~20.41~11.00~-0.81~-1.92~-6.15~9092644829.00~9092644829.00~14.46~5.315~421.333~-29.45~HKD~1~50';

const HKEX = [
  { ASSIGN_PERIOD: '2026中期', EX_DIVIDEND_DATE: '2026-09-01', NOTICE_DATE: '2026-08-19', PLAN_EXPLAIN: '每股派港币7.43元', ASSIGN_PROGRESS: '实施分配' },
  { ASSIGN_PERIOD: '2025末期', EX_DIVIDEND_DATE: '2026-03-11', NOTICE_DATE: '2026-02-26', PLAN_EXPLAIN: '每股派港币6.52元', ASSIGN_PROGRESS: '实施分配' },
  { ASSIGN_PERIOD: '2025中期', EX_DIVIDEND_DATE: '2025-09-02', NOTICE_DATE: '2025-08-20', PLAN_EXPLAIN: '每股派港币6元', ASSIGN_PROGRESS: '实施分配' },
  { ASSIGN_PERIOD: '2024末期', EX_DIVIDEND_DATE: '2025-03-12', NOTICE_DATE: '2025-02-27', PLAN_EXPLAIN: '每股派港币4.9元', ASSIGN_PROGRESS: '实施分配' },
];

test('hk quote snapshots must not carry pb or dividend yield from positional fields', () => {
  // 真实腾讯港股行情：字段 72 是 52 周低 411.0，字段 58 是年内涨幅 2.92%
  const q = parseQuoteLine('hk00700', TENCENT_LINE);
  assert.equal(q.price, 417.8);
  assert.equal(q.low52w, 411, '字段 72 是 52 周低');
  assert.equal(q.pb, null, 'PB 不能由行情字段推断');
  assert.equal(q.dividendYield ?? null, null, '股息率不能由行情字段推断');
});

test('dividend yield sums one fiscal year (interim + final), not a rolling 12-month slice', () => {
  // 按除息日滚动 12 个月会得到 6.52 + 7.43 = 13.95（跨了两个财年，港交所真实值偏高 60%）
  const v = computeHkValuation(
    { reportDate: '2026-06-30', reportType: '', bps: 41.553, totalMarketCap: null },
    parseHkDividends(HKEX),
    374.6,
  );
  assert.equal(v.fiscalYear, '2025');
  assert.equal(v.batches, 2);
  assert.equal(v.ttmDps, 12.52);
  assert.equal(v.dividendYield, 3.34);
});

test('duplicated disclosure of the same fiscal year slot is counted once', () => {
  const rows = [
    { ASSIGN_PERIOD: '2025末期', EX_DIVIDEND_DATE: '2026-06-08', NOTICE_DATE: '2026-06-08', PLAN_EXPLAIN: '每股派人民币0.3992元(相当于港币0.46088元)', ASSIGN_PROGRESS: '实施分配' },
    { ASSIGN_PERIOD: '特别分配', EX_DIVIDEND_DATE: '2026-06-08', NOTICE_DATE: '2026-06-08', PLAN_EXPLAIN: '每股派人民币0.3992元(相当于港币0.46088元)', ASSIGN_PROGRESS: '实施分配' },
  ];
  const s = sumTtmDividend(parseHkDividends(rows));
  assert.equal(s.ttmDps, 0.46088, '特别分配与末期同日同额时不能翻倍');
});

test('hkd amount is taken from the converted quote, other currencies are not guessed', () => {
  assert.equal(parseHkDps('每股派人民币2.51元(相当于港币2.9003元)'), 2.9003);
  assert.equal(parseHkDps('每股派港币5.3元'), 5.3);
  assert.equal(parseHkDps('每股派美元0.13125元(相当于港币1.027545元(计算值))'), 1.027545);
  assert.equal(parseHkDps('每股派人民币0.5元'), null, '无港币折算值时不能猜测汇率');
  assert.equal(parseHkDps('特殊说明:每10股分派1股美团B类普通股股份(相当于每股派18.13港元)'), null, '股份分派不是现金股息');
});

test('cancelled plans are excluded', () => {
  const rows = [
    { ASSIGN_PERIOD: '2025末期', EX_DIVIDEND_DATE: '2026-03-11', NOTICE_DATE: '2026-02-26', PLAN_EXPLAIN: '每股派港币6.52元', ASSIGN_PROGRESS: '取消分配' },
    { ASSIGN_PERIOD: '2025中期', EX_DIVIDEND_DATE: '2025-09-02', NOTICE_DATE: '2025-08-20', PLAN_EXPLAIN: '每股派港币6元', ASSIGN_PROGRESS: '实施分配' },
  ];
  const s = sumTtmDividend(parseHkDividends(rows));
  assert.equal(s.ttmDps, 6);
});

test('pb uses latest book value per share and price', () => {
  const f = parseHkFundamental([{ REPORT_DATE: '2026-06-30 00:00:00', REPORT_TYPE: '2026年中报', BPS: 124.919978879778 }]);
  const v = computeHkValuation(f, [], 417.8);
  assert.equal(v.pb, 3.345);
  assert.equal(v.dividendYield, null, '没有派息记录时股息率留空，不填 0');
});

test('missing fundamentals, dividends or price leave values empty rather than guessing', () => {
  const empty = computeHkValuation(null, null, 100);
  assert.equal(empty.pb, null);
  assert.equal(empty.dividendYield, null);
  const f = parseHkFundamental([{ REPORT_DATE: '2026-06-30', BPS: 5 }]);
  assert.equal(computeHkValuation(f, [], null).pb, null);
});

test('eastmoney hk fundamental request uses securities report and reports upstream failure', async () => {
  const original = globalThis.fetch;
  let seen = '';
  globalThis.fetch = async (url) => {
    seen = String(url);
    return new Response(JSON.stringify({
      success: true,
      result: { pages: 1, data: [{ REPORT_DATE: '2026-06-30 00:00:00', BPS: 2.2898 }] },
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
