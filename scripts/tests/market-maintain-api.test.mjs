import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { load } from './load-modules.mjs';

const TOKEN = 'maintain-api-test-token-over-32-characters-long';
process.env.MARKET_MAINTENANCE_TOKEN = TOKEN;
test.after(() => { delete process.env.MARKET_MAINTENANCE_TOKEN; });

const market = await load('marketStore');
const codes = await load('datasource/codes');
const resources = await load('marketDataResources');
const gaps = await load('marketFillGaps');
const plan = await load('marketHistoryPlan');
const corrections = await load('marketCorrections');
const auth = await load('marketMaintainAuth');
const { MarketUpdateQueue, UpdateQueueError } = await load('marketUpdateQueue');
const now = Date.parse('2026-10-23T02:00:00Z');

/** 内存存储：带 scanPrefix / readVersions，覆盖修正存档与版本查询路径。 */
function memory() {
  const data = new Map();
  return {
    data,
    read: async key => structuredClone(data.get(key) ?? null),
    async write(row, expected) { if ((data.get(row.key)?.digest ?? null) !== expected) return false; data.set(row.key, structuredClone(row)); return true; },
    remove: async key => data.delete(key), incident: async () => {},
    readVersions: async () => [],
    async scanPrefix(prefix, limit) {
      return [...data.values()].filter(r => r.key.startsWith(prefix)).slice(0, limit)
        .map(({ key, kind, source, digest, acquiredAt, refreshAfter }) => ({ key, kind, source, digest, acquiredAt, refreshAfter }));
    },
    seed(key, kind, payload) { data.set(key, market.marketRecord(key, kind, 'test', payload, 1e8, now)); },
  };
}

function compileRoute(store, overrides = {}) {
  const exported = {};
  const resolveCalls = [];
  let rateCalls = 0;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/api/market/maintain/route.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: 'route.ts',
  }).outputText, {
    exports: exported, console, Date, Error, Buffer, Headers, TextDecoder, URL, Uint8Array,
    AbortController, setTimeout, clearTimeout,
    require(name) {
      if (name === 'node:crypto') return crypto;
      if (name === 'next/server') return { NextRequest: class {}, NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200, headers: init?.headers ?? {} }) } };
      if (name === '@/lib/auth/limits') return { allowAttempt: (_k, max) => ++rateCalls <= max };
      if (name === '@/lib/marketStore') return { getMarketStore: () => store, marketRecord: market.marketRecord, valuationRevisionKey: s => `valuation-input-version:v1:${s}` };
      if (name === '@/lib/marketMaintainAuth') return auth;
      if (name === '@/lib/marketCorrections') return corrections;
      if (name === '@/lib/marketDataResources') return resources;
      if (name === '@/lib/marketFillGaps') return gaps;
      if (name === '@/lib/marketGapResolve') return { resolveMarketGaps: async (_s, symbols) => { resolveCalls.push(symbols); return symbols.map(s => ({ symbol: s, status: 'cleared', cleared: true })); } };
      if (name === '@/lib/marketUpdateQueue') return { MarketUpdateQueue, UpdateQueueError };
      if (name === '@/lib/marketHistoryPlan') return plan;
      if (name === '@/lib/datasource/codes') return codes;
      if (name === '@/lib/marketDiagnostics') return { diagnoseMarketData: async (_s, symbol) => ({ symbol, pages: [], valuation: null }) };
      return overrides[name] ?? (() => { throw Error(name); })();
    },
  });
  return { ...exported, get resolveCalls() { return resolveCalls; } };
}

const get = (query = '', token = TOKEN, headers = {}) => ({
  method: 'GET', headers: new Headers({ ...(token ? { 'x-fin-maintain-token': token } : {}), ...headers }),
  nextUrl: new URL('https://source.test/api/market/maintain?' + query), text: async () => '',
});
const post = (body, token = TOKEN, headers = {}) => ({
  method: 'POST', headers: new Headers({ ...(token ? { 'x-fin-maintain-token': token } : {}), ...headers }),
  nextUrl: new URL('https://source.test/api/market/maintain'), text: async () => JSON.stringify(body),
});

test('maintain API gate: unconfigured token is a closed 404, wrong tokens are 401, URL tokens are rejected', async () => {
  const saved = process.env.MARKET_MAINTENANCE_TOKEN;
  delete process.env.MARKET_MAINTENANCE_TOKEN;
  try {
    const route = compileRoute(memory());
    assert.equal((await route.GET(get())).status, 404);
    assert.equal((await route.POST(post({ action: 'updates', codes: ['600415'] }))).status, 404);
  } finally { process.env.MARKET_MAINTENANCE_TOKEN = saved; }
  const route = compileRoute(memory());
  assert.equal((await route.GET(get('', 'wrong-token'))).status, 401);
  assert.equal((await route.GET(get('', TOKEN.slice(0, -1)))).status, 401);
  assert.equal((await route.GET(get('action=catalog&token=' + TOKEN))).status, 400);
  assert.equal((await route.GET(get('action=catalog', TOKEN, { authorization: 'Bearer ' + TOKEN }))).status, 200);
});

test('catalog documents the small-batch, no-all-market-resubmit contract', async () => {
  const route = compileRoute(memory());
  const response = await route.GET(get('action=catalog'));
  assert.equal(response.status, 200);
  assert.equal(response.body.data.limits.maxCodesPerJob, 20);
  assert.match(response.body.data.limits.allMarketResubmit, /禁止/);
  assert.match(response.body.data.limits.note, /全量历史采集/);
  assert.ok(response.body.data.actions['POST correct']);
});

test('update jobs require explicit small code lists; daily requires a target date; uninitialized stocks warn about full collection', async () => {
  const store = memory();
  const route = compileRoute(store);
  assert.equal((await route.POST(post({ action: 'updates' }))).status, 400);
  assert.equal((await route.POST(post({ action: 'updates', codes: [] }))).status, 400);
  assert.equal((await route.POST(post({ action: 'updates', codes: Array.from({ length: 21 }, (_, i) => `6000${String(i).padStart(2, '0')}`) }))).status, 400);
  assert.equal((await route.POST(post({ action: 'updates', codes: ['600415'], mode: 'five-year' }))).status, 400);
  assert.equal((await route.POST(post({ action: 'updates', codes: ['600415'], mode: 'daily' }))).status, 400);
  assert.equal((await route.POST(post({ action: 'updates', codes: ['000001'], mode: 'daily', targetDate: '2026-13-99' }))).status, 400);

  // 未初始化股票的 recent 任务必须带全量采集警告，而不是按模式名显示为轻量。
  store.seed(plan.coverageKey('sh600415'), 'market-coverage', { status: 'partial' });
  const warned = await route.POST(post({ action: 'updates', codes: ['600415'], mode: 'recent' }));
  assert.equal(warned.status, 200);
  assert.equal(warned.body.data.total, 1);
  assert.match(warned.body.data.warnings.join('；'), /尚未完成初始化.*全量历史采集/);
  const progress = await route.GET(get('action=updates'));
  assert.equal(progress.body.data.id, warned.body.data.id);
  assert.equal(progress.body.data.total, 1);
});

test('queue conflicts surface as their own status codes instead of a generic 500', async () => {
  const store = memory();
  store.seed(plan.coverageKey('sh600415'), 'market-coverage', { status: 'ready' });
  const route = compileRoute(store);
  const first = await route.POST(post({ action: 'updates', codes: ['600415'], mode: 'ten-year' }));
  assert.equal(first.status, 200);
  // 同令牌再次提交 ten-year 到不同范围 → 队列 409。
  const second = await route.POST(post({ action: 'updates', codes: ['000001', '600415'], mode: 'ten-year' }));
  assert.equal(second.status, 409);
  assert.match(second.body.error, /补齐任务/);
});

test('corrections archive old and new values with basis, operator and request id, and only touch public keys of that stock', async () => {
  const store = memory();
  const seeded = { reports: [{ date: '2016-03-31', npParent: 999 }] };
  store.seed('statements-v3:sh600415:11', 'statements-v3', seeded);
  const route = compileRoute(store);
  const operator = { 'x-fin-maintain-operator': 'codex-review' };

  // 非公开键 / 非本股票键 / 依据过短 / 记录不存在，一律拒绝。
  assert.equal((await route.POST(post({ action: 'correct', code: '600415', key: 'market-update-queue:v1', value: {}, basis: '任意修改内部队列' }, TOKEN, operator))).status, 400);
  assert.equal((await route.POST(post({ action: 'correct', code: '600415', key: 'kline:v2:sz000001:day', value: {}, basis: '改错了目标股票' }, TOKEN, operator))).status, 400);
  assert.equal((await route.POST(post({ action: 'correct', code: '600415', key: 'statements-v3:sh600415:11', value: {}, basis: '短' }, TOKEN, operator))).status, 400);
  assert.equal((await route.POST(post({ action: 'correct', code: '000001', key: 'statements-v3:sz000001:11', value: {}, basis: '该股票尚未入库任何三表' }, TOKEN, operator))).status, 404);

  const response = await route.POST(post({
    action: 'correct', code: '600415', key: 'statements-v3:sh600415:11',
    value: { reports: [{ date: '2016-03-31', npParent: 21091.67 }] },
    basis: '依据公司 2016 年一季报原文修正归母净利润', note: '复核请求',
  }, TOKEN, operator));
  assert.equal(response.status, 200);
  assert.equal(response.body.data.archived, true);
  const requestId = response.body.data.correctionKey.split(':').at(-1);
  assert.ok(requestId.length >= 32);

  // 长效存档：旧值、新值、来源依据、操作身份、请求编号齐全，且不在公开 revisions 清理范围。
  const archived = await corrections.readCorrections(store, 'sh600415');
  assert.equal(archived.length, 1);
  assert.deepEqual(archived[0].oldValue.payload, seeded);
  assert.deepEqual(archived[0].newValue.payload.reports[0].npParent, 21091.67);
  assert.equal(archived[0].basis, '依据公司 2016 年一季报原文修正归母净利润');
  assert.equal(archived[0].operator, 'codex-review');
  assert.equal(archived[0].requestId, requestId);
  assert.equal(store.data.get('statements-v3:sh600415:11').payload.reports[0].npParent, 21091.67);

  // 内容相同的重复修正被拒绝，不产生空存档。
  assert.equal((await route.POST(post({ action: 'correct', code: '600415', key: 'statements-v3:sh600415:11', value: { reports: [{ date: '2016-03-31', npParent: 21091.67 }] }, basis: '重复提交同样内容' }, TOKEN, operator))).status, 409);
  assert.equal((await corrections.readCorrections(store, 'sh600415')).length, 1);

  // 审计日志记录请求编号与操作身份。
  const log = await route.GET(get('action=log&limit=5'));
  assert.ok(log.body.data.entries.some(e => e.action === 'correct' && e.requestId === requestId && e.operator === 'codex-review' && e.ok));
});

test('rebuild bumps the valuation input version and diagnostics/gaps/corrections stay read-only', async () => {
  const store = memory();
  const route = compileRoute(store);
  const before = await route.POST(post({ action: 'rebuild', code: '600415' }));
  assert.equal(before.status, 200);
  const version = store.data.get('valuation-input-version:v1:sh600415').payload.version;
  assert.ok(version.length >= 32);
  const after = await route.POST(post({ action: 'rebuild', code: '600415' }));
  assert.equal(after.status, 200);
  assert.notEqual(store.data.get('valuation-input-version:v1:sh600415').payload.version, version);
  assert.equal((await route.POST(post({ action: 'rebuild', code: 'sh000001' }))).status, 400); // 指数不是个股

  assert.equal((await route.GET(get('action=diagnostics&code=600415'))).status, 200);
  assert.equal((await route.GET(get('action=diagnostics&code=sh000001'))).status, 400);
  assert.equal((await route.GET(get('action=gaps&code=600415'))).status, 200);
  assert.equal((await route.GET(get('action=corrections&code=600415'))).status, 200);
  assert.equal((await route.GET(get('action=history&key=market-update-queue:v1'))).status, 400);
  assert.equal((await route.GET(get('action=history&key=statements-v3:sh600415:11'))).status, 200);
  assert.equal((await route.GET(get('action=unknown'))).status, 404);
});

test('resolve delegates to the shared gap resolver with a bounded code list', async () => {
  const store = memory();
  const route = compileRoute(store);
  assert.equal((await route.POST(post({ action: 'resolve', codes: [] }))).status, 400);
  assert.equal((await route.POST(post({ action: 'resolve', codes: ['not-a-code'] }))).status, 400);
  const response = await route.POST(post({ action: 'resolve', codes: ['600415'] }));
  assert.equal(response.status, 200);
  assert.equal(response.body.data.total, 1);
  assert.deepEqual([...route.resolveCalls.at(-1)], ['sh600415']);
  assert.equal((await route.POST(post({ action: 'resolve', codes: Array.from({ length: 51 }, () => '600415') }))).status, 400);
});

// ---------- 共享复核逻辑（真实模块，独立编译） ----------

function compileResolver(history, fill) {
  const exported = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/marketGapResolve.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: 'marketGapResolve.ts',
  }).outputText, {
    exports: exported, console, Date, Error, AbortController, setTimeout, clearTimeout,
    require(name) {
      if (name === './marketHistoryCollection') return history;
      if (name === './marketFillGaps') return fill;
      if (name === './datasource/codes') return codes;
      throw Error(name);
    },
  });
  return exported;
}

test('shared resolver clears ready gaps, keeps partial ones and reports unexpected failures', async () => {
  const store = memory();
  store.seed('market-coverage:v1:hk00016', 'market-coverage', { status: 'partial', missingInputs: ['hk-dividend-events-v4:hk00016'] });
  const base = {
    coverageKey: s => `market-coverage:v1:${s}`,
    collectHistoryPhase: async () => { throw Error('已保存可用数据；缺 hk-dividend-events-v4:hk00016'); },
  };
  // 覆盖不足但记录已落库 → remaining，并更新台账内容。
  const partial = compileResolver(base, {
    classifyCoverage: () => ({ mcp: ['kline'], manual: [], notes: [] }),
    applyGapClassification: async (_s, _symbol, classified) => (classified ? { symbol: 'hk00016', ...classified } : null),
    readFillGap: async () => null,
  });
  let result = await partial.resolveMarketGaps(store, ['hk00016']);
  assert.equal(result[0].status, 'remaining');
  assert.equal(result[0].cleared, false);
  assert.deepEqual(result[0].remaining.mcp, ['kline']);

  // 覆盖 ready → cleared。
  const ready = compileResolver(base, { classifyCoverage: () => null, applyGapClassification: async () => null, readFillGap: async () => null });
  result = await ready.resolveMarketGaps(store, ['hk00016']);
  assert.equal(result[0].status, 'cleared');

  // phase 12 抛未知错误 → error，不回填台账。
  const failing = compileResolver({ ...base, collectHistoryPhase: async () => { throw Error('复核超时'); } },
    { classifyCoverage: () => null, applyGapClassification: async () => null, readFillGap: async () => ({ mcp: ['kline'], manual: ['x'] }) });
  result = await failing.resolveMarketGaps(store, ['hk00016']);
  assert.equal(result[0].status, 'error');
  assert.match(result[0].error, /复核超时/);

  // 无效代码不进入复核。
  result = await ready.resolveMarketGaps(store, ['sh000001', 'AAPL']);
  assert.deepEqual([...result].map(r => r.status), ['error', 'error']);
  assert.match(result[0].error, /证券代码无效/);
});

test('the existing import route accepts the maintain token as a machine admin and logs the token fingerprint', async () => {
  const store = memory();
  const exported = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/api/market/import/route.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: 'import-route.ts',
  }).outputText, {
    exports: exported, console, Date, Error, Buffer, Headers, TextDecoder, URL,
    require(name) {
      if (name === 'next/server') return { NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200, headers: init?.headers ?? {} }) } };
      if (name === '@/lib/marketStore') return { getMarketStore: () => store, marketRecord: market.marketRecord };
      if (name === '@/lib/marketImportedBars') return { importDailyPrices: async (_s, input) => ({ symbol: input.symbol, from: input.candles[0]?.date, to: input.candles.at(-1)?.date, count: input.candles.length, skipped: false }) };
      if (name === '@/lib/marketImportAuth') return { denyReason: () => '请先登录', importAdminIds: () => [], readImportIdentity: () => null };
      if (name === '@/lib/marketMaintainAuth') return auth;
      if (name === '@/lib/marketHkImportRecords') return { writeHkStatements: async () => ({ status: 'inserted' }), writeHkIndicators: async () => ({ saved: 1 }), writeHkDividendEvents: async () => ({ saved: 1 }) };
      if (name === '@/lib/marketImportRecords') return { klineCrossConflicts: async () => [], writeFinanceStatements: async () => ({ status: 'inserted' }), writeFinancialHistory: async () => ({ status: 'inserted' }), writeShareHistory: async () => ({ status: 'inserted' }), writeDividendPlans: async () => ({ saved: 1 }), writeDividendImplemented: async () => ({ saved: 1 }) };
      throw Error(name);
    },
  });
  const postImport = (body, token) => ({ headers: new Headers(token ? { 'x-fin-maintain-token': token } : {}), text: async () => JSON.stringify(body) });
  const getImport = (token) => ({ headers: new Headers(token ? { 'x-fin-maintain-token': token } : {}) });

  // 无会话、无令牌 → 401（原管理员路径不变）。
  assert.equal((await exported.POST(postImport({ type: 'kline', record: { symbol: 'sh600415', candles: [{ date: '2026-10-22', open: 11, high: 12, low: 10, close: 11 }] } }))).status, 401);
  assert.equal((await exported.GET(getImport())).body.authorized, false);

  // 维护令牌 → 写入放行，日志记录令牌指纹而非令牌本身。
  const response = await exported.POST(postImport({ type: 'kline', record: { symbol: 'sh600415', source: 'tdx', candles: [{ date: '2026-10-22', open: 11, high: 12, low: 10, close: 11 }] } }, TOKEN));
  assert.equal(response.status, 200);
  assert.equal(response.body.result.imported, 1);
  const self = await exported.GET(getImport(TOKEN));
  assert.equal(self.body.authorized, true);
  assert.equal(self.body.via, 'maintain-token');
  assert.match(self.body.userId, /^maintain:[a-f0-9]{12}$/);
  const entries = store.data.get('import-log:v1').payload.entries;
  assert.equal(entries.at(-1).userId, self.body.userId);
  assert.ok(!JSON.stringify(entries).includes(TOKEN));

  // 错误令牌仍然拒绝。
  assert.equal((await exported.POST(postImport({ type: 'kline', record: { symbol: 'sh600415', candles: [] } }, 'wrong'))).status, 401);
});

// ---------- 凭证中间件与修正存档单元测试（真实模块） ----------

test('maintain token is independent and fail-closed; identity carries request id and operator', async () => {
  const request = (headers = {}) => ({ headers: new Headers(headers) });
  assert.equal(auth.maintainToken(), TOKEN);
  assert.equal(auth.readMaintainIdentity(request()), null);
  assert.equal(auth.readMaintainIdentity(request({ 'x-fin-maintain-token': 'wrong' })), null);
  assert.equal(auth.readMaintainIdentity(request({ authorization: 'Bearer wrong' })), null);
  const identity = auth.readMaintainIdentity(request({ 'x-fin-maintain-token': TOKEN }));
  assert.ok(identity.tokenId.startsWith('maintain:'));
  assert.equal(identity.tokenId.length, 'maintain:'.length + 12);
  assert.match(identity.operator, /^maintain-token:/);
  assert.ok(identity.requestId.length >= 32);
  assert.equal(auth.readMaintainIdentity(request({ authorization: 'Bearer ' + TOKEN })).requestId !== identity.requestId, true);
  const named = auth.readMaintainIdentity(request({ 'x-fin-maintain-token': TOKEN, 'x-fin-maintain-operator': 'codex-review' }));
  assert.equal(named.operator, 'codex-review');
  assert.match(auth.denyMaintainReason(request()), /凭证无效/);

  const saved = process.env.MARKET_MAINTENANCE_TOKEN;
  delete process.env.MARKET_MAINTENANCE_TOKEN;
  try {
    assert.equal(auth.maintainToken(), null);
    assert.equal(auth.readMaintainIdentity(request({ 'x-fin-maintain-token': TOKEN })), null);
    assert.match(auth.denyMaintainReason(request()), /未配置/);
  } finally { process.env.MARKET_MAINTENANCE_TOKEN = saved; }
});

test('maintain log is rolling and never contains the token itself', async () => {
  const store = memory();
  for (let i = 0; i < 3; i++)
    await auth.appendMaintainLog(store, { requestId: `r${i}`, tokenId: 'maintain:abc', operator: 'codex', action: 'rebuild', ok: true, detail: { symbol: 'sh600415' } });
  const entries = await auth.readMaintainLog(store, 10);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].requestId, 'r2'); // 最新在前
  assert.ok(!JSON.stringify(entries).includes(TOKEN));
});

test('correction archive survives as independent records and never leaks into public families', async () => {
  const store = memory();
  const ok = await corrections.archiveCorrection(store, {
    symbol: 'sh600415', key: 'statements-v3:sh600415:11', oldValue: { a: 1 }, newValue: { a: 2 },
    basis: '公告原文', operator: 'codex', requestId: '11111111-2222-3333-4444-555555555555',
  });
  assert.equal(ok, true);
  assert.equal(store.data.get('market-correction:v1:sh600415:11111111-2222-3333-4444-555555555555').payload.basis, '公告原文');
  // 重复请求编号不会覆盖已有存档。
  assert.equal(await corrections.archiveCorrection(store, {
    symbol: 'sh600415', key: 'statements-v3:sh600415:11', oldValue: { a: 1 }, newValue: { a: 3 },
    basis: '篡改', operator: 'codex', requestId: '11111111-2222-3333-4444-555555555555',
  }), false);
  const found = await corrections.readCorrections(store, 'sh600415');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].newValue, { a: 2 });
  assert.deepEqual(await corrections.readCorrections(store, 'sz000001'), []);
  // 修正键不属于任何公开数据族，只读接口不会暴露。
  assert.equal(resources.allowedPublicMarketKey('market-correction:v1:sh600415:11111111-2222-3333-4444-555555555555'), false);
  // 非股票规范代码在存档键中被拒绝由路由层保证；存档键含分隔符，scanPrefix 前缀精确。
  assert.equal((await store.scanPrefix('market-correction:v1:sh600415:', 10)).length, 1);
});

test('normalizeStockCode keeps only individual A and HK stocks', async () => {
  assert.equal(codes.normalizeStockCode('600415')?.symbol, 'sh600415');
  assert.equal(codes.normalizeStockCode('hk00700')?.symbol, 'hk00700');
  assert.equal(codes.normalizeStockCode('00700')?.symbol, 'hk00700');
  assert.equal(codes.normalizeStockCode('000001')?.symbol, 'sz000001');
  assert.equal(codes.normalizeStockCode('sh000001'), null); // 指数
  assert.equal(codes.normalizeStockCode('510300'), null); // ETF
  assert.equal(codes.normalizeStockCode('AAPL'), null);
});
