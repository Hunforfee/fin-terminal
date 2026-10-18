import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';

const { fetchHkFundamentals, computeHkValuation } = await load(
  'datasource/hkFundamental',
);
const { getIndustryQuotes, getHkCurrentValuation } =
  await load('datasource/index');
const { clearCache } = await load('datasource/cache');

// BOCHK: provider BPS is CNY even though CURRENCY labels the HKD quote.
const main = {
  SECURITY_CODE: '02388',
  REPORT_DATE: '2026-06-30',
  REPORT_TYPE: '2026年中报',
  CURRENCY: 'HKD',
  BPS: 29.603934010294,
  EPS_TTM: 3.46623926233,
  TOTAL_MARKET_CAP: 530224930339.9,
  ISSUED_COMMON_SHARES: 10572780266,
  PB_TTM: 1.471351155048,
  PE_TTM: 12.71522614724,
};

function page(data, pages = 1) {
  return Response.json({ success: true, result: { pages, data } });
}

async function withFetch(mock, run) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  clearCache();
  try {
    await run();
  } finally {
    globalThis.fetch = original;
    clearCache();
  }
}

function requestCodes(url) {
  return [...url.searchParams.get('filter').matchAll(/"(\d{5})"/g)].map(
    (match) => match[1],
  );
}

function quoteBody(symbols, price = 50.15) {
  return new Response(
    symbols
      .map((symbol) => {
        const fields = Array(78).fill('');
        for (const [key, value] of Object.entries({
          0: 100,
          1: 'fixture',
          2: symbol.slice(2),
          3: price,
          4: price,
          5: price,
          6: 100,
          30: '2026/10/16 16:08:22',
          31: 0,
          32: 0,
          33: price,
          34: price,
          36: 100,
          37: 1000,
          39: -12.7,
          44: 5302.2493,
          45: 5302.2493,
          46: 1.2,
        }))
          fields[Number(key)] = String(value);
        return `v_${symbol}="${fields.join('~')}";`;
      })
      .join('\n'),
  );
}

test('batch finds latest per company across pages and never revives older positive BPS', async () => {
  const requests = [];
  await withFetch(
    async (input) => {
      const url = new URL(input);
      requests.push(url);
      assert.equal(url.searchParams.get('sortColumns'), 'REPORT_DATE');
      assert.equal(url.searchParams.get('sortTypes'), '-1');
      assert.equal(url.searchParams.get('pageSize'), '500');
      const number = Number(url.searchParams.get('pageNumber'));
      if (number === 1)
        return page(
          [
            { ...main },
            { ...main, REPORT_DATE: '2025-12-31', BPS: 20 },
            { ...main, SECURITY_CODE: '00700', REPORT_DATE: '' },
          ],
          8,
        );
      if (number === 2)
        return page(
          [
            {
              ...main,
              SECURITY_CODE: '00700',
              REPORT_DATE: '2026-03-31',
              BPS: -1,
            },
            {
              ...main,
              SECURITY_CODE: '00700',
              REPORT_DATE: '2025-03-31',
              BPS: 30,
            },
          ],
          8,
        );
      throw new Error('Already found every requested company');
    },
    async () => {
      const result = await fetchHkFundamentals([
        '02388',
        '00700',
        '02388',
        'invalid',
      ]);
      assert.equal(result.size, 2);
      assert.equal(result.get('02388').reportDate, '2026-06-30');
      assert.equal(result.get('00700').reportDate, '2026-03-31');
      assert.equal(result.get('00700').bps, null);
      assert.equal(computeHkValuation(result.get('00700'), null, 50).pb, null);
      assert.equal(requests.length, 2);
    },
  );
});

test('an absent company stays null and pagination is bounded even if upstream advertises huge history', async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      return page([{ ...main, REPORT_DATE: '2026-06-30' }], 999_999);
    },
    async () => {
      const result = await fetchHkFundamentals(['02388', '00001']);
      assert.equal(result.get('00001'), null);
      assert.equal(result.get('02388').reportDate, '2026-06-30');
      assert.equal(calls, 8);
    },
  );
});

test('last page and empty page stop scanning, and partial failure preserves completed companies', async () => {
  for (const mode of ['last', 'empty', 'failure']) {
    let calls = 0;
    await withFetch(
      async () => {
        calls++;
        if (calls === 1) return page([{ ...main }], mode === 'last' ? 1 : 20);
        if (mode === 'empty') return page([], 20);
        throw new Error('Page unavailable');
      },
      async () => {
        const result = await fetchHkFundamentals(['02388', '00001']);
        assert.equal(result.get('00001'), null, mode);
        assert.equal(result.get('02388').reportDate, '2026-06-30', mode);
        assert.equal(
          calls,
          mode === 'last' ? 1 : 2,
          'failed pages do not trigger per-security retries',
        );
      },
    );
  }
});

test('baskets use at most 30 codes per request and two concurrent report batches', async () => {
  const codes = Array.from({ length: 65 }, (_, i) =>
    String(i + 1).padStart(5, '0'),
  );
  let active = 0,
    maxActive = 0,
    requests = 0;
  await withFetch(
    async (input) => {
      const url = new URL(input),
        batch = requestCodes(url);
      requests++;
      assert.ok(batch.length <= 30);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return page(batch.map((code) => ({ ...main, SECURITY_CODE: code })));
    },
    async () => {
      const result = await fetchHkFundamentals(codes);
      assert.equal(result.size, 65);
      assert.ok([...result.values()].every((value) => value !== null));
      assert.equal(requests, 3);
      assert.equal(maxActive, 2);
    },
  );
});

test('industry uses shared HKD PB at current price, retains raw PE and requests no dividends', async () => {
  const originalNow = Date.now;
  let clock = Date.now(),
    price = 50.15,
    financialCalls = 0,
    dividendCalls = 0;
  Date.now = () => clock;
  try {
    await withFetch(
      async (input) => {
        const url = new URL(input);
        if (url.hostname === 'qt.gtimg.cn')
          return quoteBody(url.pathname.slice(3).split(','), price);
        const report = url.searchParams.get('reportName');
        if (report === 'RPT_HKF10_FN_MAININDICATOR') {
          financialCalls++;
          const codes = requestCodes(url);
          assert.equal(
            codes.length,
            2,
            'financial reports are fetched as one basket',
          );
          return page(codes.map((code) => ({ ...main, SECURITY_CODE: code })));
        }
        if (report === 'RPT_HKF10_INFO_DIVIDEND') {
          dividendCalls++;
          return page([]);
        }
        throw new Error(`Unexpected upstream: ${url}`);
      },
      async () => {
        const inputs = ['hk02388', 'hk00700', 'hk02388'];
        const [first, repeated] = await Promise.all([
          getIndustryQuotes(inputs),
          getIndustryQuotes(inputs),
        ]);
        assert.deepEqual(repeated, first);
        assert.equal(first.length, 2);
        assert.equal(first[0].pb, 1.471);
        assert.equal(
          first[0].pe,
          -12.7,
          'negative native PE remains available for loss counts',
        );
        assert.equal(first[0].dividendYield, null);
        assert.equal(financialCalls, 1);
        assert.equal(dividendCalls, 0);
        clock += 600_001;
        price *= 2;
        const next = await getIndustryQuotes(inputs);
        assert.equal(next[0].pb, 2.943);
        assert.equal(
          financialCalls,
          1,
          'financial caches survive quote refreshes',
        );
        assert.equal(dividendCalls, 0);
        const normal = await getHkCurrentValuation(
          'hk02388',
          price,
          '2026-10-16',
        );
        assert.equal(normal.pb, next[0].pb);
        assert.equal(
          financialCalls,
          1,
          'ordinary quote/detail reuses the same fundamental',
        );
        assert.equal(
          dividendCalls,
          1,
          'only the explicitly requested full valuation fetches dividends',
        );
      },
    );
  } finally {
    Date.now = originalNow;
  }
});

test('missing financial reports are null, briefly cached, and can recover without a six-hour lockout', async () => {
  const originalNow = Date.now;
  let clock = Date.now(),
    financialCalls = 0;
  Date.now = () => clock;
  try {
    await withFetch(
      async (input) => {
        const url = new URL(input);
        if (url.hostname === 'qt.gtimg.cn') return quoteBody(['hk00001']);
        assert.equal(
          url.searchParams.get('reportName'),
          'RPT_HKF10_FN_MAININDICATOR',
        );
        financialCalls++;
        return page(
          financialCalls === 1 ? [] : [{ ...main, SECURITY_CODE: '00001' }],
        );
      },
      async () => {
        assert.equal((await getIndustryQuotes(['hk00001']))[0].pb, null);
        assert.equal((await getIndustryQuotes(['hk00001']))[0].pb, null);
        assert.equal(financialCalls, 1);
        clock += 60_001;
        assert.equal((await getIndustryQuotes(['hk00001']))[0].pb, 1.471);
        assert.equal(financialCalls, 2);
      },
    );
  } finally {
    Date.now = originalNow;
  }
});

test('mainland industry quotes reuse ordinary batching and resolve stock-code ambiguity', async () => {
  await withFetch(
    async (input) => {
      const url = new URL(input);
      assert.equal(
        url.hostname,
        'qt.gtimg.cn',
        'no HK financial or dividend lookup for mainland stocks',
      );
      assert.equal(url.pathname, '/q=sz000001,sh600519');
      return quoteBody(['sz000001', 'sh600519']);
    },
    async () => {
      const result = await getIndustryQuotes([
        '000001',
        '600519',
        '000001',
        'invalid',
      ]);
      assert.deepEqual(
        result.map((quote) => quote.symbol),
        ['sz000001', 'sh600519'],
      );
      assert.equal(result[0].pb, 1.2);
    },
  );
});
