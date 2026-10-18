import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { load } from './load-modules.mjs';

const { computeDeductedPe, parseDeductedPeriods } = await load('datasource/deductedPe');
const compile = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const routeCode = compile('src/app/api/deducted-pe/route.ts');
const cacheCode = compile('src/lib/datasource/cache.ts');
const periods = parseDeductedPeriods([
  ['2026-06-30', 100e6], ['2026-03-31', 40e6], ['2025-12-31', 200e6],
  ['2025-09-30', 140e6], ['2025-06-30', 90e6],
].map(([REPORT_DATE, KCFJCXSYJLR]) => ({ REPORT_DATE, KCFJCXSYJLR })));

function harness() {
  let now = 1_800_000_000_000, cap = 21, quoteFails = false;
  let financialReads = 0, quoteReads = 0;
  const cacheExports = {};
  vm.runInNewContext(cacheCode, {
    exports: cacheExports, Date: { now: () => now },
    require: () => ({ isShanghaiTradingTime: () => true }),
  });
  const routeExports = {};
  vm.runInNewContext(routeCode, {
    exports: routeExports,
    require(name) {
      if (name === '@/lib/api') return {
        ok: data => ({ ok: true, data }), fail: error => ({ ok: false, error }),
        sp: request => new URL(request.url).searchParams,
      };
      if (name === '@/lib/datasource/codes') return { normalizeStockCode: () => ({ symbol: 'sh600519' }) };
      if (name === '@/lib/datasource/deductedPe') return {
        computeDeductedPe,
        fetchDeductedPeriods: async () => { financialReads++; return periods; },
      };
      if (name === '@/lib/datasource') return {
        getQuote: async () => { quoteReads++; if (quoteFails) throw Error('quote unavailable'); return { totalMarketCap: cap }; },
      };
      if (name === '@/lib/datasource/cache') return cacheExports;
      throw Error(`Unexpected import: ${name}`);
    },
  });
  return {
    get: () => routeExports.GET({ url: 'http://localhost/api/deducted-pe?codes=600519' }),
    advance: milliseconds => { now += milliseconds; },
    setCap: value => { cap = value; },
    failQuote: value => { quoteFails = value; },
    reads: () => ({ financial: financialReads, quote: quoteReads }),
  };
}

test('route caches only financial periods and recalculates PE when current market cap changes', async () => {
  const h = harness();
  const first = await h.get();
  assert.equal(first.data[0].pe, 10);
  assert.deepEqual(Array.from(first.data[0].quarters), ['2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30']);
  h.advance(16_000);
  h.setCap(42);
  const next = await h.get();
  assert.equal(next.data[0].pe, 20, 'the final PE must not retain the previous market cap for an hour');
  assert.deepEqual(h.reads(), { financial: 1, quote: 2 });
  h.advance(3_600_000);
  await h.get();
  assert.deepEqual(h.reads(), { financial: 2, quote: 3 }, 'slow financial data refreshes when its own cache expires');
});

test('missing current market cap stays unavailable without reusing a previously calculated PE', async () => {
  const h = harness();
  assert.equal((await h.get()).data[0].pe, 10);
  h.setCap(null);
  assert.equal((await h.get()).data[0].pe, null);
  h.failQuote(true);
  assert.equal((await h.get()).data[0].pe, null);
  h.failQuote(false);
  h.setCap(42);
  assert.equal((await h.get()).data[0].pe, 20);
  assert.deepEqual(h.reads(), { financial: 1, quote: 4 });
});
