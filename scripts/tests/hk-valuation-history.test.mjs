import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load } from './load-modules.mjs';

const h = await load('datasource/hkValuationHistory');
const { retainMarketPayload } = await load('marketRetention');
const { classifyPhaseFailure, classifyGapText } = await load('marketFillGaps');
const now = Date.parse('2026-10-22T10:00:00Z');
const payload = (metric = 'pe', rows = [['2026-10-22', '9.39']], code = '00696') => ({ Result: [{ DisplayData: { resultData: { tplData: { result: {
  code, chartInfo: [{ header: [metric === 'pe' ? '市盈率(TTM)' : '市净率'], body: rows }],
} } } } }] });
const source = (metric, rows) => h.parseHkRatioHistory(payload(metric, rows), '00696', metric, 5, now);
const snapshot = () => ({ code: '00696', pe: 9.47, pb: 0.91, dividendYield: 3.52, pePercentile: null, pbPercentile: null,
  history: [], years: 5, source: 'eastmoney-hkf10', warnings: [], stale: false, stats: {} });

test('HK historical ratios validate security and metric, preserve losses/missing data and reject conflicting dates', () => {
  assert.throws(() => h.parseHkRatioHistory(payload('pe', undefined, '00700'), '00696', 'pe', 5, now), /错误证券或指标/);
  assert.throws(() => h.parseHkRatioHistory(payload('pb'), '00696', 'pe', 5, now), /错误证券或指标/);
  assert.throws(() => source('pe', [['2026-02-30', 1]]), /日期/);
  assert.throws(() => source('pe', [['2026-10-21', 9], ['2026-10-21', 10]]), /冲突/);
  const value = source('pe', [['2021-01-01', 99], ['2026-10-20', -2], ['2026-10-21', '--'], ['2026-10-22', 9.39], ['2026-10-23', 999]]);
  assert.deepEqual(value.rows, [{ date: '2026-10-20', value: null }, { date: '2026-10-21', value: null }, { date: '2026-10-22', value: 9.39 }]);
});

test('HK PE and PB histories are independent of dividends, raw prices and one another', () => {
  const pe = source('pe', Array.from({ length: 12 }, (_, i) => [`2026-10-${String(i + 10).padStart(2, '0')}`, i + 10]));
  const result = h.attachHkValuationHistory(snapshot(), { pe, pb: null }, now);
  assert.equal(result.historyByMetric.pe.length, 12);
  assert.equal(result.historyByMetric.pb.length, 0);
  assert.equal(result.stats.pe.current, 21);
  assert.equal(result.stats.pe.percentile, 91.7);
  assert.equal(result.pe, 9.47, 'live shared current cards keep their own financial basis');
  assert.equal(result.pePercentile, null, 'never compare a live quote-source PE to another provider history');
  assert.equal(result.history[0].close, null, 'a missing price is not invented from a ratio');
  assert.ok(result.historyUnavailableReasons.pb);
  assert.ok(result.historyUnavailableReasons.dy);
  assert.equal(result.historyBasis, 'provider');
});

test('HK provider loss or unknown latest sample cannot fall back to an older profitable current statistic', () => {
  const pe = source('pe', [['2026-10-20', 10], ['2026-10-21', 11], ['2026-10-22', -2]]);
  const result = h.attachHkValuationHistory(snapshot(), { pe, pb: null }, now);
  assert.equal(result.stats.pe.current, null);
  assert.equal(result.stats.pe.percentile, null);
  assert.equal(result.historyByMetric.pe.at(-1).pe, null);
});

test('HK static dividend history uses completed fiscal years only after both notice and ex-date; unknown FX and dates stay gaps', () => {
  const prices = ['2026-06-25', '2026-06-26', '2026-06-29'].map(date => ({ date, close: 10 }));
  const final = { exDate: '2026-06-26', noticeDate: '2026-03-20', dps: 0.4, period: '2025末期', fiscalYear: '2025', special: false, kind: 'final' };
  const future = { ...final, exDate: '2026-06-29', noticeDate: '2026-06-30', dps: 9, special: true, kind: 'special' };
  const result = h.attachHkValuationHistory(snapshot(), { pe: null, pb: null, prices, dividends: [final, future] }, now);
  assert.deepEqual(result.historyByMetric.dy.map(r => r.dy), [null, 4, 4]);
  assert.equal(result.historyByMetric.dy[1].close, 10);
  const unknown = h.attachHkValuationHistory(snapshot(), { pe: null, pb: null, prices, dividends: [{ ...final, noticeDate: '' }] }, now);
  assert.ok(unknown.historyUnavailableReasons.dy);
  const fx = h.attachHkValuationHistory(snapshot(), { pe: null, pb: null, prices, dividends: [{ ...final, dps: null }] }, now);
  assert.ok(fx.historyByMetric.dy.every(r => r.dy === null));
});

test('HK coverage checks sampled series range and freshness, never requires one ratio per trading day', () => {
  const rows = Array.from({ length: 12 }, (_, i) => [i ? `2026-10-${String(i + 10).padStart(2, '0')}` : '2021-10-22', i + 10]);
  const result = h.attachHkValuationHistory(snapshot(), { pe: source('pe', rows), pb: source('pb', rows) }, now);
  assert.ok(h.hkValuationHistoryCovered(result, '2021-10-22', '2026-10-22'));
  assert.equal(h.hkValuationHistoryCovered({ ...result, historyByMetric: { pe: result.historyByMetric.pe, pb: [] } }, '2021-10-22', '2026-10-22'), false);
  assert.equal(h.hkValuationHistoryCovered(result, '2021-10-22', '2026-11-15'), false);
});

test('historical ratio records persist per metric and duration, work offline in database mode and retain ten years only', async () => {
  const originalFetch = globalThis.fetch, priorDir = process.env.MARKET_DATA_DIR, priorMode = process.env.MARKET_READ_MODE;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fin-hk-ratios-'));
  let calls = 0;
  process.env.MARKET_DATA_DIR = dir; delete process.env.MARKET_READ_MODE;
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  globalThis.fetch = async input => {
    calls++; const url = new URL(input);
    assert.equal(url.searchParams.get('chart_select'), '近五年');
    assert.equal(url.searchParams.get('market'), 'hk');
    return Response.json(payload('pe', [[today, 9.39]]));
  };
  try {
    const first = await h.fetchHkRatioHistory('hk00696', 'pe', 5);
    assert.equal((await h.fetchHkRatioHistory('hk00696', 'pe', 5)).rows[0].value, 9.39);
    assert.equal(calls, 1);
    process.env.MARKET_READ_MODE = 'database';
    globalThis.fetch = async () => { throw Error('network must not be called'); };
    assert.deepEqual(await h.fetchHkRatioHistory('hk00696', 'pe', 5), first);
    await assert.rejects(h.fetchHkRatioHistory('hk00696', 'pb', 5), /尚未入库/);
    await assert.rejects(h.fetchHkRatioHistory('hk00696', 'pe', 10), /尚未入库/);
    const trimmed = retainMarketPayload('source-hk-valuation', { rows: [{ date: '2010-01-01', value: 1 }, { date: '2026-10-22', value: 2 }] }, now);
    assert.deepEqual(trimmed.rows, [{ date: '2026-10-22', value: 2 }]);
  } finally {
    globalThis.fetch = originalFetch;
    if (priorDir === undefined) delete process.env.MARKET_DATA_DIR; else process.env.MARKET_DATA_DIR = priorDir;
    if (priorMode === undefined) delete process.env.MARKET_READ_MODE; else process.env.MARKET_READ_MODE = priorMode;
    const target = path.resolve(dir), parent = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(target.startsWith(parent) && path.basename(target).startsWith('fin-hk-ratios-'));
    await fs.rm(target, { recursive: true, force: true });
  }
});

test('HK background phases and new historical gaps are actionable instead of dismissed as a design limitation', () => {
  assert.deepEqual(classifyPhaseFailure(10, 'HK').manual, ['source-hk-valuation:pe']);
  assert.deepEqual(classifyPhaseFailure(11, 'HK').manual, ['source-hk-valuation:pb']);
  assert.ok(classifyGapText('港股历史估值样本暂缺、过旧或覆盖不足'));
});
