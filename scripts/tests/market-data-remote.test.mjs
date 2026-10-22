import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { load } from './load-modules.mjs';
const client = await load('marketDataClient');
const market = await load('marketStore');
const datasource = await load('datasource/index');
// The library-only loader does not package the research JSON registry. Stub that
// unrelated boundary; remote learning must return before accessing its providers.
const learning = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/datasource/companyLearning.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { exports: learning, require(name) {
  if (name === '../marketDataClient') return client;
  if (name === '../universe') return { STOCKS: [] };
  if (name === '../sw2021') return { SW2021: { industries: [] } };
  return new Proxy({}, { get() { throw Error('Remote learning must not read local research or providers'); } });
} });
const TOKEN = 'isolated-data-client-secret-over-32-characters';
const ENV_KEYS = ['MARKET_DATA_MODE', 'MARKET_DATA_API_URL', 'MARKET_DATA_API_ACCESS_TOKEN'];
async function fixture(run) {
  const previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])), original = globalThis.fetch;
  Object.assign(process.env, { MARKET_DATA_MODE: 'remote', MARKET_DATA_API_URL: 'https://source.test/api/market/data', MARKET_DATA_API_ACCESS_TOKEN: TOKEN });
  try { await run(); } finally {
    globalThis.fetch = original;
    for (const key of ENV_KEYS) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
}
const response = (value, status = 200, headers = {}) => Response.json(value, { status, headers: { 'X-Fin-Data-Version': '1', ...headers } });

test('consumer API forwards only explicit public queries and the server credential, preserving source metadata', () => fixture(async () => {
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++; assert.equal(url.origin, 'https://source.test'); assert.equal(url.pathname, '/api/market/data');
    assert.equal(url.searchParams.get('resource'), 'valuation'); assert.equal(url.searchParams.get('years'), '10');
    assert.equal(init.headers['x-fin-data-token'], TOKEN); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    for (const key of ['cookie', 'authorization', 'x-ai-key']) assert.equal(init.headers[key], undefined);
    return response({ ok: true, data: { currency: 'HKD', history: [{ date: '2026-10-20', pe: 9 }], source: 'isolated-source', stale: false } }, 200, { 'Set-Cookie': 'private=1' });
  };
  const result = await client.proxyRemoteMarketRequest(new Request('https://consumer.test/api/valuation?code=hk00700&years=10', { headers: { Cookie: 'private=1', Authorization: 'Bearer personal', 'x-ai-key': 'personal-ai' } }));
  assert.equal(result.status, 200); assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(result.headers.get('x-fin-market-source'), 'remote-api'); assert.match(result.headers.get('cache-control'), /private, no-store/);
  const json = await result.json(); assert.equal(json.data.history[0].date, '2026-10-20'); assert.equal(json.data.currency, 'HKD'); assert.equal(calls, 1);
}));

test('server-rendered quotes, history and valuations use the API before touching any local market store', () => fixture(async () => {
  const called = [];
  globalThis.fetch = async url => {
    assert.equal(url.origin, 'https://source.test'); const resource = url.searchParams.get('resource'); called.push(resource);
    const data = resource === 'quote' ? { symbol: 'hk00700', price: 380.6 } : resource === 'kline' ? { candles: [{ date: '2026-10-20', close: 393.8 }], adjust: 'none' } : resource === 'valuation' ? { history: [{ date: '2026-10-20', pe: 9.47 }] } : { source: 'remote' };
    return response({ ok: true, data });
  };
  assert.throws(() => market.getMarketStore(), /禁止使用本地/);
  assert.equal((await datasource.getQuote('hk00700')).price, 380.6);
  assert.equal((await datasource.getKLine('hk00700', 'day', 'none', 3000)).candles[0].close, 393.8);
  assert.equal((await datasource.getValuation('hk00700', 10)).history[0].pe, 9.47);
  assert.equal((await datasource.getFinancial('hk00700')).source, 'remote');
  assert.equal((await datasource.getCompanyProfile('hk00700')).source, 'remote');
  assert.equal((await learning.getLearningDigest('hk00700')).source, 'remote');
  assert.deepEqual(called, ['quote', 'kline', 'valuation', 'financial', 'company-profile', 'company-learning']);
}));

test('remote diagnostics use read-only API records and batch quotes obey the source batch cap', () => fixture(async () => {
  const batches = [];
  globalThis.fetch = async url => {
    const resource = url.searchParams.get('resource');
    if (resource === 'quote') { const codes = url.searchParams.get('codes').split(','); batches.push(codes.length); return response({ ok: true, data: codes.map(symbol => ({ symbol })) }); }
    assert.equal(resource, 'records');
    return response({ ok: true, data: { record: { key: url.searchParams.get('key'), payload: { source: 'remote' } } } });
  };
  const store = market.getMarketReadStore(); assert.equal('write' in store, false);
  assert.equal((await store.read('shares-v3:600415')).payload.source, 'remote');
  assert.equal((await datasource.getQuotes(Array(450).fill('600415'))).length, 450);
  assert.deepEqual(batches, [200, 200, 50]);
}));

test('remote failure never tries local snapshots or alternate providers and hides internal errors', () => fixture(async () => {
  let calls = 0;
  globalThis.fetch = async url => { calls++; assert.equal(url.origin, 'https://source.test'); throw Error('secret=' + TOKEN + ' postgres://sensitive'); };
  await assert.rejects(datasource.getQuote('600415'), /连接失败/);
  assert.equal(calls, 1);
  const result = await client.proxyRemoteMarketRequest(new Request('https://consumer.test/api/quote?code=600415'));
  assert.equal(result.status, 502); assert.doesNotMatch(await result.text(), /sensitive|secret=|postgres/);
  assert.equal(calls, 2);
}));

test('misconfiguration, source auth failure, version mismatch and redirects fail closed', () => fixture(async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response({ ok: false, error: 'private credentials' }, 401); };
  const auth = await client.proxyRemoteMarketRequest(new Request('https://consumer.test/api/quote?code=600415'));
  assert.equal(auth.status, 503); assert.doesNotMatch(await auth.text(), /private credentials/);
  delete process.env.MARKET_DATA_API_ACCESS_TOKEN;
  assert.equal((await client.proxyRemoteMarketRequest(new Request('https://consumer.test/api/quote?code=600415'))).status, 503); assert.equal(calls, 1);
  process.env.MARKET_DATA_API_ACCESS_TOKEN = TOKEN;
  process.env.MARKET_DATA_API_URL = 'https://consumer.test/api/market/data';
  assert.equal((await client.proxyRemoteMarketRequest(new Request('https://consumer.test/api/quote?code=600415'))).status, 503); assert.equal(calls, 1);
  process.env.MARKET_DATA_API_URL = 'http://insecure-source.test/api/market/data';
  await assert.rejects(client.readRemoteMarketData('quote', { code: '600415' }), /HTTPS/);
  process.env.MARKET_DATA_API_URL = 'https://source.test/api/market/data?token=bad';
  await assert.rejects(client.readRemoteMarketData('quote', { code: '600415' }), /凭证或查询参数/);
  process.env.MARKET_DATA_API_URL = 'https://source.test/api/market/data';
  globalThis.fetch = async () => Response.json({ error: 'not yet deployed' }, { status: 404 });
  await assert.rejects(client.readRemoteMarketData('quote', { code: '600415' }), /尚未部署或版本不兼容/);
  globalThis.fetch = async (_url, init) => { assert.equal(init.redirect, 'error'); throw Error('redirect blocked'); };
  await assert.rejects(client.readRemoteMarketData('quote', { code: '600415' }), /连接失败/);
}));

test('read POST bodies and rate limits pass safely while market mutations remain on the source', () => fixture(async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url.searchParams.get('resource'), 'finance-compare'); assert.equal(init.method, 'POST');
    const value = JSON.parse(new TextDecoder().decode(init.body)); assert.deepEqual(value.fields, ['bs_货币资金']);
    return response({ ok: false, error: 'rate limited' }, 429, { 'Retry-After': '15' });
  };
  const result = await client.proxyRemoteMarketRequest(new Request('https://consumer.test/api/finance-compare', { method: 'POST', body: JSON.stringify({ codes: ['600415'], fields: ['bs_货币资金'] }) }));
  assert.equal(result.status, 429); assert.equal(result.headers.get('retry-after'), '15');
  assert.equal((await client.proxyRemoteMarketRequest(new Request('https://consumer.test/api/market-updates', { method: 'POST', body: '{}' }))).status, 503);
  assert.equal((await client.proxyRemoteMarketRequest(new Request('https://consumer.test/api/market/import', { method: 'POST', body: '{}' }))).status, 503);
  assert.equal(await client.proxyRemoteMarketRequest(new Request('https://consumer.test/api/account/data')), null);
  delete process.env.MARKET_DATA_MODE;
  assert.equal(await client.proxyRemoteMarketRequest(new Request('https://consumer.test/api/quote?code=600415')), null);
}));

test('AI work stays on the consumer while public company-pool queries use the source', () => fixture(async () => {
  let calls=0;
  globalThis.fetch=async (_url,init)=>{calls++;assert.equal(init.headers['x-ai-key'],undefined);return response({ok:true,data:[]});};
  const request=new Request('https://consumer.test/api/company-learning',{method:'POST',headers:{'x-ai-key':'personal-ai'},body:JSON.stringify({action:'summarize',code:'hk00700'})});
  assert.equal(await client.proxyRemoteMarketRequest(request),null);
  assert.equal((await request.json()).action,'summarize');assert.equal(calls,0);
  assert.equal((await client.proxyRemoteMarketRequest(new Request('https://consumer.test/api/company-learning',{method:'POST',body:JSON.stringify({action:'pool',codes:['hk00700']})}))).status,200);
  assert.equal(calls,1);
}));
