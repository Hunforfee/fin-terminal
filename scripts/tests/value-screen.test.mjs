import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { load } from './load-modules.mjs';

const shared = await load('valueScreen');
const service = await load('datasource/valueScreen');
const { clearCache } = await load('datasource/cache');
const {
  valueScreenToday, valueScreenPeriods, valueScreenUniverse, selectValueScreenUniverse,
  readValueScreenCriteria, emptyValueScreenRow, matchesValueScreenFinancial, matchesValueScreenQuote,
  valueScreenRequestedPeriods,
} = shared;
const { getValueScreenMeta, parseValueScreenFinancials, fetchValueScreenReportPages, fetchValueScreenReports, runValueScreen } = service;
const today = '2026-10-19', period = '2025-12-31';
const now = new Date('2026-10-19T06:00:00Z');
const criteria = extra => ({ period, scope: 'all', ...extra });
const universe = valueScreenUniverse([{ name: '食品饮料', stocks: ['600519', '600415'] }, { name: '银行', stocks: ['000001'] }]);
const financial = (code, extra = {}) => ({
  SECURITY_CODE: code, SECURITY_NAME_ABBR: `公司${code}`, REPORT_DATE: `${period} 00:00:00`,
  NOTICE_DATE: '2026-04-17 00:00:00', UPDATE_DATE: '2026-04-17 00:00:00', CURRENCY: 'CNY',
  ROEJQ: 32.53, XSJLL: 50.52, TOTALOPERATEREVETZ: -1.2, PARENTNETPROFITTZ: -4.53,
  KCFJCXSYJLRTZ: -5, ZCFZL: 16.41, NETCASH_OPERATE_PK: 61522204989.35,
  MGJYXJJE: 49.128538116153, KCFJCXSYJLR: 81e9, ...extra,
});
const income = (code, extra = {}) => ({ ...financial(code), NETPROFIT: 85310324833.67, PARENT_NETPROFIT: 82320067101.68, ...extra });
const quote = (symbol, extra = {}) => ({
  symbol, code: symbol.slice(2), kind: 'stock', market: symbol.slice(0, 2).toUpperCase(),
  name: `行情${symbol}`, price: 10, pe: 20, pb: 2, totalMarketCap: 100,
  ts: '2026-10-19T10:00:00+08:00', stale: false, ...extra,
});
const reports = { main: [financial('600519')], income: [income('600519')] };
const approx = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('screen metadata covers the full bundled A-share universe and all 31 first-level industries', () => {
  const meta = getValueScreenMeta(now);
  assert.equal(meta.industries.length, 31);
  assert.ok(meta.universeCount > 4000, 'the old 104-company sample is not the candidate pool');
  assert.equal(meta.industries.reduce((sum, industry) => sum + industry.count, 0), meta.universeCount);
  assert.equal(meta.defaultPeriod, 'auto');
  assert.equal(meta.periods.length, 8);
  const rows = valueScreenUniverse([{ name: '银行', stocks: ['000001', '920087', '200019', '900908', '00700', '899050', '600519', '600519'] }]);
  assert.deepEqual(rows.map(row => row.symbol), ['sz000001', 'sh600519', 'bj920087']);
});

test('latest report periods include completed quarters in Shanghai time', () => {
  assert.equal(valueScreenToday(new Date('2026-04-30T16:00:00Z')), '2026-05-01');
  assert.equal(valueScreenPeriods(new Date('2026-04-30T15:59:59Z'))[0], '2026-03-31');
  assert.equal(valueScreenPeriods(new Date('2026-04-30T16:00:00Z'))[0], '2026-03-31');
});

test('criteria reject invalid or silently ignored filters and add no implicit thresholds', () => {
  assert.deepEqual(readValueScreenCriteria(criteria({}), ['银行'], now), criteria({}));
  assert.deepEqual(readValueScreenCriteria(criteria({ peMin: 0, cashflowPositive: false }), ['银行'], now), criteria({ peMin: 0, cashflowPositive: false }));
  for (const raw of [null, [], criteria({ scope: 'HK' }), criteria({ industries: ['不存在'] }), criteria({ roeMin: '15' }),
    criteria({ roeMin: null }), criteria({ roeMin: NaN }), criteria({ cashflowPositive: 'true' }),
    criteria({ peMin: 20, peMax: 10 }), criteria({ codes: [123] }), criteria({ limit: 300 }),
    criteria({ period: '2026-12-31' }), criteria({ period: '2025-05-31' })])
    assert.throws(() => readValueScreenCriteria(raw, ['银行'], now));
});

test('watchlist scope never falls back to all shares and preserves stock/index code identity', () => {
  assert.equal(selectValueScreenUniverse(universe, criteria({ scope: 'watchlist', codes: [] })).length, 0);
  assert.equal(selectValueScreenUniverse(universe, criteria({ scope: 'watchlist', codes: ['hk00700', 'sh000001'] })).length, 0);
  assert.deepEqual(selectValueScreenUniverse(universe, criteria({ scope: 'watchlist', codes: ['000001', 'SZ000001', '600519.SH'] })).map(row => row.symbol), ['sz000001', 'sh600519']);
});

test('industry selection includes many, excludes many, and exclusion always wins', () => {
  assert.equal(selectValueScreenUniverse(universe, criteria({ industries: ['食品饮料', '银行'] })).length, 3);
  assert.deepEqual(selectValueScreenUniverse(universe, criteria({ industries: ['食品饮料'] })).map(row => row.code), ['600415', '600519']);
  assert.deepEqual(selectValueScreenUniverse(universe, criteria({ excludedIndustries: ['食品饮料'] })).map(row => row.code), ['000001']);
  assert.deepEqual(selectValueScreenUniverse(universe, criteria({ industries: ['食品饮料', '银行'], excludedIndustries: ['银行'] })).map(row => row.code), ['600415', '600519']);
  assert.equal(selectValueScreenUniverse(universe, criteria({ industries: [], excludedIndustries: [] })).length, 3);
});

test('industry lists validate against the classification and reject self-contradiction', () => {
  const names = ['银行', '食品饮料'];
  assert.deepEqual(readValueScreenCriteria(criteria({ industries: ['银行', ' 银行 ', '食品饮料'] }), names, now), criteria({ industries: ['银行', '食品饮料'] }));
  // Legacy single-value payloads still work.
  assert.deepEqual(readValueScreenCriteria(criteria({ industry: '银行' }), names, now), criteria({ industries: ['银行'] }));
  assert.deepEqual(readValueScreenCriteria(criteria({ industry: '' }), names, now), criteria({}));
  for (const raw of [criteria({ industries: '银行' }), criteria({ industries: ['不存在'] }),
    criteria({ excludedIndustries: [123] }), criteria({ excludedIndustries: ['不存在'] }),
    criteria({ industries: Array.from({ length: 51 }, () => '银行') }),
    criteria({ industries: ['银行'], excludedIndustries: ['银行'] })])
    assert.throws(() => readValueScreenCriteria(raw, names, now));
  assert.throws(() => readValueScreenCriteria(criteria({ industries: ['银行'], excludedIndustries: ['银行'] }), names, now), /同时被包含和排除/);
});

test('auto period requests several report dates and each row keeps the date actually matched', async () => {
  const meta = getValueScreenMeta(now);
  assert.equal(meta.defaultPeriod, 'auto');
  assert.deepEqual(meta.fallbackPeriods, ['2026-09-30', '2026-06-30', '2026-03-31', period, '2025-09-30', '2025-06-30', '2025-03-31', '2024-12-31']);
  assert.deepEqual(valueScreenRequestedPeriods(criteria({ period: 'auto' }), meta.periods), meta.fallbackPeriods);
  assert.deepEqual(valueScreenRequestedPeriods(criteria({}), meta.periods), [period]);

  const older = (code, extra = {}) => financial(code, { REPORT_DATE: '2024-12-31 00:00:00', NOTICE_DATE: '2025-04-20 00:00:00', UPDATE_DATE: '2025-04-20 00:00:00', ...extra });
  let requested;
  const result = await runValueScreen(criteria({ period: 'auto' }), async symbols => symbols.map(symbol => quote(symbol)), {
    universe, now,
    reports: async periods => { requested = periods; return { main: [financial('600519'), older('600415'), older('000001', { ROEJQ: 5 })], income: [] }; },
  });
  assert.deepEqual(requested, meta.fallbackPeriods);
  assert.equal(result.requestedPeriod, 'auto');
  assert.equal(result.period, '2026-09-30', 'the headline period stays the newest requested date');
  assert.equal(result.financialCount, 3);
  assert.equal(result.fallbackCount, 3);
  assert.equal(result.rows.find(row => row.code === '600519').period, period);
  assert.equal(result.rows.find(row => row.code === '600415').period, '2024-12-31');
});

test('newer report dates beat older ones regardless of row order and notice dates', () => {
  const rows = [
    financial('600519', { REPORT_DATE: '2024-12-31 00:00:00', NOTICE_DATE: '2025-04-20 00:00:00', UPDATE_DATE: '2025-04-20 00:00:00', ROEJQ: 1 }),
    financial('600519', { REPORT_DATE: '2025-12-31 00:00:00', NOTICE_DATE: '2026-04-17 00:00:00', UPDATE_DATE: '2026-04-17 00:00:00', ROEJQ: 2 }),
    // Same date, newer disclosure version wins.
    financial('600519', { REPORT_DATE: '2025-12-31 00:00:00', NOTICE_DATE: '2026-04-17 00:00:00', UPDATE_DATE: '2026-06-01 00:00:00', ROEJQ: 3 }),
  ];
  const parsed = parseValueScreenFinancials({ main: rows, income: [] }, [period, '2024-12-31'], today).get('600519');
  assert.equal(parsed.roe, 3);
  assert.equal(parsed.period, period);
});

test('real annual fields keep disclosed weighted ROE and CNY units, using total consolidated net profit', () => {
  const row = parseValueScreenFinancials(reports, [period], today).get('600519');
  assert.equal(row.roe, 32.53);
  assert.equal(row.netMargin, 50.52);
  assert.equal(row.revenueGrowth, -1.2);
  assert.equal(row.profitGrowth, -4.53);
  assert.equal(row.deductedGrowth, -5);
  assert.equal(row.debtRatio, 16.41);
  approx(row.operatingCashFlow, 615.2220498935);
  approx(row.ocfToProfit, 61522204989.35 / 85310324833.67 * 100);
  assert.notEqual(row.ocfToProfit, 61522204989.35 / 82320067101.68 * 100);
  assert.equal(row.ocfPerShare, 49.128538116153);
  assert.equal(row.deductedProfit, 810);
});

test('future disclosure, wrong reporting periods/currency, and future revisions cannot enter financial rows', () => {
  for (const extra of [{ NOTICE_DATE: '2026-10-20' }, { NOTICE_DATE: null }, { NOTICE_DATE: 'bad' },
    { REPORT_DATE: '2024-12-31' }, { CURRENCY: 'HKD' }, { UPDATE_DATE: '2026-10-20' }])
    assert.equal(parseValueScreenFinancials({ main: [financial('600519', extra)], income: [] }, [period], today).size, 0);
  for (const extra of [{ NOTICE_DATE: '2026-10-20' }, { REPORT_DATE: '2024-12-31' }, { CURRENCY: 'USD' }, { NETPROFIT: 0 }, { NETPROFIT: -100 }]) {
    const row = parseValueScreenFinancials({ main: reports.main, income: [income('600519', extra)] }, [period], today).get('600519');
    assert.equal(row.ocfToProfit, null);
  }
  const zero = parseValueScreenFinancials({ main: [financial('600519', { NETCASH_OPERATE_PK: 0, ROEJQ: null })], income: reports.income }, [period], today).get('600519');
  assert.equal(zero.operatingCashFlow, 0);
  assert.equal(zero.ocfToProfit, 0);
  assert.equal(zero.roe, null);
});

test('every activated numeric/positive financial condition excludes missing values; inactive fields do not', () => {
  const missing = emptyValueScreenRow(universe[0], period);
  assert.equal(matchesValueScreenFinancial(missing, criteria({})), true);
  for (const key of ['roeMin', 'netMarginMin', 'revenueGrowthMin', 'profitGrowthMin', 'deductedGrowthMin', 'debtRatioMax', 'ocfMin', 'ocfToProfitMin'])
    assert.equal(matchesValueScreenFinancial(missing, criteria({ [key]: 0 })), false, key);
  for (const key of ['cashflowPositive', 'deductedProfitPositive'])
    assert.equal(matchesValueScreenFinancial(missing, criteria({ [key]: true })), false, key);
  for (const key of ['peMin', 'peMax', 'pbMin', 'pbMax', 'marketCapMin', 'marketCapMax'])
    assert.equal(matchesValueScreenQuote(missing, criteria({ [key]: 0 })), false, key);
  const zeros = { ...missing, operatingCashFlow: 0, deductedProfit: 0, pe: 0, pb: 0 };
  assert.equal(matchesValueScreenFinancial(zeros, criteria({ ocfMin: 0 })), true);
  assert.equal(matchesValueScreenFinancial(zeros, criteria({ cashflowPositive: true })), false);
  assert.equal(matchesValueScreenFinancial(zeros, criteria({ deductedProfitPositive: true })), false);
  assert.equal(matchesValueScreenQuote(zeros, criteria({ peMin: 0, pbMax: 0 })), true);
});

test('empty watchlists avoid both financial and quote requests', async () => {
  const unreachable = async () => { throw Error('must not fetch'); };
  const result = await runValueScreen(criteria({ scope: 'watchlist', codes: [] }), unreachable, { universe, now, reports: unreachable });
  assert.equal(result.universeCount, 0);
  assert.equal(result.total, 0);
  assert.equal(result.partial, false);
});

test('financial conditions reduce quote requests and retain exact coverage counts', async () => {
  const requested = [];
  const result = await runValueScreen(criteria({ roeMin: 20 }), async symbols => {
    requested.push(...symbols); return symbols.map(symbol => quote(symbol));
  }, { universe, now, reports: async () => ({ main: [financial('600519'), financial('600415', { ROEJQ: 10 })], income: [] }) });
  assert.deepEqual(requested, ['sh600519']);
  assert.equal(result.universeCount, 3);
  assert.equal(result.financialCount, 2);
  assert.equal(result.scannedCount, 1);
  assert.equal(result.quoteCount, 1);
  assert.equal(result.total, 1);
  assert.equal(result.rows[0].roe, 32.53);
  assert.equal(result.partial, true);
});

test('missing quotes/reports remain visible without filters but cannot pass active missing-data filters', async () => {
  const fetchQuotes = async () => [quote('sh600519', { pe: 0 }), quote('hk00700'), quote('sh600415', { price: null, pe: 999 })];
  const result = await runValueScreen(criteria({}), fetchQuotes, { universe, now, reports: async () => reports });
  assert.equal(result.total, 3);
  assert.equal(result.quoteCount, 1);
  assert.equal(result.rows.find(row => row.code === '600415').pe, null);
  assert.equal(result.rows.find(row => row.code === '000001').financialAvailable, false);
  const filtered = await runValueScreen(criteria({ peMin: 0 }), fetchQuotes, { universe, now, reports: async () => reports });
  assert.deepEqual(filtered.rows.map(row => row.code), ['600519']);
  assert.equal(filtered.rows[0].pe, 0);
});

test('missing consolidated profit marks an active cash-profit condition unknown even with complete MAIN coverage', async () => {
  const single = universe.filter(row => row.code === '600519');
  const options = { universe: single, now, reports: async () => ({ main: reports.main, income: [] }) };
  const noQuotes = async () => { throw Error('financial unknowns must not trigger quote requests'); };
  const unknown = await runValueScreen(criteria({ ocfToProfitMin: 100 }), noQuotes, options);
  assert.equal(unknown.financialCount, 1);
  assert.equal(unknown.total, 0);
  assert.equal(unknown.scannedCount, 0);
  assert.equal(unknown.unknownConditionCount, 1);
  assert.equal(unknown.partial, true);
  // The known ROE failure already determines exclusion; missing profit is not counted again.
  const rejected = await runValueScreen(criteria({ ocfToProfitMin: 100, roeMin: 50 }), noQuotes, options);
  assert.equal(rejected.unknownConditionCount, 0);
  assert.equal(rejected.partial, false);
  const inactive = await runValueScreen(criteria({}), async symbols => symbols.map(symbol => quote(symbol)), options);
  assert.equal(inactive.total, 1);
  assert.equal(inactive.unknownConditionCount, 0);
  assert.equal(inactive.partial, false);
});

test('positive-price quotes with missing PE/PB count unknown conditions unless another quote condition already fails', async () => {
  const single = universe.filter(row => row.code === '600519');
  const options = { universe: single, now, reports: async () => reports };
  for (const [field, filter] of [['pe', 'peMax'], ['pb', 'pbMax']]) {
    const unknown = await runValueScreen(criteria({ [filter]: 20 }), async symbols => symbols.map(symbol => quote(symbol, { [field]: null })), options);
    assert.equal(unknown.quoteCount, 1);
    assert.equal(unknown.financialCount, 1);
    assert.equal(unknown.total, 0);
    assert.equal(unknown.unknownConditionCount, 1);
    assert.equal(unknown.partial, true);
  }
  const rejected = await runValueScreen(criteria({ peMax: 10, pbMax: 2 }), async symbols => symbols.map(symbol => quote(symbol, { pe: 100, pb: null })), options);
  assert.equal(rejected.total, 0);
  assert.equal(rejected.unknownConditionCount, 0);
  assert.equal(rejected.partial, false);
});

test('multiple missing active conditions count a company once rather than counting missing fields', async () => {
  const result = await runValueScreen(criteria({ ocfToProfitMin: 100, debtRatioMax: 50 }), async () => [], {
    universe: universe.filter(row => row.code === '600519'), now,
    reports: async () => ({ main: [financial('600519', { ZCFZL: null })], income: [] }),
  });
  assert.equal(result.unknownConditionCount, 1);
  assert.equal(result.partial, true);
});

test('all matching rows beyond 300 return, with stable order and at most four 50-symbol quote batches', async () => {
  const large = valueScreenUniverse([{ name: '测试行业', stocks: Array.from({ length: 307 }, (_, index) => String(600000 + index)) }]);
  let running = 0, maxRunning = 0, batches = 0;
  const result = await runValueScreen(criteria({}), async symbols => {
    assert.ok(symbols.length <= 50);
    running++; batches++; maxRunning = Math.max(maxRunning, running);
    await new Promise(resolve => setTimeout(resolve, 2));
    running--;
    return symbols.slice().reverse().map(symbol => quote(symbol));
  }, { universe: large, now, reports: async () => ({ main: [], income: [] }) });
  assert.equal(result.total, 307);
  assert.equal(result.rows.length, 307);
  assert.equal(result.quoteCount, 307);
  assert.equal(batches, 7);
  assert.equal(maxRunning, 4);
  assert.deepEqual(result.rows.map(row => row.code), large.map(row => row.code));
});

test('a failed quote batch keeps other results and explicitly reports partial coverage', async () => {
  const large = valueScreenUniverse([{ name: '测试行业', stocks: Array.from({ length: 60 }, (_, index) => String(600000 + index)) }]);
  const result = await runValueScreen(criteria({}), async symbols => {
    if (symbols.length === 50) throw Error('upstream unavailable');
    return symbols.map(symbol => quote(symbol, { stale: true }));
  }, { universe: large, now, reports: async () => ({ main: [], income: [] }) });
  assert.equal(result.total, 60);
  assert.equal(result.quoteCount, 10);
  assert.equal(result.partial, true);
});

test('report queries fetch every stable page, with exact annual/disclosure filters and explicit columns', async () => {
  const all = Array.from({ length: 501 }, (_, index) => financial(String(600000 + index)));
  const calls = [];
  const rows = await fetchValueScreenReportPages('RPT_F10_FINANCE_MAINFINADATA', 'SECURITY_CODE,ROEJQ', [period], today, async url => {
    const p = new URL(url).searchParams;
    calls.push(p);
    const page = Number(p.get('pageNumber'));
    return { success: true, result: { pages: 2, count: 501, data: all.slice((page - 1) * 500, page * 500) } };
  });
  assert.equal(rows.length, 501);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].get('filter'), "(REPORT_DATE in ('2025-12-31'))(NOTICE_DATE<='2026-10-19 23:59:59')");
  assert.equal(calls[0].get('sortColumns'), 'SECURITY_CODE,REPORT_DATE,UPDATE_DATE,NOTICE_DATE,CURRENCY');
  assert.equal(calls[0].get('sortTypes'), '1,-1,-1,-1,1');
  assert.equal(calls[0].get('columns'), 'SECURITY_CODE,ROEJQ');
});

test('multi-period requests filter every requested date at once and accept no dates silently', async () => {
  const calls = [];
  const fetcher = async url => { calls.push(new URL(url).searchParams); return { success: true, result: { pages: 1, count: 1, data: [financial('600519')] } }; };
  await fetchValueScreenReportPages('TEST', 'ALL', ['2026-09-30', '2026-06-30', '2026-03-31', period, '2025-09-30', '2025-06-30', '2025-03-31', '2024-12-31'], today, fetcher);
  assert.equal(calls[0].get('filter'), "(REPORT_DATE in ('2026-09-30','2026-06-30','2026-03-31','2025-12-31','2025-09-30','2025-06-30','2025-03-31','2024-12-31'))(NOTICE_DATE<='2026-10-19 23:59:59')");
  assert.deepEqual(await fetchValueScreenReportPages('TEST', 'ALL', [], today, fetcher), []);
  assert.equal(calls.length, 1, 'an empty date list must not reach the network');
});

test('incomplete, repeated or changing report pages fail instead of silently returning a truncated screen', async () => {
  for (const kind of ['missing', 'repeated', 'changed']) {
    const page = financial('600519');
    await assert.rejects(fetchValueScreenReportPages('TEST', 'ALL', [period], today, async url => {
      const first = new URL(url).searchParams.get('pageNumber') === '1';
      return { success: true, result: { pages: 2, count: kind === 'changed' && !first ? 3 : 2,
        data: first || kind === 'repeated' ? [page] : [] } };
    }), /分页|变化/);
  }
});

test('only raw reports cache; scans use new quotes and final PE values each time', async () => {
  clearCache();
  const nativeFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    const name = new URL(url).searchParams.get('reportName');
    return new Response(JSON.stringify({ success: true, result: { pages: 1, count: 1,
      data: name.includes('MAINFINADATA') ? reports.main : reports.income } }), { status: 200 });
  };
  try {
    let pe = 10;
    const fetchQuotes = async symbols => symbols.map(symbol => quote(symbol, { pe }));
    const options = { universe: universe.filter(row => row.code === '600519'), now };
    const first = await runValueScreen(criteria({}), fetchQuotes, options);
    pe = 20;
    const second = await runValueScreen(criteria({}), fetchQuotes, options);
    assert.equal(first.rows[0].pe, 10);
    assert.equal(second.rows[0].pe, 20);
    assert.equal(calls, 2, 'MAIN and GINCOME load once each, without caching the final screen');
    assert.equal((await fetchValueScreenReports([period], today, ['600519'])).main.length, 1);
    assert.equal(calls, 2);
    // A different date set is a different cache entry, never a hit on the single-date one.
    await fetchValueScreenReports([period, '2024-12-31'], today, ['600519']);
    assert.equal(calls, 4);
    await fetchValueScreenReports(['2024-12-31', period], today, ['600519']);
    assert.equal(calls, 4, 'date order must not split the cache entry');
    await fetchValueScreenReports([period], today, ['600519']);
    assert.equal(calls, 4);
  } finally { globalThis.fetch = nativeFetch; clearCache(); }
});

test('screen route exposes metadata and validates POST while refusing legacy derived-ROE GET scans', async () => {
  const source = fs.readFileSync('src/app/api/screen/route.ts', 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {}, calls = [];
  vm.runInNewContext(compiled, { exports, require(name) {
    if (name === '@/lib/api') return { ok: data => ({ status: 200, data }), fail: (error, status) => ({ status, error }), sp: request => new URL(request.url).searchParams };
    if (name === '@/lib/datasource') return { getScreenMeta: () => getValueScreenMeta(now), screen: async c => { calls.push(c); return { rows: [] }; } };
    if (name === '@/lib/valueScreen') return { readValueScreenCriteria: (raw, industries) => readValueScreenCriteria(raw, industries, now) };
    throw Error(name);
  } });
  assert.equal((await exports.GET({ url: 'http://localhost/api/screen?meta=1' })).data.industries.length, 31);
  assert.equal((await exports.GET({ url: 'http://localhost/api/screen?roeMin=15' })).status, 400);
  assert.equal((await exports.POST({ json: async () => criteria({ scope: 'watchlist', codes: [] }) })).status, 200);
  assert.deepEqual(calls[0].codes, []);
  assert.equal((await exports.POST({ json: async () => criteria({ roeMin: '15' }) })).status, 400);
  assert.equal((await exports.POST({ json: async () => { throw Error('bad JSON'); } })).status, 400);
  assert.equal(calls.length, 1);
});

test('scope excludes ST and loss independently and cash ratio never mixes periods', () => {
 const row = { ...emptyValueScreenRow(universe[0], period), name: '*ST测试', pe: -5 };
 assert.equal(matchesValueScreenQuote(row, criteria({ excludeST: true })), false);
 assert.equal(matchesValueScreenQuote(row, criteria({ excludeLoss: true })), false);
 assert.equal(matchesValueScreenQuote({ ...row, name: '正常公司', pe: 8 }, criteria({ excludeST: true, excludeLoss: true })), true);
 const parsed = parseValueScreenFinancials({ main: [financial('600519')], income: [income('600519', { REPORT_DATE: '2024-12-31' })] }, [period, '2024-12-31'], today);
 assert.equal(parsed.get('600519').ocfToProfit, null);
});

test('report loading receives the intersection of industry and watchlist before financial filtering', async () => {
  let requested;
  const result = await runValueScreen(criteria({
    period: 'auto', scope: 'watchlist', codes: ['600519', '000001'], industries: ['银行'],
  }), async symbols => symbols.map(symbol => quote(symbol)), {
    universe, now,
    reports: async (periods, date, codes) => {
      requested = { periods, date, codes };
      return { main: [financial('000001')], income: [income('000001')] };
    },
  });
  assert.deepEqual(requested.codes, ['000001']);
  assert.equal(requested.date, today);
  assert.ok(requested.periods.includes(period), 'older reports still participate in fallback');
  assert.deepEqual(result.rows.map(row => row.code), ['000001']);
  assert.equal(result.rows[0].period, period);
  assert.equal(result.fallbackCount, 1);
});

test('scoped report pagination keeps the code restriction on every page and rejects ignored scopes', async () => {
  const calls = [];
  const codes = ['000001', '600519'];
  const rows = await fetchValueScreenReportPages('TEST', 'ALL', [period], today, async url => {
    const params = new URL(url).searchParams;
    calls.push(params.get('filter'));
    const code = codes[Number(params.get('pageNumber')) - 1];
    return { success: true, result: { pages: 2, count: 2, data: [financial(code)] } };
  }, codes);
  assert.equal(rows.length, 2);
  assert.deepEqual(calls, Array(2).fill(`(SECURITY_CODE in ("000001","600519"))(REPORT_DATE in ('${period}'))(NOTICE_DATE<='${today} 23:59:59')`));
  await assert.rejects(fetchValueScreenReportPages('TEST', 'ALL', [period], today, async () => ({
    success: true, result: { pages: 1, count: 1, data: [financial('600519')] },
  }), ['000001']), /范围之外/);
  const unreachable = async () => { throw Error('must not call network'); };
  assert.deepEqual(await fetchValueScreenReportPages('TEST', 'ALL', [period], today, unreachable, []), []);
  await assert.rejects(fetchValueScreenReportPages('TEST', 'ALL', [period], today, unreachable, ['000001")']), /范围无效/);
});

test('scoped report caches stay isolated and normalize code order while quotes remain fresh', async () => {
  clearCache();
  const nativeFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async url => {
    const params = new URL(url).searchParams;
    const codeList = /SECURITY_CODE in \(([^)]+)\)/.exec(params.get('filter'))?.[1];
    assert.ok(codeList, 'a narrow scan must never issue an all-market request');
    const codes = [...codeList.matchAll(/"(\d{6})"/g)].map(match => match[1]);
    requests.push(codes);
    const rows = codes.map(code => params.get('reportName').includes('MAINFINADATA') ? financial(code) : income(code));
    return new Response(JSON.stringify({ success: true, result: { pages: 1, count: rows.length, data: rows } }));
  };
  try {
    const quotes = async symbols => symbols.map(symbol => quote(symbol));
    const bank = await runValueScreen(criteria({ industries: ['银行'] }), quotes, { universe, now });
    assert.deepEqual(bank.rows.map(row => row.code), ['000001']);
    assert.equal(requests.length, 2);
    const food = await runValueScreen(criteria({ industries: ['食品饮料'] }), quotes, { universe, now });
    assert.deepEqual(food.rows.map(row => row.code), ['600415', '600519']);
    assert.equal(requests.length, 4, 'another industry must get its own reports');
    await fetchValueScreenReports([period], today, ['600519', '600415', '600519']);
    assert.equal(requests.length, 4, 'reordering or repeating codes must reuse the same cache');
    await fetchValueScreenReports([period], today, []);
    assert.equal(requests.length, 4, 'an empty scope must not fall back to all shares');
  } finally { globalThis.fetch = nativeFetch; clearCache(); }
});

test('large code scopes use bounded batches without dropping companies or mixing cached scopes', async () => {
  clearCache();
  const nativeFetch = globalThis.fetch;
  const codes = Array.from({ length: 401 }, (_, i) => String(600000 + i));
  let active = 0, maxActive = 0;
  const requests = [];
  globalThis.fetch = async url => {
    const params = new URL(url).searchParams;
    const filter = params.get('filter');
    const scope = [.../SECURITY_CODE in \(([^)]+)\)/.exec(filter)[1].matchAll(/"(\d{6})"/g)].map(match => match[1]);
    assert.ok(scope.length <= 200);
    assert.ok(filter.includes(`'${period}'`) && filter.includes("'2024-12-31'"));
    requests.push(scope);
    maxActive = Math.max(maxActive, ++active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    const rows = scope.map(code => params.get('reportName').includes('MAINFINADATA') ? financial(code) : income(code));
    return new Response(JSON.stringify({ success: true, result: { pages: 1, count: rows.length, data: rows } }));
  };
  try {
    const result = await fetchValueScreenReports([period, '2024-12-31'], today, codes);
    assert.deepEqual(result.main.map(row => row.SECURITY_CODE), codes);
    assert.deepEqual(result.income.map(row => row.SECURITY_CODE), codes);
    assert.equal(requests.length, 6, 'three code batches, each fetching two report types');
    assert.ok(maxActive <= 4, 'no more than two batches load their first MAIN/INCOME pages concurrently');
    await fetchValueScreenReports(['2024-12-31', period], today, [...codes].reverse());
    assert.equal(requests.length, 6);
  } finally { globalThis.fetch = nativeFetch; clearCache(); }
});

test('an unrestricted directory scan retains the bulk loader instead of issuing per-code batches', async () => {
  let requestedCodes = 'not called';
  const result = await runValueScreen(criteria({ roeMin: 20 }), async () => {
    throw Error('missing financials must not request quotes');
  }, {
    now,
    reports: async (_periods, _today, codes) => {
      requestedCodes = codes;
      return { main: [], income: [] };
    },
  });
  assert.equal(requestedCodes, undefined);
  assert.equal(result.universeCount, getValueScreenMeta(now).universeCount);
  assert.equal(result.total, 0);
});
