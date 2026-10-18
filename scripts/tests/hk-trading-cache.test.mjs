import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';

const { isShanghaiTradingTime, isHongKongTradingTime } = await load(
  'datasource/tradingTime',
);
const { defaultTtl, clearCache } = await load('datasource/cache');
const { getQuote, getQuotes, getIndustryQuotes } =
  await load('datasource/index');

test('HK quote TTL follows UTC+8 morning, afternoon and closing auction while A-share hours stay unchanged', () => {
  for (const input of [
    '2026-10-19T11:45:00+08:00',
    '2026-10-19T03:45:00Z',
    '2026-10-19T15:30:00+08:00',
    '2026-10-19T16:09:00+08:00',
  ]) {
    const date = new Date(input);
    assert.equal(isHongKongTradingTime(date), true, input);
    assert.equal(isShanghaiTradingTime(date), false, input);
    assert.equal(defaultTtl('HK', date), 15_000, input);
    assert.equal(defaultTtl('A', date), 600_000, input);
  }
  for (const input of [
    '2026-10-19T12:30:00+08:00',
    '2026-10-19T16:11:00+08:00',
    '2026-10-17T11:45:00+08:00',
    '2026-10-18T15:30:00+08:00',
  ]) {
    const date = new Date(input);
    assert.equal(isHongKongTradingTime(date), false, input);
    assert.equal(defaultTtl('HK', date), 600_000, input);
  }
  const opening = new Date('2026-10-19T09:20:00+08:00');
  assert.equal(
    defaultTtl('A', opening),
    15_000,
    'existing mainland pre-open TTL is retained',
  );
  assert.equal(defaultTtl('HK', opening), 600_000);
});

function quoteBody(symbols) {
  return new Response(
    symbols
      .map((symbol) => {
        const fields = Array(78).fill('');
        for (const [key, value] of Object.entries({
          0: 100,
          1: 'fixture',
          2: symbol.slice(2),
          3: 10,
          4: 10,
          5: 10,
          6: 100,
          30: '2026/10/19 15:30:00',
          31: 0,
          32: 0,
          33: 10,
          34: 10,
          36: 100,
          37: 1000,
          39: 12.7,
          44: 100,
          45: 100,
          46: 1.2,
        }))
          fields[Number(key)] = String(value);
        return `v_${symbol}="${fields.join('~')}";`;
      })
      .join('\n'),
  );
}

async function withClock(input, run) {
  const NativeDate = globalThis.Date,
    originalFetch = globalThis.fetch;
  let clock = NativeDate.parse(input),
    quoteReads = 0;
  globalThis.Date = class extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [clock]));
    }
    static now() {
      return clock;
    }
  };
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.hostname === 'qt.gtimg.cn') {
      quoteReads++;
      return quoteBody(url.pathname.slice(3).split(','));
    }
    if (url.searchParams.get('reportName')?.startsWith('RPT_HKF10_'))
      return Response.json({ success: true, result: { pages: 1, data: [] } });
    throw new Error(`Unexpected upstream: ${url}`);
  };
  clearCache();
  try {
    await run({
      advance: (ms) => {
        clock += ms;
      },
      reads: () => quoteReads,
    });
  } finally {
    globalThis.Date = NativeDate;
    globalThis.fetch = originalFetch;
    clearCache();
  }
}

const readers = [
  ['single', (symbol) => getQuote(symbol)],
  ['batch', (symbol) => getQuotes([symbol])],
  ['industry', (symbol) => getIndustryQuotes([symbol])],
];

test('single, ordinary batch and industry HK quotes refresh after 15 seconds in HK-only trading periods', async () => {
  for (const input of [
    '2026-10-19T11:45:00+08:00',
    '2026-10-19T15:30:00+08:00',
  ]) {
    for (const [kind, read] of readers) {
      await withClock(input, async ({ advance, reads }) => {
        await read('hk00005');
        await read('hk00005');
        assert.equal(reads(), 1, kind);
        advance(15_001);
        await read('hk00005');
        assert.equal(reads(), 2, `${kind} at ${input}`);
      });
      await withClock(input, async ({ advance, reads }) => {
        await read('sh600519');
        advance(15_001);
        await read('sh600519');
        assert.equal(
          reads(),
          1,
          `${kind} keeps the original A-share closed-market TTL`,
        );
      });
    }
  }
});

test('HK pre-open/lunch long caches do not spill into the next trading session', async () => {
  for (const input of [
    '2026-10-19T09:29:00+08:00',
    '2026-10-19T12:59:00+08:00',
  ]) {
    for (const [kind, read] of readers) {
      await withClock(input, async ({ advance, reads }) => {
        await read('hk00005');
        advance(60_000);
        await read('hk00005');
        assert.equal(reads(), 2, `${kind} at ${input}`);
      });
    }
  }
});

test('a mixed basket refreshes when either market is trading, including the mainland pre-open', async () => {
  for (const input of [
    '2026-10-19T09:20:00+08:00',
    '2026-10-19T15:30:00+08:00',
  ]) {
    await withClock(input, async ({ advance, reads }) => {
      await getQuotes(['sh600519', 'hk00005']);
      advance(15_001);
      await getQuotes(['sh600519', 'hk00005']);
      assert.equal(reads(), 2, input);
    });
  }
});
