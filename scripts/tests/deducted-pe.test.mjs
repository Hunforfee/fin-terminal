import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';
const { shiftQuarter, singleQuarter, computeDeductedPe, parseDeductedPeriods } = await load('datasource/deductedPe');

test('shiftQuarter keeps report dates on quarter ends', () => {
  assert.equal(shiftQuarter('2026-06-30', -1), '2026-03-31');
  assert.equal(shiftQuarter('2026-03-31', -1), '2025-12-31');
  assert.equal(shiftQuarter('2026-06-30', -4), '2025-06-30');
});

test('single quarter = current cumulative minus previous cumulative of the SAME year', () => {
  const periods = parseDeductedPeriods([
    { REPORT_DATE: '2026-06-30 00:00:00', KCFJCXSYJLR: 44464207646.01 },
    { REPORT_DATE: '2026-03-31 00:00:00', KCFJCXSYJLR: 27000000000 },
    { REPORT_DATE: '2025-12-31 00:00:00', KCFJCXSYJLR: 90000000000 },
    { REPORT_DATE: '2025-09-30 00:00:00', KCFJCXSYJLR: 65000000000 },
  ]);
  // Q1 本身就是单季累计
  assert.equal(singleQuarter(periods, '2026-03-31'), 27000000000);
  // Q2 = 中报 − 一季报
  assert.equal(singleQuarter(periods, '2026-06-30'), 44464207646.01 - 27000000000);
  // Q4 = 年报 − 同年三季报（不是减上年年报，这是之前的 bug）
  assert.equal(singleQuarter(periods, '2025-12-31'), 25000000000);
  // Q3 = 三季报 − 中报，缺中报时不能猜
  assert.equal(singleQuarter(periods, '2025-09-30'), null);
});

test('deducted pe uses four quarters of profit and total market cap', () => {
  const periods = parseDeductedPeriods([
    { REPORT_DATE: '2026-06-30', KCFJCXSYJLR: 44464207646.01 },
    { REPORT_DATE: '2026-03-31', KCFJCXSYJLR: 27000000000 },
    { REPORT_DATE: '2025-12-31', KCFJCXSYJLR: 90000000000 },
    { REPORT_DATE: '2025-09-30', KCFJCXSYJLR: 65000000000 },
    { REPORT_DATE: '2025-06-30', KCFJCXSYJLR: 41600000000 },
    { REPORT_DATE: '2025-03-31', KCFJCXSYJLR: 26000000000 },
    { REPORT_DATE: '2024-12-31', KCFJCXSYJLR: 85000000000 },
    { REPORT_DATE: '2024-09-30', KCFJCXSYJLR: 61000000000 },
  ]);
  const r = computeDeductedPe(periods, 1.86e12);
  // 单季：Q3'25=(65-41.6)=23.4e9, Q4'25=(90-65)=25e9, Q1'26=27e9, Q2'26=(44.464-27)=17.464e9
  const ttm = 23400000000 + 25000000000 + 27000000000 + (44464207646.01 - 27000000000);
  assert.equal(r.ttmProfit, Math.round(ttm * 100) / 100);
  assert.equal(r.pe, Math.round((1.86e12 / ttm) * 100) / 100);
  assert.deepEqual(r.quarters, ['2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30']);
});

test('missing quarter yields no PE instead of substituting annual data', () => {
  const periods = parseDeductedPeriods([
    { REPORT_DATE: '2026-06-30', KCFJCXSYJLR: 100 },
    { REPORT_DATE: '2026-03-31', KCFJCXSYJLR: 50 },
    // 缺 2025-12-31，无法组成四个连续单季。
  ]);
  const r = computeDeductedPe(periods, 1e9);
  assert.equal(r.pe, null);
  assert.equal(r.reason, 'incomplete');
});

const completeRows = [
  ['2026-06-30', 100], ['2026-03-31', 40], ['2025-12-31', 200],
  ['2025-09-30', 140], ['2025-06-30', 90], ['2025-03-31', 30],
].map(([REPORT_DATE, KCFJCXSYJLR]) => ({ REPORT_DATE, KCFJCXSYJLR }));

test('latest missing or invalid profit stays anchored to that report instead of falling back', () => {
  for (const missing of [null, undefined, '', '  ', '-', NaN]) {
    const periods = parseDeductedPeriods([
      { REPORT_DATE: '2026-09-30', KCFJCXSYJLR: missing }, ...completeRows,
    ]);
    assert.equal(periods.at(-1).reportDate, '2026-09-30');
    assert.equal(periods.at(-1).cumulative, null);
    const r = computeDeductedPe(periods, 2100);
    assert.equal(r.pe, null);
    assert.equal(r.ttmProfit, null);
    assert.equal(r.reason, 'incomplete');
  }
});

test('a missing preceding cumulative value cannot be treated as zero for a single quarter', () => {
  // 四个目标季报都存在，但最早单季 Q3 依赖的同年中报累计缺失。
  for (const rows of [
    completeRows.filter(row => row.REPORT_DATE !== '2025-06-30'),
    completeRows.map(row => row.REPORT_DATE === '2025-06-30' ? { ...row, KCFJCXSYJLR: null } : row),
  ]) {
    const periods = parseDeductedPeriods(rows);
    assert.equal(singleQuarter(periods, '2025-09-30'), null);
    const r = computeDeductedPe(periods, 2100);
    assert.equal(r.pe, null);
    assert.equal(r.ttmProfit, null);
    assert.equal(r.reason, 'incomplete');
  }
  // 实际披露为零仍是有效基数。
  const zeroBase = parseDeductedPeriods(completeRows.map(row => row.REPORT_DATE === '2025-06-30' ? { ...row, KCFJCXSYJLR: 0 } : row));
  assert.equal(singleQuarter(zeroBase, '2025-09-30'), 140);
  assert.equal(computeDeductedPe(zeroBase, 2100).ttmProfit, 300);
});

test('all latest quarter positions reconcile to the annual plus current YTD minus prior YTD identity', () => {
  const rows = [
    ['2024-03-31', 10], ['2024-06-30', 30], ['2024-09-30', 60], ['2024-12-31', 100],
    ['2025-03-31', 20], ['2025-06-30', 50], ['2025-09-30', 90], ['2025-12-31', 140],
    ['2026-03-31', 30], ['2026-06-30', 70], ['2026-09-30', 120],
  ].map(([REPORT_DATE, KCFJCXSYJLR]) => ({ REPORT_DATE, KCFJCXSYJLR }));
  for (const [latest, expectedTtm] of [['2025-12-31', 140], ['2026-03-31', 150], ['2026-06-30', 160], ['2026-09-30', 170]]) {
    const periods = parseDeductedPeriods(rows.filter(row => row.REPORT_DATE <= latest));
    const r = computeDeductedPe(periods, expectedTtm * 10);
    assert.equal(r.ttmProfit, expectedTtm);
    assert.equal(r.pe, 10);
    assert.equal(r.quarters.length, 4);
    assert.equal(r.quarters.at(-1), latest);
    assert.deepEqual(r.quarters, [...r.quarters].sort());
  }
});

test('negative or zero deducted profit has no meaningful PE', () => {
  // 2025 全年累计亏损 400，2026 上半年累计仍为 -300 → 四个单季合计为负
  const periods = parseDeductedPeriods([
    { REPORT_DATE: '2026-06-30', KCFJCXSYJLR: -300 },
    { REPORT_DATE: '2026-03-31', KCFJCXSYJLR: -200 },
    { REPORT_DATE: '2025-12-31', KCFJCXSYJLR: -400 },
    { REPORT_DATE: '2025-09-30', KCFJCXSYJLR: -300 },
    { REPORT_DATE: '2025-06-30', KCFJCXSYJLR: -250 },
    { REPORT_DATE: '2025-03-31', KCFJCXSYJLR: -100 },
    { REPORT_DATE: '2024-12-31', KCFJCXSYJLR: -500 },
    { REPORT_DATE: '2024-09-30', KCFJCXSYJLR: -350 },
  ]);
  const r = computeDeductedPe(periods, 1e9);
  assert.ok(r.ttmProfit < 0, '四个单季合计应为负');
  assert.equal(r.pe, null);
  assert.equal(r.reason, 'non-positive');
});

test('empty data or missing market cap returns null', () => {
  assert.equal(computeDeductedPe([], 1e9).pe, null);
  const periods = parseDeductedPeriods([
    { REPORT_DATE: '2026-06-30', KCFJCXSYJLR: 100 },
    { REPORT_DATE: '2026-03-31', KCFJCXSYJLR: 50 },
    { REPORT_DATE: '2025-12-31', KCFJCXSYJLR: 80 },
    { REPORT_DATE: '2025-09-30', KCFJCXSYJLR: 60 },
    { REPORT_DATE: '2025-06-30', KCFJCXSYJLR: 40 },
    { REPORT_DATE: '2025-03-31', KCFJCXSYJLR: 30 },
    { REPORT_DATE: '2024-12-31', KCFJCXSYJLR: 70 },
    { REPORT_DATE: '2024-09-30', KCFJCXSYJLR: 50 },
    { REPORT_DATE: '2023-12-31', KCFJCXSYJLR: 60 },
    { REPORT_DATE: '2023-09-30', KCFJCXSYJLR: 40 },
  ]);
  assert.equal(computeDeductedPe(periods, null).pe, null);
  assert.equal(computeDeductedPe(periods, Infinity).pe, null);
});
