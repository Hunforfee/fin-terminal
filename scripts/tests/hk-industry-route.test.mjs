import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { load } from './load-modules.mjs';
const classification = await load('hkIndustries');
const helpers = await load('industryResearch');
const source = ts.transpileModule(fs.readFileSync('src/app/api/hk-industry/route.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function harness(getIndustryQuotes = async () => []) {
  const exported = {};
  vm.runInNewContext(source, {
    exports: exported,
    require(name) {
      if (name === '@/lib/api') return {
        ok: (data) => ({ ok: true, data }),
        fail: (error, status) => ({ ok: false, error, status }),
        sp: (request) => new URL(request.url).searchParams,
      };
      if (name === '@/lib/hkIndustries') return classification;
      if (name === '@/lib/industryResearch') return helpers;
      if (name === '@/lib/datasource') return { getIndustryQuotes };
      throw Error(`Unexpected import ${name}`);
    },
  });
  return (query) => exported.GET({ url: `http://localhost/api/hk-industry?${query}` });
}
const quote = (symbol) => ({
  symbol, code: symbol.slice(2), market: 'HK', kind: 'stock', name: `报价${symbol.slice(2)}`,
  price: 100, changePct: -1, pe: 20, pb: 2, totalMarketCap: 123.45, turnoverRate: 0.5,
  ts: '2026-10-16T16:08:20+08:00', stale: false,
});
const params = (node) => new URLSearchParams({
  node: node.name, level: String(node.level), l1: node.l1,
  ...(node.l2 ? { l2: node.l2 } : {}),
}).toString();

test('HK industry tree uses the source taxonomy and records snapshot scope without requesting quotes', async () => {
  let calls = 0;
  const get = harness(async () => { calls++; return []; });
  const data = (await get('tree=1')).data;
  assert.equal(calls, 0);
  assert.equal(data.stats.stocks, classification.HK_INDUSTRY_MEMBERS.length);
  assert.equal(data.industries.reduce((sum, node) => sum + node.count, 0), data.stats.stocks);
  assert.equal(data.provenance.currency, 'HKD');
  assert.equal(data.provenance.marketCapUnit, 'HKD-100million');
  assert.equal(data.provenance.classification, 'EASTMONEY-HK');
  assert.equal(data.provenance.officialListingRegister, false);
  assert.equal(data.provenance.membershipAsOf, classification.HK_INDUSTRIES.asOf);
  assert.equal(data.stats.excludedCount, classification.HK_INDUSTRIES.exclusions.length);
});

test('HK members preserve five digits, HKD market-cap units and true taxonomy while requesting batch-only quotes', async () => {
  const requested = [];
  const get = harness(async (symbols) => { requested.push(...symbols); return symbols.map(quote); });
  const node = classification.findHkIndustryNode('互动媒体与服务', 3, '通讯服务', '媒体与娱乐');
  const data = (await get(params(node))).data;
  assert.ok(requested.includes('hk00700'));
  assert.ok(requested.every((symbol) => /^hk\d{5}$/.test(symbol)));
  assert.equal(new Set(requested).size, node.stocks.length);
  const row = data.rows.find((item) => item.symbol === 'hk00700');
  assert.equal(row.code, '00700');
  assert.equal(row.totalMarketCap, 123.45); // Already 100 million HKD in Quote contract.
  assert.equal(row.roeEstimate, 10);
  assert.equal(row.roe, null);
  assert.equal(row.l1, '通讯服务');
  assert.equal(row.l2, '媒体与娱乐');
  assert.equal(row.l3, '互动媒体与服务');
  assert.equal(data.updatedAt, '2026-10-16T08:08:20.000Z');
  assert.equal(data.partial, false);
});

test('failed chunks and absent quotes retain the directory name and membership with concurrency at most four', async () => {
  const node = classification.hkAllNodes().filter((node) => node.level === 1)
    .sort((a, b) => b.count - a.count)[0];
  const missingCode = node.stocks[0], failedCode = node.stocks[40];
  let active = 0, maxActive = 0;
  const get = harness(async (symbols) => {
    active++; maxActive = Math.max(active, maxActive);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (symbols.includes(`hk${failedCode}`)) throw Error('batch unavailable');
      return symbols.filter((symbol) => symbol !== `hk${missingCode}`).map(quote)
        .concat([{ ...quote('hk99999'), market: 'HK' }, quote('sh600519')]);
    } finally { active--; }
  });
  const data = (await get(params(node))).data;
  assert.equal(data.count, node.count);
  assert.equal(data.rows.length, node.count);
  assert.equal(data.failedChunks, 1);
  assert.ok(maxActive <= 4);
  assert.equal(data.missingQuoteCount, 41);
  const missing = data.rows.find((row) => row.code === missingCode);
  assert.equal(missing.name, classification.hkIndustryMember(missingCode).name);
  assert.equal(missing.quoteAvailable, false);
  assert.equal(missing.price, null);
  assert.equal(missing.pe, null);
  assert.equal(missing.pb, null);
  assert.equal(missing.totalMarketCap, null);
  assert.equal(data.rows.some((row) => row.symbol === 'hk99999'), false);
});

test('invalid deep links fail explicitly and ambiguous profile aliases do not invent a classification', async () => {
  const get = harness();
  assert.equal((await get('node=金融&level=4')).status, 400);
  assert.equal((await get('node=商业银行&level=3&l1=房地产')).status, 404);
  const data = (await get('node=商业银行&level=3&l1=金融&l2=银行')).data;
  assert.equal(data.count, data.rows.length);
  assert.equal(data.updatedAt, null);
  assert.equal(data.quotedCount, 0);
  assert.equal((await get('industry=不存在')).data.node, null);
});
