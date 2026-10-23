import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { load } from './load-modules.mjs';
const gaps = await load('marketFillGaps');
const hk = await load('marketHkImportRecords');
const bars = await load('marketImportedBars');
const market = await load('marketStore');
const auth = await load('marketImportAuth');
const maintainAuth = await load('marketMaintainAuth');
const session = await load('auth/session');
const records = await load('marketImportRecords');
const now = Date.parse('2026-10-21T13:00:00Z');
function store() {
  const data = new Map();
  return { data, read: async key => data.get(key) ?? null,
    async write(row, expected) { if ((data.get(row.key)?.digest ?? null) !== expected) return false; data.set(row.key, structuredClone(row)); return true; },
    async remove(key) { data.delete(key); return true; }, incident: async () => {},
    seed(key, kind, payload) { data.set(key, market.marketRecord(key, kind, 'test', payload, 1e8, now)); },
  };
}

/* ---------------- 分类器 ---------------- */

test('missing keys split into mcp-fillable and manual buckets', () => {
  assert.deepEqual(gaps.classifyMissingKey('kline:v2:hk00012'), { domain: 'kline', mcp: true });
  assert.deepEqual(gaps.classifyMissingKey('source-sina-page:v1:600415:profit:2024'), { domain: 'finance:profit:2024', mcp: true });
  assert.deepEqual(gaps.classifyMissingKey('source-hk-statement:v1:00016.HK:balance:2026-06-30'), { domain: 'hk-statements:balance:2026-06-30', mcp: true });
  assert.deepEqual(gaps.classifyMissingKey('hk-dividend-events-v4:hk00100'), { domain: 'hk-dividend-events', mcp: true });
  assert.deepEqual(gaps.classifyMissingKey('statements-v3:600415:6'), { domain: 'financial-history', mcp: true });
  assert.deepEqual(gaps.classifyMissingKey('shares-v3:600415'), { domain: 'share-history', mcp: true });
  assert.deepEqual(gaps.classifyMissingKey('dividend-plans-v2:600415'), { domain: 'dividend-plans', mcp: true });
  assert.deepEqual(gaps.classifyMissingKey('implemented-dividends-v4:600415'), { domain: 'dividend-impl', mcp: true });
  // 无稳定 MCP 字段映射的键归入 manual，原键保留便于排查
  assert.deepEqual(gaps.classifyMissingKey('source-sina-indicators:v1:600415:2024'), { domain: 'source-sina-indicators:v1:600415:2024', mcp: false });
  assert.deepEqual(gaps.classifyMissingKey('disclosures-v3:600415:7'), { domain: 'disclosures-v3:600415:7', mcp: false });
});

test('gap text classification skips the designed HK valuation gap', () => {
  assert.equal(gaps.classifyGapText('港股历史估值仍缺少可核验的公告与分红快照，不生成历史分位'), null);
  const start = gaps.classifyGapText('历史起点覆盖不足，或缺少已核实的上市日期');
  assert.equal(start.mcp, true); assert.deepEqual(start.domains, ['kline']);
  const valuation = gaps.classifyGapText('部分交易日缺少已披露财报、股本或复权数据');
  assert.equal(valuation.mcp, true);
  assert.equal(gaps.classifyGapText('某处未知原因').mcp, false);
});

test('phase failures map to the right domains per market', () => {
  const year = new Date(now + 8 * 3600e3).getUTCFullYear();
  assert.deepEqual(gaps.classifyPhaseFailure(0, 'A', now).mcp, ['kline']);
  const hkPhase2 = gaps.classifyPhaseFailure(2, 'HK', now);
  assert.deepEqual(hkPhase2.mcp, ['hk-dividend-events']);
  assert.deepEqual(hkPhase2.manual, ['hk-main-currency-v4']);
  const aPhase2 = gaps.classifyPhaseFailure(2, 'A', now);
  assert.deepEqual(aPhase2.mcp, ['dividend-plans', 'dividend-impl', 'share-history']);
  const aPhase5 = gaps.classifyPhaseFailure(5, 'A', now);
  assert.deepEqual(aPhase5.mcp, [`finance:profit:${year - 2}`, `finance:balance:${year - 2}`, `finance:cashflow:${year - 2}`]);
  assert.deepEqual(aPhase5.manual, [`source-sina-indicators:v1:${year - 2}`]);
  assert.deepEqual(gaps.classifyPhaseFailure(10, 'A', now).mcp, ['financial-history']);
  assert.deepEqual(gaps.classifyPhaseFailure(11, 'A', now).manual, ['disclosures-v3']);
});

test('coverage classification returns null when ready or only designed gaps remain', () => {
  assert.equal(gaps.classifyCoverage(null), null);
  assert.equal(gaps.classifyCoverage({ status: 'ready' }), null);
  const hk = gaps.classifyCoverage({ status: 'partial', missingInputs: ['hk-dividend-events-v4:hk00100'], gaps: ['港股历史估值仍缺少可核验的公告与分红快照，不生成历史分位'] });
  assert.deepEqual(hk.mcp, ['hk-dividend-events']); assert.equal(hk.manual.length, 0);
  assert.equal(gaps.classifyCoverage({ status: 'partial', missingInputs: [], gaps: [] }), null);
});

/* ---------------- 台账读写 ---------------- */

test('gap ledger records, increments attempts, and clears', async () => {
  const s = store();
  const first = await gaps.recordFillGap(s, 'hk00100', { mcp: ['hk-dividend-events'], manual: [], notes: ['失败原因：x'], phase: 2 }, now);
  assert.equal(first.attempts, 1); assert.equal(first.market, 'HK');
  const row = await s.read(gaps.fillGapKey('hk00100'));
  assert.equal(row.kind, 'market-fill-gaps');
  const second = await gaps.recordFillGap(s, 'hk00100', { mcp: ['hk-dividend-events'], manual: ['hk-main-currency-v4'] }, now + 1000);
  assert.equal(second.attempts, 2);
  assert.deepEqual((await s.read(gaps.fillGapKey('hk00100'))).payload.manual, ['hk-main-currency-v4']);
  assert.equal(await gaps.clearFillGap(s, 'hk00100'), true);
  assert.equal(await gaps.readFillGap(s, 'hk00100'), null);
  assert.equal(await gaps.clearFillGap(s, 'hk00100'), false);
});

test('applyGapClassification records actionable gaps and clears the rest', async () => {
  const s = store();
  const kept = await gaps.applyGapClassification(s, 'sh600004', { mcp: ['kline'], manual: ['source-sina-indicators:v1:2024'], notes: [] }, { mode: 'five-year' }, now);
  assert.ok(kept); assert.equal(kept.market, 'A');
  assert.equal(await gaps.applyGapClassification(s, 'sh600004', null, {}, now + 1), null);
  assert.equal(await s.read(gaps.fillGapKey('sh600004')), null);
});

test('recordGapAfterFailure skips when phase 12 already wrote fresh coverage', async () => {
  const s = store();
  const startedAt = Date.parse('2026-10-21T12:00:00Z');
  s.seed('market-coverage:v1:hk00016:10', 'market-coverage', { status: 'partial', missingInputs: ['hk-dividend-events-v4:hk00016'], gaps: [], checkedAt: new Date(startedAt + 60e3).toISOString() });
  assert.equal(await gaps.recordGapAfterFailure(s, 'hk00016', { phase: 3, error: 'boom', startedAt }), null);
  // 更早 tick 留下的旧 coverage 仍参与分类
  const stale = await gaps.recordGapAfterFailure(s, 'hk00016', { phase: 3, error: 'boom', startedAt: startedAt + 600e3 }, now);
  assert.ok(stale); assert.deepEqual(stale.mcp, ['hk-statements', 'hk-dividend-events']);
});

test('recordGapAfterFailure merges phase errors and the failing phase', async () => {
  const s = store();
  const year = new Date(now + 8 * 3600e3).getUTCFullYear();
  const gap = await gaps.recordGapAfterFailure(s, 'sh600004', {
    phase: 5, error: '页面缺失', phaseErrors: { 3: '新浪超时', 10: '财务史失败' }, startedAt: now, now,
  });
  assert.deepEqual(gap.mcp, [
    `finance:profit:${year - 2}`, `finance:balance:${year - 2}`, `finance:cashflow:${year - 2}`,
    `finance:profit:${year}`, `finance:balance:${year}`, `finance:cashflow:${year}`,
    'financial-history',
  ]);
  assert.ok(gap.manual.includes(`source-sina-indicators:v1:${year - 2}`));
});

/* ---------------- 港股写入器 ---------------- */

const hkRow = (date, code, name, amount) => ({ date, itemCode: code, itemName: name, amount });

test('hk statements merge per report date, keep known values, and reject conflicts', async () => {
  const s = store();
  await hk.writeHkStatements(s, { symbol: 'hk00016', statement: 'profit', rows: [hkRow('2026-06-30', 'INCOME', '收益', 100)] }, now);
  await hk.writeHkStatements(s, { symbol: 'hk00016', statement: 'profit', rows: [hkRow('2026-06-30', 'INCOME', '收益', null), hkRow('2026-06-30', 'COST', '成本', 40)] }, now);
  const rows = (await s.read('source-hk-statement:v1:00016.HK:profit:2026-06-30')).payload;
  assert.equal(rows.find(r => r.itemCode === 'INCOME').amount, 100); // null 不擦除
  assert.equal(rows.find(r => r.itemCode === 'COST').amount, 40);
  assert.equal((await hk.writeHkStatements(s, { symbol: 'hk00016', statement: 'profit', rows: [hkRow('2026-06-30', 'COST', '成本', 40)] }, now)).skipped, true);
  await assert.rejects(hk.writeHkStatements(s, { symbol: 'hk00016', statement: 'profit', rows: [hkRow('2026-06-30', 'INCOME', '收益', 101)] }, now), /冲突/);
  await assert.rejects(hk.writeHkStatements(s, { symbol: 'hk00016', statement: 'balance', rows: [hkRow('2027-01-01', 'X', 'x', 1)] }, now), /保留期/);
  await assert.rejects(hk.writeHkStatements(s, { symbol: 'sh600415', statement: 'profit', rows: [hkRow('2026-06-30', 'X', 'x', 1)] }, now), /港股/);
});

test('hk dividend events dedupe by eventId, merge, and reject dps conflicts', async () => {
  const s = store();
  const row = (exDate, dps, extra = {}) => ({ exDate, dps, period: '2026-06-30', special: false, ...extra });
  const r1 = await hk.writeHkDividendEvents(s, { symbol: 'hk00016', rows: [row('2026-09-01', 0.5, { eventId: 'e1', kind: 'interim' })] }, now);
  assert.equal(r1.count, 1);
  const r2 = await hk.writeHkDividendEvents(s, { symbol: 'hk00016', rows: [row('2026-09-01', null, { eventId: 'e1', noticeDate: '2026-08-20' }), row('2026-03-01', 1.2, { eventId: 'e2', kind: 'final' })] }, now);
  assert.equal(r2.count, 2);
  const events = (await s.read('hk-dividend-events-v4:hk00016')).payload;
  assert.equal(events.length, 2);
  assert.equal(events[0].exDate, '2026-03-01'); assert.equal(events[0].dps, 1.2);
  assert.equal(events[1].dps, 0.5); assert.equal(events[1].noticeDate, '2026-08-20'); // null 不擦除、公告日补齐
  assert.equal((await hk.writeHkDividendEvents(s, { symbol: 'hk00016', rows: [row('2026-09-01', 0.5, { eventId: 'e1' })] }, now)).skipped, true);
  await assert.rejects(hk.writeHkDividendEvents(s, { symbol: 'hk00016', rows: [row('2026-09-01', 0.6, { eventId: 'e1' })] }, now), /冲突/);
  await assert.rejects(hk.writeHkDividendEvents(s, { symbol: 'hk00016', rows: [row('2026-09-01', 0.5), row('2026-09-01', 0.5)] }, now), /重复/);
});

/* ---------------- 导入路由 ---------------- */

function importRoute(s) {
  const exported = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/api/market/import/route.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: exported, Buffer, Date, Error, console, require(name) {
      if (name === 'next/server') return { NextResponse: { json: (body, o) => ({ body, status: o?.status ?? 200 }) } };
      if (name === '@/lib/marketStore') return { ...market, getMarketStore: () => s };
      if (name === '@/lib/marketImportedBars') return bars;
      if (name === '@/lib/marketImportRecords') return records;
      if (name === '@/lib/marketHkImportRecords') return hk;
      if (name === '@/lib/marketImportAuth') return auth;
      if (name === '@/lib/marketMaintainAuth') return maintainAuth;
      throw Error(name);
    },
  });
  return exported;
}
const adminRequest = (body) => {
  process.env.AUTH_SESSION_SECRET = 'isolated-tests-only-secret-32-characters';
  process.env.MARKET_IMPORT_ADMIN_IDS = 'admin-test';
  const token = session.createSession({ id: 'admin-test', phone: 'admin_test' }, process.env.AUTH_SESSION_SECRET);
  return { url: 'https://site.test/api/market/import', headers: new Headers({ origin: 'https://site.test', 'x-fin-csrf': '1' }), cookies: { get: () => ({ value: token }) }, text: async () => JSON.stringify(body) };
};

test('import route accepts hk-statements and hk-dividend-events records', async () => {
  const s = store(), route = importRoute(s);
  const stmt = await route.POST(adminRequest({ type: 'hk-statements', record: { symbol: 'hk00016', statement: 'balance', rows: [hkRow('2026-06-30', 'CASH', '现金', 500)] } }));
  assert.equal(stmt.body.ok, true);
  assert.equal((await s.read('source-hk-statement:v1:00016.HK:balance:2026-06-30')).payload.length, 1);
  const div = await route.POST(adminRequest({ type: 'hk-dividend-events', record: { symbol: 'hk00016', rows: [{ exDate: '2026-09-01', dps: 0.5, period: '2026-06-30', special: false, kind: 'interim' }] } }));
  assert.equal(div.body.ok, true);
  assert.equal((await s.read('hk-dividend-events-v4:hk00016')).payload.length, 1);
  // 冲突返回 409 且不写入
  const conflict = await route.POST(adminRequest({ type: 'hk-dividend-events', record: { symbol: 'hk00016', rows: [{ exDate: '2026-09-01', dps: 0.9, period: '2026-06-30', special: false }] } }));
  assert.equal(conflict.status, 409);
  assert.equal((await s.read('hk-dividend-events-v4:hk00016')).payload[0].dps, 0.5);
  const bad = await route.POST(adminRequest({ type: 'hk-statements', record: { symbol: 'sh600415', statement: 'balance', rows: [hkRow('2026-06-30', 'CASH', '现金', 1)] } }));
  assert.equal(bad.status, 400);
});

test('import route passes tdx source through for kline and rejects unknown sources', async () => {
  const s = store(), route = importRoute(s);
  const candles = [{ date: '2026-08-25', open: 10, high: 11, low: 9, close: 10.5 }];
  const ok = await route.POST(adminRequest({ type: 'kline', record: { symbol: 'hk00012', source: 'tdx', candles } }));
  assert.equal(ok.body.ok, true);
  const stored = (await s.read(bars.importedBarsKey('hk00012'))).payload;
  assert.equal(stored.source, 'canonical');
  assert.equal(stored.origins.at(-1).source, 'tdx');
  const bad = await route.POST(adminRequest({ type: 'kline', record: { symbol: 'hk00012', source: 'sina', candles: [{ ...candles[0], date: '2026-08-26' }] } }));
  assert.equal(bad.status, 400);
});
