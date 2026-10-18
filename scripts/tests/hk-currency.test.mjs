import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';
const { hkPerShareValues } = await load('datasource/hkCurrency');
const { parseHkFundamental, computeHkValuation, parseHkDividends } = await load(
  'datasource/hkFundamental',
);
const { summarizeHkSnapshot, fetchHkFinancials } = await load(
  'datasource/hkFinance',
);

// Public F10 snapshots retrieved 2026-10-18, with 2026-10-16 closing quotes.
const samples = [
  [
    '00700',
    417.8,
    124.919978879778,
    3798907009556.2,
    9092644829,
    2.904901147552,
    14.234390088392,
  ],
  [
    '00005',
    149.7,
    68.75442086314,
    2565113016602.7,
    17135023491,
    1.891106541544,
    13.603978813814,
  ],
  [
    '00941',
    80.95,
    67.148338696953,
    1756282331603.7,
    21695890446,
    1.047071660511,
    11.685417533847,
  ],
  [
    '09988',
    108.8,
    53.091355112883,
    2165333195123.2,
    19901959514,
    1.779917649476,
    25.483043963964,
  ],
  [
    '02388',
    50.15,
    29.603934010294,
    530224930339.9,
    10572780266,
    1.471351155048,
    12.71522614724,
  ],
  [
    '00322',
    12.37,
    2.289824605884,
    69734469273.2,
    5637386360,
    4.692046487925,
    13.17280415959,
  ],
  [
    '00883',
    23.96,
    18.010831659719,
    1138817697456.64,
    47529953984,
    1.155441258526,
    7.220382166001,
  ],
].map(
  ([
    code,
    price,
    BPS,
    TOTAL_MARKET_CAP,
    ISSUED_COMMON_SHARES,
    PB_TTM,
    PE_TTM,
  ]) => ({
    code,
    price,
    row: {
      REPORT_DATE: '2026-06-30',
      REPORT_TYPE: '2026年中报',
      CURRENCY: 'HKD',
      IS_CNY_CODE: 0,
      BPS,
      TOTAL_MARKET_CAP,
      ISSUED_COMMON_SHARES,
      PB_TTM,
      PE_TTM,
    },
  }),
);
const rounded = (value, digits = 3) =>
  Math.round(value * 10 ** digits) / 10 ** digits;

test('seven live HK snapshots use same-snapshot source PB/PE and current price, including A/H share structures', () => {
  for (const { code, row, price } of samples) {
    const f = parseHkFundamental([row]);
    const basis = hkPerShareValues(row);
    assert.equal(basis.financialCurrency, 'CNY');
    assert.ok(
      Math.abs(basis.referencePrice - price) < 1e-8,
      `${code} market cap/share count`,
    );
    const current = computeHkValuation(f, null, price, '2026-10-16');
    assert.equal(current.pb, rounded(row.PB_TTM), code);
    assert.equal(current.pe, rounded(row.PE_TTM), code);
    const doubled = computeHkValuation(f, null, price * 2, '2026-10-16');
    assert.equal(
      doubled.pb,
      rounded(row.PB_TTM * 2),
      `${code} PB updates with price`,
    );
    assert.equal(
      doubled.pe,
      rounded(row.PE_TTM * 2),
      `${code} PE updates with price`,
    );
  }
});

test('BOCHK official 2026H1 HKD equity/share count matches normalized BPS, despite CURRENCY being HKD on raw CNY values', () => {
  // https://www.bochk.com/dam/bochk/desktop/top/aboutus/ir/docs/finreport/bochkholdings/2026ir/e101_Fullset.pdf
  // Printed pages 2 and 85/100: HK$360,366m equity / 10,572,780,266 ordinary shares.
  const f = parseHkFundamental([samples.find((s) => s.code === '02388').row]);
  const officialBps = 360366000000 / 10572780266;
  assert.ok(Math.abs(f.bps - officialBps) < 1e-9);
  assert.ok(Math.abs(f.rawBps / officialBps - 0.86855) < 1e-10);
  assert.equal(computeHkValuation(f, null, 50.15).pb, 1.471);
  assert.notEqual(
    computeHkValuation(f, null, 50.15).pb,
    rounded(50.15 / f.rawBps),
  );
});

test('latest nonpositive or missing book values do not fall back to older positive reports; PE is independent', () => {
  const older = { ...samples[4].row, REPORT_DATE: '2025-12-31' };
  for (const BPS of [-1, 0, null]) {
    const latest = { ...samples[4].row, BPS };
    const f = parseHkFundamental([older, latest]);
    assert.equal(f.reportDate, '2026-06-30');
    assert.equal(f.bps, null);
    const result = computeHkValuation(f, null, 50.15);
    assert.equal(result.pb, null);
    assert.equal(result.pe, rounded(latest.PE_TTM));
  }
});

test('missing quote basis or non-HKD counters remain unverified instead of guessing a fixed FX rate', () => {
  const base = samples[4].row;
  for (const changes of [
    { CURRENCY: 'CNY' },
    { CURRENCY: null },
    { IS_CNY_CODE: 1 },
    { TOTAL_MARKET_CAP: null },
    { ISSUED_COMMON_SHARES: 0 },
  ]) {
    const f = parseHkFundamental([{ ...base, ...changes }]);
    const result = computeHkValuation(f, null, 50.15);
    assert.equal(result.pb, null);
    assert.equal(result.pe, null);
  }
});

test('list and detail share the same PE/PB and verified fiscal cash dividends, without converting DPS_HKD again', () => {
  const sample = samples.find((s) => s.code === '00322');
  const dividends = parseHkDividends(
    [
      {
        ASSIGN_PERIOD: '2025末期',
        EX_DIVIDEND_DATE: '2026-06-10',
        NOTICE_DATE: '2026-06-08',
        PLAN_EXPLAIN: '每股派人民币0.3992元(相当于港币0.46088元)',
        ASSIGN_PROGRESS: '实施分配',
      },
      {
        ASSIGN_PERIOD: '特别分配',
        EX_DIVIDEND_DATE: '2026-06-10',
        NOTICE_DATE: '2026-06-08',
        PLAN_EXPLAIN: '每股派人民币0.3992元(相当于港币0.46088元)',
        ASSIGN_PROGRESS: '实施分配',
      },
    ],
    '2026-10-16',
  );
  const f = parseHkFundamental([sample.row]);
  const current = computeHkValuation(f, dividends, sample.price, '2026-10-16');
  const points = [
    {
      date: '2026-06-30',
      label: '2026中报',
      kind: 'semi',
      currency: 'HKD',
      raw: { ...sample.row, DPS_HKD: 999 },
    },
  ];
  const result = summarizeHkSnapshot(
    points,
    sample.code,
    { price: sample.price, pe: 999 },
    '2026-10-16',
    5,
    current,
  );
  assert.equal(result.pb, current.pb);
  assert.equal(result.pe, current.pe);
  assert.equal(result.fin.bps, current.bookValuePerShareHkd);
  assert.equal(
    result.dividendYield,
    rounded((0.92176 / sample.price) * 100, 2),
  );
  assert.equal(result.dividendFiscalYear, '2025');
  assert.deepEqual(result.dividendPerShare, {
    ordinary: 0.46088,
    special: 0.46088,
    total: 0.92176,
  });
  assert.equal(
    summarizeHkSnapshot(
      points,
      sample.code,
      { price: sample.price, pe: 999 },
      '2026-10-16',
      5,
    ).dividendYield,
    null,
  );
});

test('main indicator financial series report their actual CNY unit rather than the HKD trading counter', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        success: true,
        result: {
          data: [{ ...samples[4].row, BASIC_EPS: 1.950155315 }],
        },
      }),
    );
  try {
    const f = await fetchHkFinancials('02388.HK', '02388', 5);
    assert.equal(f.currency, 'CNY');
    assert.deepEqual(f.series.eps, [1.950155315]);
  } finally {
    globalThis.fetch = original;
  }
});
