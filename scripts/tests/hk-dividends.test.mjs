import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';
const {
  parseHkDps,
  parseHkDividends,
  sumFiscalYearDividend,
  sumTtmDividend,
  sumRollingTtmDividend,
  fetchHkDividends,
} = await load('datasource/hkDividends');

// Eastmoney raw snapshot captured 2026-10-18; fields copied without inventing DPS or dates.
const ACTUAL = {
  '00005': [
    {
      SECURITY_CODE: '00005',
      ASSIGN_PERIOD: '2026三季',
      EX_DIVIDEND_DATE: null,
      NOTICE_DATE: '2026-10-14 00:00:00',
      PLAN_EXPLAIN: null,
      ASSIGN_PROGRESS: '预披露',
    },
    {
      SECURITY_CODE: '00005',
      ASSIGN_PERIOD: '2026二季',
      EX_DIVIDEND_DATE: '2026-08-13 00:00:00',
      NOTICE_DATE: '2026-09-14 00:00:00',
      PLAN_EXPLAIN: '每股派美元0.1元(相当于港币0.784088元)',
      ASSIGN_PROGRESS: '实施分配',
    },
    {
      SECURITY_CODE: '00005',
      ASSIGN_PERIOD: '2026一季',
      EX_DIVIDEND_DATE: '2026-05-14 00:00:00',
      NOTICE_DATE: '2026-06-15 00:00:00',
      PLAN_EXPLAIN: '每股派美元0.1元(相当于港币0.783188元)',
      ASSIGN_PROGRESS: '实施分配',
    },
    {
      SECURITY_CODE: '00005',
      ASSIGN_PERIOD: '2025四季',
      EX_DIVIDEND_DATE: '2026-03-12 00:00:00',
      NOTICE_DATE: '2026-04-20 00:00:00',
      PLAN_EXPLAIN: '每股派美元0.45元(相当于港币3.522942元)',
      ASSIGN_PROGRESS: '实施分配',
    },
    {
      SECURITY_CODE: '00005',
      ASSIGN_PERIOD: '2025三季',
      EX_DIVIDEND_DATE: '2025-11-06 00:00:00',
      NOTICE_DATE: '2025-12-08 00:00:00',
      PLAN_EXPLAIN: '每股派美元0.1元(相当于港币0.777722元)',
      ASSIGN_PROGRESS: '实施分配',
    },
    {
      SECURITY_CODE: '00005',
      ASSIGN_PERIOD: '2025二季',
      EX_DIVIDEND_DATE: '2025-08-14 00:00:00',
      NOTICE_DATE: '2025-09-15 00:00:00',
      PLAN_EXPLAIN: '每股派美元0.1元(相当于港币0.777678元)',
      ASSIGN_PROGRESS: '实施分配',
    },
    {
      SECURITY_CODE: '00005',
      ASSIGN_PERIOD: '2025一季',
      EX_DIVIDEND_DATE: '2025-05-08 00:00:00',
      NOTICE_DATE: '2025-06-09 00:00:00',
      PLAN_EXPLAIN: '每股派美元0.1元(相当于港币0.783972元)',
      ASSIGN_PROGRESS: '实施分配',
    },
    {
      SECURITY_CODE: '00005',
      ASSIGN_PERIOD: '2022末期',
      EX_DIVIDEND_DATE: '2023-03-02 00:00:00',
      NOTICE_DATE: '2023-04-17 00:00:00',
      PLAN_EXPLAIN: '每股派美元0.23元(相当于港币1.804399元)',
      ASSIGN_PROGRESS: '实施分配',
    },
    {
      SECURITY_CODE: '00005',
      ASSIGN_PERIOD: '2022二季',
      EX_DIVIDEND_DATE: '2022-08-18 00:00:00',
      NOTICE_DATE: '2022-09-20 00:00:00',
      PLAN_EXPLAIN: '每股派美元0.09元(相当于港币0.706305元)',
      ASSIGN_PROGRESS: '实施分配',
    },
  ],
  '02388': [
    {
      SECURITY_CODE: '02388',
      ASSIGN_PERIOD: '2026中期',
      EX_DIVIDEND_DATE: '2026-09-10 00:00:00',
      NOTICE_DATE: '2026-08-28 00:00:00',
      PLAN_EXPLAIN: '每股派港币0.29元',
      ASSIGN_PROGRESS: '实施分配',
    },
    {
      SECURITY_CODE: '02388',
      ASSIGN_PERIOD: '2025末期',
      EX_DIVIDEND_DATE: '2026-06-29 00:00:00',
      NOTICE_DATE: '2026-06-25 00:00:00',
      PLAN_EXPLAIN: '每股派港币1.255元',
      ASSIGN_PROGRESS: '实施分配',
    },
    {
      SECURITY_CODE: '02388',
      ASSIGN_PERIOD: '2026一季',
      EX_DIVIDEND_DATE: '2026-05-13 00:00:00',
      NOTICE_DATE: '2026-04-29 00:00:00',
      PLAN_EXPLAIN: '每股派港币0.29元',
      ASSIGN_PROGRESS: '实施分配',
    },
    {
      SECURITY_CODE: '02388',
      ASSIGN_PERIOD: '2025三季',
      EX_DIVIDEND_DATE: '2025-11-12 00:00:00',
      NOTICE_DATE: '2025-10-28 00:00:00',
      PLAN_EXPLAIN: '每股派港币0.29元',
      ASSIGN_PROGRESS: '实施分配',
    },
    {
      SECURITY_CODE: '02388',
      ASSIGN_PERIOD: '2025中期',
      EX_DIVIDEND_DATE: '2025-09-11 00:00:00',
      NOTICE_DATE: '2025-08-29 00:00:00',
      PLAN_EXPLAIN: '每股派港币0.29元',
      ASSIGN_PROGRESS: '实施分配',
    },
    {
      SECURITY_CODE: '02388',
      ASSIGN_PERIOD: '2025一季',
      EX_DIVIDEND_DATE: '2025-05-14 00:00:00',
      NOTICE_DATE: '2025-04-29 00:00:00',
      PLAN_EXPLAIN: '每股派港币0.29元',
      ASSIGN_PROGRESS: '实施分配',
    },
    {
      SECURITY_CODE: '02388',
      ASSIGN_PERIOD: '2022末期',
      EX_DIVIDEND_DATE: '2023-07-03 00:00:00',
      NOTICE_DATE: '2023-06-29 00:00:00',
      PLAN_EXPLAIN: '每股派港币0.91元',
      ASSIGN_PROGRESS: '实施分配',
    },
    {
      SECURITY_CODE: '02388',
      ASSIGN_PERIOD: '2022中期',
      EX_DIVIDEND_DATE: '2022-09-15 00:00:00',
      NOTICE_DATE: '2022-08-30 00:00:00',
      PLAN_EXPLAIN: '每股派港币0.447元',
      ASSIGN_PROGRESS: '实施分配',
    },
  ],
  '00322': [
    {
      SECURITY_CODE: '00322',
      ASSIGN_PERIOD: '2025末期',
      EX_DIVIDEND_DATE: '2026-06-10 00:00:00',
      NOTICE_DATE: '2026-06-08 00:00:00',
      PLAN_EXPLAIN: '每股派人民币0.3992元(相当于港币0.46088元)',
      ASSIGN_PROGRESS: '实施分配',
    },
    {
      SECURITY_CODE: '00322',
      ASSIGN_PERIOD: '特别分配',
      EX_DIVIDEND_DATE: '2026-06-10 00:00:00',
      NOTICE_DATE: '2026-06-08 00:00:00',
      PLAN_EXPLAIN: '每股派人民币0.3992元(相当于港币0.46088元)',
      ASSIGN_PROGRESS: '实施分配',
    },
    {
      SECURITY_CODE: '00322',
      ASSIGN_PERIOD: '2022末期',
      EX_DIVIDEND_DATE: '2023-06-07 00:00:00',
      NOTICE_DATE: '2023-06-05 00:00:00',
      PLAN_EXPLAIN: '每股派人民币0.2336元(相当于港币0.25743元)',
      ASSIGN_PROGRESS: '实施分配',
    },
    {
      SECURITY_CODE: '00322',
      ASSIGN_PERIOD: '特别分配',
      EX_DIVIDEND_DATE: '2023-06-07 00:00:00',
      NOTICE_DATE: '2023-06-05 00:00:00',
      PLAN_EXPLAIN: '每股派人民币0.2336元(相当于港币0.25743元)',
      ASSIGN_PROGRESS: '实施分配',
    },
    {
      SECURITY_CODE: '00322',
      ASSIGN_PERIOD: '2022中期',
      EX_DIVIDEND_DATE: '2022-11-04 00:00:00',
      NOTICE_DATE: '2022-08-22 00:00:00',
      PLAN_EXPLAIN: '每股派美元0.0663元(相当于港币0.5202元)',
      ASSIGN_PROGRESS: '实施分配',
    },
  ],
};
const AS_OF = '2026-10-18';
const cash = (
  period,
  exDate,
  dps,
  noticeDate = exDate,
  progress = '实施分配',
) => ({
  ASSIGN_PERIOD: period,
  EX_DIVIDEND_DATE: exDate,
  NOTICE_DATE: noticeDate,
  PLAN_EXPLAIN: typeof dps === 'number' ? '每股派港币' + dps + '元' : dps,
  ASSIGN_PROGRESS: progress,
});

test('actual HSBC 2025 quarterly dividends sum all four payments in HKD', () => {
  const records = parseHkDividends(ACTUAL['00005'], AS_OF);
  const summary = sumFiscalYearDividend(records, AS_OF);
  assert.equal(summary.fiscalYear, '2025');
  assert.equal(summary.batches, 4);
  assert.equal(summary.ttmDps, 5.862314);
  assert.equal(summary.ordinaryDps, 5.862314);
  assert.equal(summary.specialDps, 0);
  assert.equal(summary.basis, 'completed-fiscal-year');
  assert.equal(summary.complete, true);
  assert.deepEqual(sumTtmDividend(records, AS_OF), summary);
});

test('actual BOC 2025 first/interim/third/final gives .29 * 3 + 1.255', () => {
  const summary = sumFiscalYearDividend(
    parseHkDividends(ACTUAL['02388'], AS_OF),
    AS_OF,
  );
  assert.equal(summary.fiscalYear, '2025');
  assert.equal(summary.batches, 4);
  assert.equal(summary.ttmDps, 2.125);
});

test('latest final-only year outranks an older interim-plus-final year, including real special cash', () => {
  const records = parseHkDividends([...ACTUAL['00322']].reverse(), AS_OF);
  const summary = sumFiscalYearDividend(records, AS_OF);
  assert.equal(summary.fiscalYear, '2025');
  assert.equal(summary.ordinaryDps, 0.46088);
  assert.equal(summary.specialDps, 0.46088);
  assert.equal(summary.ttmDps, 0.92176);
  assert.equal(summary.batches, 2);
});

test('event deduplication removes repeated pages without merging ordinary and special cash', () => {
  const rows = ACTUAL['00322'];
  const parsed = parseHkDividends([...rows, ...structuredClone(rows)], AS_OF);
  assert.equal(parsed.length, parseHkDividends(rows, AS_OF).length);
  const before = structuredClone(parsed);
  assert.equal(
    sumFiscalYearDividend([...parsed, ...parsed], AS_OF).ttmDps,
    0.92176,
  );
  assert.deepEqual(
    parsed,
    before,
    'aggregation does not mutate caller records',
  );
  const revised = [
    {
      ...cash('2025末期', '2026-06-10', 0.2, '2026-06-01'),
      DIVIDEND_ID: 'cash-event',
    },
    {
      ...cash('2025末期', '2026-06-10', 0.25, '2026-06-08'),
      DIVIDEND_ID: 'cash-event',
    },
  ];
  assert.equal(
    sumFiscalYearDividend(parseHkDividends(revised, AS_OF), AS_OF).ttmDps,
    0.25,
  );
  assert.equal(
    sumFiscalYearDividend(
      parseHkDividends([...revised].reverse(), AS_OF),
      AS_OF,
    ).ttmDps,
    0.25,
  );
});

test('latest cancellation of a known event suppresses its earlier implemented disclosure', () => {
  const rows = [
    cash('2025末期', '2026-06-10', 0.2, '2026-06-01'),
    cash('2025末期', '2026-06-10', 0.2, '2026-06-08', '取消分配'),
    cash('2025中期', '2025-09-01', 0.1),
  ];
  const records = parseHkDividends(rows, AS_OF);
  assert.equal(records.length, 1);
  assert.equal(sumFiscalYearDividend(records, AS_OF).ttmDps, null);
});

test('unimplemented, future ex-dates, future disclosures and in-kind distributions are excluded', () => {
  const rows = [
    cash('2025末期', '2026-06-10', 0.5, '2026-06-01'),
    cash(
      '特别分配',
      '2026-06-10',
      '每10股分派1股美团B类普通股股份(相当于每股派18.13港元)',
      '2026-06-01',
    ),
    cash('特别分配', '2026-06-10', 3, '2026-06-01', '预披露'),
    cash('特别分配', '2026-06-10', 4, '2026-06-01', '未实施'),
    cash('特别分配', '2026-06-10', 5, '2026-06-01', '股东大会通过'),
    cash('特别分配', '2026-06-10', 6, '2026-06-01', ''),
    cash('2026中期', '2026-11-01', 2, '2026-06-01'),
    cash('特别分配', '2026-06-10', 7, '2026-11-01'),
  ];
  const records = parseHkDividends(rows, AS_OF);
  assert.equal(records.length, 1);
  assert.equal(sumFiscalYearDividend(records, AS_OF).ttmDps, 0.5);
  assert.equal(parseHkDividends(rows, '2026-06-09').length, 0);
  assert.equal(
    parseHkDividends(rows, new Date('2026-06-09T16:00:00Z')).length,
    1,
  );
  assert.throws(() => parseHkDividends(rows, '2026-02-30'), /日期无效/);
});

test('unknown-year special cash is assigned only to a unique ordinary year in the same announcement batch', () => {
  const records = parseHkDividends(
    [
      cash('2025末期', '2026-06-10', 0.5, '2026-06-01'),
      cash('特别分配', '2026-06-10', 0.5, '2026-06-02'),
    ],
    AS_OF,
  );
  const summary = sumFiscalYearDividend(records, AS_OF);
  assert.equal(summary.ttmDps, 0.5);
  assert.equal(summary.specialDps, 0);
  assert.equal(summary.unassignedSpecialDps, 0.5);
  assert.equal(summary.unassignedSpecialBatches, 1);
  const ambiguous = parseHkDividends(
    [
      cash('2025末期', '2026-06-10', 0.5, '2026-06-01'),
      cash('2024末期', '2026-06-10', 0.2, '2026-06-01'),
      cash('特别分配', '2026-06-10', 0.5, '2026-06-01'),
    ],
    AS_OF,
  );
  assert.equal(
    ambiguous.find((record) => record.special).fiscalYear,
    undefined,
  );
  const noNotice = parseHkDividends(
    [
      cash('2025末期', '2026-06-10', 0.5, ''),
      cash('特别分配', '2026-06-10', 0.5, ''),
    ],
    AS_OF,
  );
  assert.equal(noNotice.find((record) => record.special).fiscalYear, undefined);
});

test('only interim, incomplete quarterly sets and unknown HKD amounts cannot pretend to be a complete year', () => {
  assert.equal(
    sumFiscalYearDividend(
      parseHkDividends([cash('2025中期', '2025-09-01', 0.1)], AS_OF),
      AS_OF,
    ).ttmDps,
    null,
  );
  const quarters = parseHkDividends(
    [
      cash('2025一季', '2025-05-01', 0.1),
      cash('2025三季', '2025-11-01', 0.1),
      cash('2025四季', '2026-03-01', 0.4),
    ],
    AS_OF,
  );
  assert.equal(sumFiscalYearDividend(quarters, AS_OF).fiscalYear, '2025');
  assert.equal(sumFiscalYearDividend(quarters, AS_OF).complete, false);
  const unknown = parseHkDividends(
    [
      cash('2025中期', '2025-09-01', '每股派美元0.1元'),
      cash('2025末期', '2026-03-01', 0.4),
    ],
    AS_OF,
  );
  assert.equal(sumFiscalYearDividend(unknown, AS_OF).ttmDps, null);
  assert.equal(
    sumFiscalYearDividend(
      parseHkDividends([cash('2025末期', '2026-03-01', 0)], AS_OF),
      AS_OF,
    ).ttmDps,
    0,
  );
});

test('a missing latest closed-year amount cannot be silently replaced by an old complete year', () => {
  const records = parseHkDividends(
    [
      cash('2025中期', '2025-09-01', 0.1),
      cash('2025末期', '2026-03-01', '每股派美元0.4元'),
      cash('2022中期', '2022-09-01', 0.2),
      cash('2022末期', '2023-03-01', 0.3),
    ],
    AS_OF,
  );
  const summary = sumFiscalYearDividend(records, AS_OF);
  assert.equal(summary.fiscalYear, '2025');
  assert.equal(summary.ttmDps, null);
  assert.equal(summary.complete, false);
});

test('an incomplete latest Q4 year cannot fall back to an older interim-plus-final year', () => {
  const records = parseHkDividends(
    [
      cash('2026中期', '2026-09-01', 9),
      cash('2025一季', '2025-05-01', 0.1),
      cash('2025三季', '2025-11-01', 0.1),
      cash('2025四季', '2026-03-01', 0.4),
      cash('2022中期', '2022-09-01', 0.2),
      cash('2022末期', '2023-03-01', 0.3),
    ],
    AS_OF,
  );
  const summary = sumFiscalYearDividend(records, AS_OF);
  assert.equal(summary.fiscalYear, '2025');
  assert.equal(summary.ttmDps, null);
  assert.equal(summary.complete, false);
});

test('static fiscal-year and real rolling TTM aggregates remain explicitly different', () => {
  const records = parseHkDividends(
    [
      cash('2026中期', '2026-09-01', 7.43, '2026-08-19'),
      cash('2025末期', '2026-03-11', 6.52, '2026-02-26'),
      cash('2025中期', '2025-09-02', 6, '2025-08-20'),
    ],
    AS_OF,
  );
  assert.equal(sumFiscalYearDividend(records, AS_OF).ttmDps, 12.52);
  const rolling = sumRollingTtmDividend(records, AS_OF);
  assert.equal(rolling.basis, 'rolling-ttm');
  assert.equal(rolling.ttmDps, 13.95);
  assert.equal(rolling.from, '2025-10-18');
  assert.equal(rolling.to, AS_OF);
  const leap = sumRollingTtmDividend(
    parseHkDividends(
      [
        cash('2023中期', '2023-02-28', 1),
        cash('2023末期', '2023-03-01', 2),
        cash('2024中期', '2024-02-29', 3),
      ],
      '2024-02-29',
    ),
    '2024-02-29',
  );
  assert.equal(leap.from, '2023-02-28');
  assert.equal(leap.ttmDps, 5);
});

test('DPS parsing respects disclosed HKD conversion, share basis, zero and cash-vs-in-kind', () => {
  assert.equal(
    parseHkDps('每股派人民币0.3992元(相当于港币0.46088元)'),
    0.46088,
  );
  assert.equal(parseHkDps('每股派美元0.45元(相当于港币3.522942元)'), 3.522942);
  assert.equal(parseHkDps('每10股派港币3元'), 0.3);
  assert.equal(parseHkDps('每股派1.25港元'), 1.25);
  assert.equal(parseHkDps('每股派HKD1.25元'), 1.25);
  assert.equal(parseHkDps('每股派港币0元'), 0);
  assert.equal(parseHkDps('每股派美元0.1元'), null);
  assert.equal(
    parseHkDps('实物分派:每10股分派1股其他公司普通股，相当于港币18元'),
    null,
  );
});

test('dividend fetch keeps pagination identity and reports upstream failures without inventing values', async () => {
  const original = globalThis.fetch;
  const requests = [];
  const quarters = ACTUAL['00005'].filter((row) =>
    /^2025/.test(row.ASSIGN_PERIOD),
  );
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), referer: options.headers.Referer });
    const page = new URL(url).searchParams.get('pageNumber');
    return new Response(
      JSON.stringify({
        success: true,
        result: {
          pages: 2,
          data:
            page === '1' ? quarters.slice(0, 3) : [quarters[2], quarters[3]],
        },
      }),
    );
  };
  try {
    const records = await fetchHkDividends('00005', AS_OF);
    assert.equal(sumFiscalYearDividend(records, AS_OF).ttmDps, 5.862314);
    assert.equal(requests.length, 2);
    assert.ok(
      requests.every(
        (request) =>
          request.referer === 'https://emweb.securities.eastmoney.com/',
      ),
    );
    assert.ok(
      requests.every(
        (request) =>
          new URL(request.url).searchParams.get('reportName') ===
          'RPT_HKF10_INFO_DIVIDEND',
      ),
    );
    await assert.rejects(() => fetchHkDividends('../00005', AS_OF), /代码无效/);
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ success: true, result: { pages: 0, data: [] } }),
      );
    assert.equal(
      sumFiscalYearDividend(await fetchHkDividends('00005', AS_OF), AS_OF)
        .ttmDps,
      null,
    );
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ success: false, result: null }));
    await assert.rejects(
      () => fetchHkDividends('00005', AS_OF),
      /港股分红明细不可用/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
