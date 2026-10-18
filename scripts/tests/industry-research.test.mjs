import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';
const {
  industryStockSymbol,
  summarizeIndustry,
  filterIndustryRows,
  sortIndustryRows,
  compareIndustryChildren,
} = await load('industryResearch');

const row = (code, fields = {}) => ({
  code,
  name: code,
  price: 10,
  changePct: null,
  pe: null,
  pb: null,
  totalMarketCap: null,
  turnoverRate: null,
  quoteAvailable: true,
  ...fields,
});
const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test('industry stock symbols resolve the Beijing 920 prefix and stock/index code collisions while excluding B shares', () => {
  assert.equal(industryStockSymbol('920087'), 'bj920087');
  assert.equal(industryStockSymbol('000001'), 'sz000001');
  assert.equal(industryStockSymbol('600519'), 'sh600519');
  for (const code of ['200019', '900908', '00700', 'sh600519', 'bad', '899050'])
    assert.equal(industryStockSymbol(code), null, code);
});

test('summary uses positive PE/PB medians, explicit loss coverage and independent unchanged/unknown price counts', () => {
  const rows = [
    row('600001', {
      pe: 10,
      pb: 1,
      totalMarketCap: 50,
      changePct: 2,
      roeEstimate: 10,
    }),
    row('600002', {
      pe: 30,
      pb: 3,
      totalMarketCap: 30,
      changePct: -1,
      roeEstimate: 20,
      stale: true,
    }),
    row('600003', { pe: -100, pb: -2, totalMarketCap: 10, changePct: 0 }),
    row('600004', { pe: 0, pb: 0, totalMarketCap: 10 }),
    row('600005', { pe: NaN, pb: Infinity }),
    row('600006', { price: null, quoteAvailable: false }),
    row('600007', {
      quoteAvailable: false,
      pe: 99,
      pb: 99,
      totalMarketCap: 999,
    }),
  ];
  const s = summarizeIndustry(rows, 9);
  assert.equal(s.totalCount, 9);
  assert.equal(s.quotedCount, 5);
  assert.equal(s.missingQuoteCount, 4);
  assert.equal(s.staleQuoteCount, 1);
  assert.equal(s.positivePeMedian, 20);
  assert.equal(s.positivePeCount, 2);
  assert.equal(s.peAvailableCount, 3);
  assert.equal(s.lossCount, 1);
  approx(s.lossSharePct, 100 / 3);
  assert.equal(s.positivePbMedian, 2);
  assert.equal(s.positivePbCount, 2);
  assert.equal(s.pbAvailableCount, 3);
  assert.equal(s.estimatedRoeMedian, 15);
  assert.equal(s.estimatedRoeCount, 2);
  assert.equal(s.totalMarketCap, 100);
  assert.equal(s.marketCapCount, 4);
  assert.equal(s.top5MarketCapSharePct, 100);
  approx(s.marketCapHhi, 3600);
  assert.deepEqual(
    [s.upCount, s.downCount, s.flatCount, s.changeAvailableCount],
    [1, 1, 1, 3],
  );
});

test('summary deduplicates the same stock, prefers an actual quote and leaves empty or zero-only samples unknown', () => {
  const q = row('600001', { pe: 10, pb: 1, totalMarketCap: 10 });
  const s = summarizeIndustry([row('600001', { quoteAvailable: false }), q, q]);
  assert.equal(s.totalCount, 1);
  assert.equal(s.quotedCount, 1);
  assert.equal(s.totalMarketCap, 10);
  const none = summarizeIndustry([
    row('600002', { pe: 0, pb: 0, totalMarketCap: 0 }),
  ]);
  assert.equal(none.positivePeMedian, null);
  assert.equal(none.lossSharePct, null);
  assert.equal(none.totalMarketCap, null);
  assert.equal(none.top5MarketCapSharePct, null);
  assert.equal(none.marketCapHhi, null);
  assert.equal(none.estimatedRoeMedian, null);
  const empty = summarizeIndustry([]);
  assert.equal(empty.totalCount, 0);
  assert.equal(empty.quotedCount, 0);
  assert.equal(empty.missingQuoteCount, 0);
});

test('market-cap concentration describes only the available positive-cap sample', () => {
  const rows = Array.from({ length: 6 }, (_, i) =>
    row(`60000${i}`, { totalMarketCap: 10 }),
  );
  rows.push(row('600099', { price: null, quoteAvailable: false }));
  const s = summarizeIndustry(rows);
  assert.equal(s.totalCount, 7);
  assert.equal(s.marketCapCount, 6);
  approx(s.top5MarketCapSharePct, (5 / 6) * 100);
  approx(s.marketCapHhi, 10000 / 6);
});

test('table filters combine normalized search, PE sign and quote availability without modifying input', () => {
  const rows = [
    row('600001', { name: 'ABC公司', pe: 12, l3: '白酒Ⅲ' }),
    row('600002', { name: '亏损公司', pe: -5 }),
    row('600003', { quoteAvailable: false }),
    row('600004', { pe: 0 }),
  ];
  assert.deepEqual(
    filterIndustryRows(rows, {
      query: 'ａｂｃ',
      profitability: 'profitable',
    }).map((r) => r.code),
    ['600001'],
  );
  assert.deepEqual(
    filterIndustryRows(rows, { query: '白酒' }).map((r) => r.code),
    ['600001'],
  );
  assert.deepEqual(
    filterIndustryRows(rows, { profitability: 'loss-making' }).map(
      (r) => r.code,
    ),
    ['600002'],
  );
  assert.deepEqual(
    filterIndustryRows(rows, { profitability: 'missing-pe' }).map(
      (r) => r.code,
    ),
    ['600003', '600004'],
  );
  assert.deepEqual(
    filterIndustryRows(rows, { quotes: 'missing' }).map((r) => r.code),
    ['600003'],
  );
  assert.equal(rows.length, 4);
});

test('ascending and descending sorting always place null, NaN and Infinity last and preserve ties', () => {
  const rows = [
    row('600001', { pe: null }),
    row('600002', { pe: 20 }),
    row('600003', { pe: 10 }),
    row('600004', { pe: NaN }),
    row('600005', { pe: Infinity }),
    row('600006', { pe: 10 }),
  ];
  assert.deepEqual(
    sortIndustryRows(rows, 'pe', 'asc').map((r) => r.code),
    ['600003', '600006', '600002', '600001', '600004', '600005'],
  );
  assert.deepEqual(
    sortIndustryRows(rows, 'pe', 'desc').map((r) => r.code),
    ['600002', '600003', '600006', '600001', '600004', '600005'],
  );
  assert.equal(rows[0].code, '600001');
});

test('child comparisons include empty children and explicitly retain members without deeper classification', () => {
  const rows = [
    row('600001', { l1: '食品饮料', l2: '白酒Ⅱ', l3: '白酒Ⅲ', pe: 10 }),
    row('600002', { l1: '食品饮料', l2: '白酒Ⅱ', l3: '白酒Ⅲ', pe: 30 }),
    row('600003', {
      l1: '食品饮料',
      l2: '白酒Ⅱ',
      l3: null,
      quoteAvailable: false,
    }),
  ];
  const children = compareIndustryChildren(rows, 3, [
    { name: '白酒Ⅲ', count: 2 },
    { name: '空分类', count: 0 },
  ]);
  assert.equal(children.length, 3);
  assert.equal(children[0].summary.positivePeMedian, 20);
  assert.equal(children[1].summary.totalCount, 0);
  assert.equal(children[2].name, '未细分');
  assert.equal(children[2].unclassified, true);
  assert.equal(children[2].summary.totalCount, 1);
  assert.equal(children[2].summary.missingQuoteCount, 1);
  assert.equal(compareIndustryChildren(rows, 2)[0].summary.totalCount, 3);
});
