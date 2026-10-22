import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';

const {
  statementFieldUnit,
  hkStatementValue,
  financialUnitText,
  formatFinancialValue,
  showSingleQuarterChange,
} = await load('financeFieldSemantics');
const { catalogFromPage } = await load('datasource/sinaStatements');
const hk = await load('datasource/hkFinance');

test('real Sina profit-field names keep EPS in yuan per share instead of total amount units', () => {
  // Labels captured from the 002299 finance-fields response; amounts below are fixtures.
  const epsLabels = ['基本每股收益(元/股)', '稀释每股收益(元/股)'];
  const catalog = catalogFromPage('profit', {
    unit: '万元',
    rows: [...epsLabels, '营业收入'].map((name) => ({
      kind: 'field',
      name,
      vals: ['1.25'],
    })),
  });
  const fields = catalog.groups.flatMap((group) => group.fields);
  for (const label of epsLabels) {
    const field = fields.find((field) => field.label === label);
    assert.equal(field.unit, 'yuan');
    assert.equal(formatFinancialValue(1.25, field.unit), '1.25');
    assert.equal(financialUnitText(field.unit, label), '元/股');
    assert.equal(financialUnitText(field.unit, label, true), '元/股');
  }
  assert.equal(fields.find((field) => field.label === '营业收入').unit, 'wan');
});

test('statement totals still convert correctly while explicitly declared nonmonetary units are preserved', () => {
  assert.equal(formatFinancialValue(12500, 'wan'), '1.25');
  assert.equal(financialUnitText('wan', '营业收入'), '亿');
  assert.equal(financialUnitText('wan', '营业收入', true), '万元');
  assert.equal(statementFieldUnit('每股收益增长率(%)'), 'pct');
  assert.equal(statementFieldUnit('流动比率（倍）'), 'ratio');
  assert.equal(statementFieldUnit('每股基本盈利（港仙）'), '港仙/股');
  assert.equal(statementFieldUnit('每股盈利（美分）'), '美分/股');
  assert.equal(statementFieldUnit('每股收益（分）'), '分/股');
  assert.equal(statementFieldUnit('加权平均股数（股）'), '股');
  assert.equal(statementFieldUnit('股本（万股）'), '万股');
  assert.equal(hkStatementValue(125, '每股基本盈利（港仙）'), 125);
  assert.equal(hkStatementValue(2500000, '加权平均股数（股）'), 2500000);
});

test('HK EPS is not divided by ten thousand; statement amounts still normalize to wan', async () => {
  const originalFetch = globalThis.fetch;
  const date = `${new Date().getFullYear() - 1}-12-31`;
  const row = (itemCode, itemName, amount) => ({
    REPORT_DATE: date,
    STD_REPORT_DATE: date,
    STD_ITEM_CODE: itemCode,
    STD_ITEM_NAME: itemName,
    AMOUNT: amount,
  });
  globalThis.fetch = async (url) => {
    const report = new URL(url).searchParams.get('reportName');
    const data =
      report === 'RPT_HKF10_FN_MAININDICATOR'
        ? [
            {
              REPORT_DATE: date,
              REPORT_TYPE: `${date.slice(0, 4)}年报`,
              CURRENCY: 'HKD',
              BASIC_EPS: 1.25,
            },
          ]
        : report === 'RPT_HKF10_FN_INCOME'
          ? [
              row('revenue', '营业收入', 200000000),
              row('eps', '每股基本盈利（港元）', 1.25),
              row('eps-cent', '每股摊薄盈利（港仙）', 125),
            ]
          : [row('total', '资产总额', 300000000)];
    return new Response(
      JSON.stringify({ success: true, result: { pages: 1, data } }),
      { status: 200 },
    );
  };
  try {
    const catalog = await hk.fetchHkCatalog('00700.HK');
    const fields = catalog
      .find((statement) => statement.id === 'profit')
      .groups.flatMap((group) => group.fields);
    assert.equal(fields.find((field) => field.key === 'pl_ieps').unit, 'yuan');
    assert.equal(
      fields.find((field) => field.key === 'pl_ieps-cent').unit,
      '港仙/股',
    );
    assert.equal(
      fields.find((field) => field.key === 'pl_irevenue').unit,
      'wan',
    );
    const data = await hk.fetchHkCustomFinancials(
      '00700.HK',
      '00700',
      ['pl_irevenue', 'pl_ieps', 'pl_ieps-cent'],
      2,
    );
    assert.deepEqual(data.periods, [date]);
    assert.deepEqual(data.series.pl_irevenue, [20000]);
    assert.deepEqual(data.series.pl_ieps, [1.25]);
    assert.deepEqual(data.series['pl_ieps-cent'], [125]);
    assert.equal(data.currency, '原币未核实');
    assert.equal(data.fieldCurrencies.pl_ieps, '原币未核实');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('single-quarter rows are limited to additive statement flows in quarter view', () => {
  for (const key of [
    'pl_营业收入',
    'pl_营业成本',
    'cf_经营活动产生的现金流量净额',
  ]) {
    assert.equal(showSingleQuarterChange(key, 'wan', 'quarter'), true);
    assert.equal(showSingleQuarterChange(key, 'wan', 'annual'), false);
    assert.equal(showSingleQuarterChange(key, 'wan', 'semi'), false);
  }
  for (const [key, unit] of [
    ['bs_资产总计', 'wan'],
    ['currentRatio', 'ratio'],
    ['quickRatio', 'ratio'],
    ['debtRatio', 'pct'],
    ['bps', 'yuan'],
    ['undistPerShare', 'yuan'],
    ['eps', 'yuan'],
    ['ocfPerShare', 'yuan'],
    ['pl_基本每股收益(元/股)', 'yuan'],
    ['pl_加权平均股数（股）', '股'],
    ['fx_custom', 'wan'],
  ])
    assert.equal(showSingleQuarterChange(key, unit, 'quarter'), false, key);
});

test('formatting preserves negatives, zeros and unavailable data rather than inventing values', () => {
  assert.equal(formatFinancialValue(-1.25, 'yuan'), '-1.25');
  assert.equal(formatFinancialValue(0, 'yuan'), '0.00');
  assert.equal(formatFinancialValue(0, 'pct'), '0.00%');
  assert.equal(formatFinancialValue(null, 'wan'), '—');
  assert.equal(formatFinancialValue(NaN, 'yuan'), '—');
  assert.equal(formatFinancialValue(Infinity, 'wan'), '—');
});
