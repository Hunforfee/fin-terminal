import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { load } from './load-modules.mjs';
const classification = await load('sw2021');
const helpers = await load('industryResearch');
const { industryStockSymbol } = helpers;
const source = ts.transpileModule(
  fs.readFileSync('src/app/api/sw-industry/route.ts', 'utf8'),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

function harness(getQuotes = async () => []) {
  const exported = {};
  vm.runInNewContext(source, {
    exports: exported,
    require(name) {
      if (name === '@/lib/api')
        return {
          ok: (data) => ({ ok: true, data }),
          fail: (error, status) => ({ ok: false, error, status }),
          sp: (r) => new URL(r.url).searchParams,
        };
      if (name === '@/lib/sw2021') return classification;
      if (name === '@/lib/industryResearch') return helpers;
      if (name === '@/lib/datasource') return { getQuotes };
      throw Error(`Unexpected import ${name}`);
    },
  });
  return (query) =>
    exported.GET({ url: `http://localhost/api/sw-industry?${query}` });
}
const sample = classification.SW2021.industries.find(
  (node) => node.name === '农林牧渔',
);
const aCodes = [...new Set(sample.stocks)].filter((code) =>
  industryStockSymbol(code),
);
const quote = (symbol) => ({
  symbol,
  code: symbol.slice(2),
  kind: 'stock',
  name: `公司${symbol.slice(2)}`,
  price: 10,
  changePct: 0,
  pe: 20,
  pb: 2,
  totalMarketCap: 100,
  turnoverRate: 1,
  ts: '2026-10-16T16:00:00+08:00',
  stale: false,
});

test('tree counts cover the same A-share universe as members, preserve declared totals and never request quotes', async () => {
  let reads = 0;
  const get = harness(async () => {
    reads++;
    return [];
  });
  const tree = (await get('tree=1')).data;
  const all = [
    ...new Set(classification.SW2021.industries.flatMap((node) => node.stocks)),
  ];
  assert.equal(tree.stats.stocks, all.filter(industryStockSymbol).length);
  assert.equal(tree.stats.declaredStocks, all.length);
  assert.equal(
    tree.stats.excludedCount,
    all.filter((code) => !industryStockSymbol(code)).length,
  );
  assert.equal(
    tree.industries.find((node) => node.name === sample.name).count,
    aCodes.length,
  );
  assert.equal(
    tree.industries.find((node) => node.name === sample.name).declared,
    sample.count,
  );
  assert.equal(tree.provenance.membershipAsOf, null);
  assert.equal(reads, 0);
});

test('member quotes use bj920 symbols, exclude B shares and retain full l1/l2/l3 paths with actual source time', async () => {
  const requested = [];
  const get = harness(async (symbols) => {
    requested.push(...symbols);
    return symbols.map(quote);
  });
  const data = (await get(`node=${encodeURIComponent(sample.name)}&level=1`))
    .data;
  assert.equal(data.count, aCodes.length);
  assert.equal(data.rows.length, aCodes.length);
  assert.equal(data.quotedCount, aCodes.length);
  assert.equal(data.partial, false);
  assert.ok(requested.includes('bj920087'));
  assert.equal(
    requested.some((s) => /(?:sh900|sz200)/.test(s)),
    false,
  );
  assert.equal(new Set(requested).size, aCodes.length);
  const north = data.rows.find((row) => row.code === '920087');
  assert.equal(north.symbol, 'bj920087');
  assert.equal(north.l1, '农林牧渔');
  assert.equal(north.l2, '种植业');
  assert.equal(north.l3, '种子');
  assert.equal(north.roe, null);
  assert.equal(north.roeEstimate, 10);
  assert.equal(data.updatedAt, '2026-10-16T08:00:00.000Z');
  assert.equal(data.summary.totalCount, data.count);
});

test('failed batches and missing symbols remain placeholders while other batch quotes survive with bounded concurrency', async () => {
  let active = 0,
    maxActive = 0;
  const get = harness(async (symbols) => {
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (symbols.includes(industryStockSymbol(aCodes[40])))
        throw Error('one chunk unavailable');
      return symbols
        .filter((symbol) => symbol !== industryStockSymbol(aCodes[0]))
        .map(quote)
        .concat([{ ...quote('sh000001'), kind: 'index' }]);
    } finally {
      active--;
    }
  });
  const data = (await get(`node=${encodeURIComponent(sample.name)}&level=1`))
    .data;
  assert.equal(data.failedChunks, 1);
  assert.equal(data.count, aCodes.length);
  assert.equal(data.rows.length, aCodes.length);
  assert.equal(data.quotedCount, aCodes.length - 41);
  assert.equal(data.missingQuoteCount, 41);
  assert.equal(data.partial, true);
  assert.ok(maxActive <= 4);
  const missing = data.rows.find((row) => row.code === aCodes[0]);
  assert.equal(missing.quoteAvailable, false);
  assert.equal(missing.price, null);
  assert.equal(missing.pe, null);
  assert.equal(missing.totalMarketCap, null);
  assert.equal(
    data.rows.some((row) => row.symbol === 'sh000001'),
    false,
  );
});

test('strict deep links reject wrong levels or paths instead of loading a different default industry', async () => {
  const get = harness();
  assert.equal(
    (await get(`node=${encodeURIComponent(sample.name)}&level=4`)).status,
    400,
  );
  assert.equal(
    (await get(`node=${encodeURIComponent(sample.name)}&level=3`)).status,
    404,
  );
  assert.equal(
    (
      await get(
        `node=${encodeURIComponent('种子')}&level=3&l1=${encodeURIComponent('银行')}`,
      )
    ).status,
    404,
  );
  const valid = await get(
    `node=${encodeURIComponent('种子')}&level=3&l1=${encodeURIComponent('农林牧渔')}&l2=${encodeURIComponent('种植业')}`,
  );
  assert.equal(valid.ok, true);
  assert.equal(valid.data.node.l3, '种子');
  assert.equal(valid.data.updatedAt, null);
  assert.equal(valid.data.quotedCount, 0);
  assert.equal(valid.data.count, valid.data.rows.length);
});
