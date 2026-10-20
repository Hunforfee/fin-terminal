import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';
const { parseDebtRatios } = await load('datasource/debtRatios');
const { fetchCustomFinancials } = await load('datasource/sinaStatements');
const { PRESET_FORMULAS, evalFormula } = await load('financeFormulas');
const { parseInterestExpenses } = await load('datasource/interestExpenses');
const base = { SECUCODE: '600415.SH', REPORT_DATE: '2026-06-30 00:00:00', NOTICE_DATE: '2026-08-26', CURRENCY: 'CNY', INTEREST_DEBT_RATIO: 7.6095873446 };

test('debt ratio preserves provider percentage points, genuine zero and missing values', () => {
  for (const [raw, expected] of [[7.6095873446,7.6095873446],[0,0],[null,null],[' ',null],[false,null],[-1,null]]) {
    const values = parseDebtRatios([{...base, INTEREST_DEBT_RATIO: raw}], '600415.SH', '2026-10-21');
    assert.equal(values.get('2026-06-30'), expected);
    const formula = PRESET_FORMULAS.find(f => f.id === 'p-interest-debt-ratio');
    assert.deepEqual(evalFormula(formula.expr, {interestDebtRatio:[expected]},1,formula),[expected]);
  }
});

test('debt ratio rejects foreign identities, units, bad dates and conflicting duplicates', () => {
  for (const patch of [{SECUCODE:'300498.SZ'},{CURRENCY:'HKD'},{REPORT_DATE:'2026-02-30'},{REPORT_DATE:'2026-12-31'}])
    assert.throws(() => parseDebtRatios([{...base,...patch}], '600415.SH','2026-10-21'));
  assert.throws(() => parseDebtRatios([base,{...base,INTEREST_DEBT_RATIO:8}], '600415.SH','2026-10-21'), /冲突/);
  assert.equal(parseDebtRatios([base,{...base}], '600415.SH','2026-10-21').size,1);
  assert.equal(parseDebtRatios([{...base,NOTICE_DATE:'2026-11-01'}], '600415.SH','2026-10-21').size,0);
});

test('financial pipeline fetches explicit debt ratio without relying on absent lease/loan fields', async () => {
  const original=globalThis.fetch;
  globalThis.fetch=async url => {
    const u=new URL(String(url));
    assert.equal(u.searchParams.get('reportName'),'RPT_F10_FINANCE_MAINFINADATA');
    assert.ok(u.searchParams.get('filter').includes('600415.SH'));
    return Response.json({success:true,result:{pages:1,data:[base]}});
  };
  try {
    const data=await fetchCustomFinancials('600415',['interestDebtRatio'],10,'小商品城');
    assert.deepEqual(data.periods,['2026-06-30']);
    assert.deepEqual(data.series.interestDebtRatio,[7.6095873446]);
    const formula=PRESET_FORMULAS.find(f=>f.id==='p-interest-debt-ratio');
    assert.deepEqual(evalFormula(formula.expr,data.series,1,formula),[7.6095873446]);
  } finally { globalThis.fetch=original; }
});

test('interest expense parsing never fabricates zeros from blank or boolean values', () => {
  for(const value of [' ',false,true,null,undefined]) {
    const rows=parseInterestExpenses([{REPORT_DATE:'2025-12-31',TOTAL_PROFIT:100,FE_INTEREST_EXPENSE:value}]);
    assert.equal(rows.get('2025-12-31').get('pl_利息费用'),null);
  }
});
