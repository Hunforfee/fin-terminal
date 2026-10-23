import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';
import { load } from './load-modules.mjs';

const resources = await load('marketDataResources');
const client = await load('marketDataClient');
const records = await load('marketDataRecords');
const market = await load('marketStore');
const TOKEN = 'isolated-market-data-token-over-32-characters';
class FakeRequest extends Request { get nextUrl() { return new URL(this.url); } }
class FakeResponse extends Response { static json(body, init) { return Response.json(body, init); } }
function endpoint({ store = {}, handlers, mode = false, fallback = false } = {}) {
  const exports = {}, calls = []; let rate = 0, storeReads = 0;
  const table = handlers ?? {
    quote: async () => ({ GET: async req => { calls.push(req); return Response.json({ ok: true, data: { symbol: 'hk00700', price: 380.6, currency: 'HKD' } }, { headers: { 'Cache-Control': 'public, max-age=300', 'Set-Cookie': 'never-forward-this=1' } }); } }),
    'finance-compare': async () => ({ POST: async req => { calls.push(req); return Response.json({ ok: true, data: await req.json() }); } }),
    'company-learning': async () => ({ POST: async req => Response.json({ ok: true, data: await req.json() }) }),
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/api/market/data/route.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, {
    exports, Date, Buffer, Uint8Array, URL, TextDecoder,
    process: { env: { [fallback ? 'MARKET_READONLY_TOKEN' : 'MARKET_DATA_API_TOKEN']: TOKEN } },
    require(name) {
      if (name === 'node:crypto') return crypto;
      if (name === 'next/server') return { NextRequest: FakeRequest, NextResponse: FakeResponse };
      if (name === '@/lib/auth/limits') return { allowAttempt: (_key, max) => ++rate <= max };
      if (name === '@/lib/marketStore') return { getMarketReadStore: () => { storeReads++; return store; } };
      if (name === '@/lib/marketDataResources') return resources;
      if (name === '@/lib/marketDataClient') return { MarketDataApiError: client.MarketDataApiError, readMarketBody: client.readMarketBody, remoteMarketDataEnabled: () => mode };
      if (name === '@/lib/marketDataRecords') return records;
      if (name === '@/lib/marketDataHandlers') return { marketDataHandlers: table };
      throw Error(name);
    },
  });
  return { ...exports, calls, get storeReads() { return storeReads; } };
}
const request = (query = '', { method = 'GET', body, token = TOKEN, headers = {} } = {}) => new FakeRequest('https://source.test/api/market/data?' + query, {
  method, headers: { ...(token ? { 'x-fin-data-token': token } : {}), ...headers },
  ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
});

test('gateway requires header authentication before accessing data and supports the existing server secret', async () => {
  const api = endpoint();
  for (const token of [null, 'wrong', 'x'.repeat(513)]) assert.equal((await api.GET(request('resource=records&key=shares-v3:600415', { token }))).status, 401);
  assert.equal(api.storeReads, 0);
  assert.equal((await api.GET(request('resource=catalog', { token: null, headers: { authorization: 'Bearer ' + TOKEN } }))).status, 200);
  assert.equal((await endpoint({ fallback: true }).GET(request())).status, 200);
  for (const query of ['token=bad', 'sql=SELECT+1', 'api_key=bad']) assert.equal((await api.GET(request(query))).status, 400);
});

test('catalog exposes all public route families while account/admin/AI/mutation paths remain inaccessible', async () => {
  const api = endpoint(), response = await api.GET(request()), json = await response.json();
  assert.equal(json.data.version, 1);
  assert.ok(json.data.resources.valuation);
  assert.ok(json.data.recordFamilies.includes('source-sina-page:v1:'));
  assert.ok(json.data.recordFamilies.includes('hk-dividend-events-v4:'));
  assert.match(response.headers.get('cache-control'), /private, no-store/);
  for (const resource of ['account/data', 'auth/session', 'market/import', 'market-updates', 'market-update-run-log', 'ai-analyze', '__proto__', 'constructor'])
    assert.equal((await api.GET(request('resource=' + encodeURIComponent(resource)))).status, 404);
  assert.equal((await api.POST(request('resource=quote', { method: 'POST', body: {} }))).status, 405);
  assert.equal((await endpoint({ mode: true }).GET(request())).status, 503);
});

test('data handlers receive only sanitized input and authenticated responses never become publicly cacheable', async () => {
  const api = endpoint();
  const response = await api.GET(request('resource=quote&code=hk00700', { headers: { cookie: 'fin_session=private', authorization: 'Bearer private-user-token', 'x-ai-key': 'private-ai' } }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.currency, 'HKD');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match(response.headers.get('cache-control'), /private, no-store/);
  const forwarded = api.calls[0];
  for (const name of ['cookie', 'authorization', 'x-ai-key', 'x-fin-data-token']) assert.equal(forwarded.headers.get(name), null);
  assert.equal(forwarded.nextUrl.pathname, '/api/quote');
  assert.equal(forwarded.nextUrl.search, '?code=hk00700');
});

test('read-only POST supports full custom finance fields but rejects shared AI execution and oversized bodies', async () => {
  const api = endpoint(), data = { codes: ['600415'], fields: ['bs_货币资金', 'roe'], years: 10, granularity: 'quarter' };
  const result = await api.POST(request('resource=finance-compare', { method: 'POST', body: data }));
  assert.deepEqual((await result.json()).data, data);
  assert.equal((await api.POST(request('resource=company-learning', { method: 'POST', body: { action: 'summarize', code: '600415' } }))).status, 403);
  assert.equal((await api.POST(request('resource=company-learning', { method: 'POST', body: { action: 'pool', codes: ['600415'] } }))).status, 200);
  assert.equal((await api.POST(request('resource=finance-compare', { method: 'POST', body: 'x'.repeat(65537) }))).status, 413);
  assert.equal((await api.POST(request('resource=finance-compare', { method: 'POST', body: '{' }))).status, 400);
});

test('raw records page through complete original data with stable cursors and preserve dates/units/digests', async () => {
  const values = ['000001', '000002', '000003'].map(code => market.marketRecord('shares-v3:' + code, 'share-events', 'isolated-test', [{ date: '2026-10-20', sharesWan: 123 }], 60000));
  const store = { read: async key => values.find(v => v.key === key) ?? null,
    scanPrefix: async (prefix, limit, after) => values.filter(v => v.key.startsWith(prefix) && v.key > after).slice(0, limit).map(({ payload, ...meta }) => meta) };
  const api = endpoint({ store });
  const page = await (await api.GET(request('resource=records&prefix=shares-v3:&limit=2'))).json();
  assert.equal(page.data.records.length, 2);
  assert.equal(page.data.nextCursor, 'shares-v3:000002');
  assert.deepEqual(page.data.records[0].payload, values[0].payload);
  assert.equal(page.data.records[0].digest, values[0].digest);
  const next = await (await api.GET(request('resource=records&prefix=shares-v3:&limit=2&after=shares-v3:000002'))).json();
  assert.equal(next.data.records.length, 1); assert.equal(next.data.nextCursor, null);
  const meta = await (await api.GET(request('resource=records&prefix=shares-v3:&payload=0&limit=200'))).json();
  assert.equal('payload' in meta.data.records[0], false);
});

test('raw record queries block private keys, invalid cursors and unbounded payloads before reads', async () => {
  let reads = 0;
  const api = endpoint({ store: { read: async () => { reads++; return null; }, scanPrefix: async () => { reads++; return []; } } });
  for (const key of ['market-update-run-log:v1', 'market-collection-registry:v1', 'market-update-queue:v1', 'import-log:v1', 'account:someone', 'fetch-lease:v1:token', '../.env'])
    assert.equal((await api.GET(request('resource=records&key=' + encodeURIComponent(key)))).status, 403);
  for (const query of ['prefix=shares-v3:&after=implemented-dividends-v4:000001', 'prefix=shares-v3:&limit=21', 'prefix=shares-v3:&limit=NaN', 'key=shares-v3:000001&prefix=shares-v3:', 'keys=' + Array(21).fill('shares-v3:000001').join(',')])
    assert.equal((await api.GET(request('resource=records&' + query))).status, 400);
  assert.equal(reads, 0);
  assert.equal((await api.GET(request('resource=records&key=shares-v3:000001'))).status, 404);
});

test('storage errors are distinct from missing records and never expose connection credentials', async () => {
  const api = endpoint({ store: { read: async () => { throw Error('postgres://secret:password@host'); } } });
  const response = await api.GET(request('resource=records&key=shares-v3:000001'));
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /password|postgres/);
});

test('gateway bounds per-instance rate and concurrent requests', async () => {
  const api = endpoint();
  for (let at = 0; at < 240; at++) assert.equal((await api.GET(request())).status, 200);
  const limited = await api.GET(request()); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const busy = endpoint({ handlers: { quote: async () => ({ GET: async () => { await gate; return Response.json({ ok: true, data: {} }); } }) } });
  const pending = Array.from({ length: 8 }, () => busy.GET(request('resource=quote&code=600415')));
  const full = await busy.GET(request('resource=quote&code=600415'));
  assert.equal(full.status, 429); assert.equal(full.headers.get('retry-after'), '5');
  release(); assert.ok((await Promise.all(pending)).every(value => value.status === 200));
});

test('oversized response headers and chunked bodies are bounded', async () => {
  const api = endpoint({ handlers: { quote: async () => ({ GET: async () => Response.json({ ok: true }, { headers: { 'Content-Length': String(33554433) } }) }) } });
  assert.equal((await api.GET(request('resource=quote&code=600415'))).status, 413);
  await assert.rejects(client.readMarketBody(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(9)); controller.close(); } })), 8), /体积/);
});

test('public resource registry exactly covers the static dispatchers and special read-only handlers', () => {
  const source = fs.readFileSync('src/lib/marketDataHandlers.ts', 'utf8');
  const paths = [...source.matchAll(/import\('\.\.\/app\/api\/([^']+)\/route'\)/g)].map(m => m[1]);
  assert.deepEqual([...paths, 'records', 'hk-valuation', 'catalog', 'diagnostics'].sort(), Object.keys(resources.MARKET_DATA_RESOURCES).sort());
  for (const route of paths) assert.ok(fs.existsSync('src/app/api/' + route + '/route.ts'));
  assert.match(fs.readFileSync('next.config.mjs', 'utf8'), /'\/api\/market\/data':\s*\['\.\/src\/data\/analyses/);
});
