import { storedScreenFinancials } from '../screenFinancialStorage';
import { getMarketStore } from '../marketStore';
import { SW2021 } from '../sw2021';
import {
  emptyValueScreenRow, valueScreenFinancialStatus, valueScreenQuoteStatus,
  selectValueScreenUniverse, valueScreenFallbackPeriods, valueScreenPeriods,
  valueScreenRequestedPeriods, valueScreenToday, valueScreenUniverse,
  type ValueScreenCandidate, type ValueScreenCriteria, type ValueScreenFinancial,
  type ValueScreenMeta, type ValueScreenResult, type ValueScreenRow,
} from '../valueScreen';
import { cached } from './cache';
import { fetchJson } from './http';
import type { Quote } from './types';

type RawRow = Record<string, unknown>;
interface DataPage {
  success?: boolean;
  message?: string;
  result?: { data?: RawRow[]; pages?: number; count?: number } | null;
}
export interface ValueScreenReports { main: RawRow[]; income: RawRow[] }
type JsonFetcher = (url: string) => Promise<DataPage>;
type QuoteFetcher = (symbols: string[]) => Promise<Quote[]>;

const DC_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const PAGE_SIZE = 500;
/** Observed full-market pages per annual report date; ceiling keeps truncation detectable. */
const PAGE_CEILING_PER_PERIOD = 120;
/** Multi-period requests get more parallelism because each run fetches ~3x the pages. */
const PAGE_CONCURRENCY = 8;
/** Bound URL length and avoid replacing one full-market request with thousands of calls. */
const REPORT_CODE_BATCH = 200;
const REPORT_BATCH_CONCURRENCY = 2;
const MAIN_COLUMNS = [
  'SECURITY_CODE', 'SECURITY_NAME_ABBR', 'REPORT_DATE', 'NOTICE_DATE', 'UPDATE_DATE',
  'CURRENCY', 'ROEJQ', 'XSJLL', 'TOTALOPERATEREVETZ', 'PARENTNETPROFITTZ',
  'KCFJCXSYJLRTZ', 'ZCFZL', 'NETCASH_OPERATE_PK', 'MGJYXJJE', 'KCFJCXSYJLR',
].join(',');
const INCOME_COLUMNS = 'SECURITY_CODE,REPORT_DATE,NOTICE_DATE,UPDATE_DATE,CURRENCY,NETPROFIT';
const universe = valueScreenUniverse(SW2021.industries);

const finite = (value: unknown): number | null => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const dateOnly = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
};
const yi = (value: unknown) => {
  const amount = finite(value);
  return amount === null ? null : amount / 1e8;
};

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
    while (index < items.length) {
      const current = index++;
      result[current] = await fn(items[current]);
    }
  }));
  return result;
}

/** Classification membership is a bundled snapshot, not a live listing register. */
export function getValueScreenMeta(now = new Date()): ValueScreenMeta {
  const periods = valueScreenPeriods(now);
  return {
    periods,
    fallbackPeriods: valueScreenFallbackPeriods(periods),
    industries: SW2021.industries.map(industry => ({
      name: industry.name,
      count: universe.filter(candidate => candidate.industry === industry.name).length,
    })),
    universeCount: universe.length,
    defaultPeriod: 'auto',
  };
}

/** Stable code ordering and verified page counts prevent silent first-page truncation. */
export async function fetchValueScreenReportPages(
  reportName: string,
  columns: string,
  periods: string[],
  today: string,
  fetcher: JsonFetcher = url => fetchJson<DataPage>(url, {
    timeoutMs: 15000, headers: { Referer: 'https://data.eastmoney.com/' },
  }),
  codes?: string[],
): Promise<RawRow[]> {
  if (periods.length === 0 || codes?.length === 0) return [];
  if (codes?.some(code => !/^\d{6}$/.test(code))) throw Error('财报股票范围无效');
  const selectedCodes = codes ? new Set(codes) : null;
  const codeFilter = selectedCodes
    ? `(SECURITY_CODE in (${[...selectedCodes].map(code => `"${code}"`).join(',')}))` : '';
  const inList = periods.map(period => `'${period}'`).join(',');
  // Each report date adds roughly 30 pages of full-market rows, so the sanity
  // ceiling has to scale with the requested dates instead of a fixed 100.
  const pageCeiling = periods.length * PAGE_CEILING_PER_PERIOD;
  const read = async (page: number) => {
    const params = new URLSearchParams({
      reportName, columns,
      filter: `${codeFilter}(REPORT_DATE in (${inList}))(NOTICE_DATE<='${today} 23:59:59')`,
      sortColumns: 'SECURITY_CODE,REPORT_DATE,UPDATE_DATE,NOTICE_DATE,CURRENCY', sortTypes: '1,-1,-1,-1,1',
      pageNumber: String(page), pageSize: String(PAGE_SIZE),
    });
    const response = await fetcher(`${DC_URL}?${params}`);
    const result = response.result;
    if (!response.success || !result || !Array.isArray(result.data))
      throw Error('财报数据暂不可用，请稍后重试');
    if (selectedCodes && result.data.some(row => !selectedCodes.has(String(row.SECURITY_CODE))))
      throw Error('财报接口返回范围之外的股票，请重试');
    const pages = Number(result.pages), count = Number(result.count);
    if (!Number.isInteger(pages) || pages < 0 || pages > pageCeiling ||
      !Number.isInteger(count) || count < 0 ||
      (count > 0 && pages < 1) || (count === 0 && result.data.length > 0))
      throw Error('财报分页信息不完整，请稍后重试');
    return { rows: result.data, pages, count };
  };
  const first = await read(1);
  const remaining = await mapLimit(Array.from({ length: Math.max(0, first.pages - 1) }, (_, index) => index + 2), PAGE_CONCURRENCY, read);
  if (remaining.some(page => page.pages !== first.pages || page.count !== first.count))
    throw Error('财报分页数据发生变化，请重新筛选');
  const rows = [first, ...remaining].flatMap(page => page.rows);
  if (rows.length !== first.count) throw Error('财报数据分页不完整，请重新筛选');
  const identities = new Set(rows.map(row => `${row.SECURITY_CODE}|${row.REPORT_DATE}|${row.UPDATE_DATE}|${row.NOTICE_DATE}`));
  if (identities.size !== rows.length) throw Error('财报分页出现重复记录，请重新筛选');
  return rows;
}

/** Cache only raw reports. Prices and final valuation/filter results never use this TTL. */
async function fetchFreshValueScreenReports(periods: string[], today: string, codes?: string[]): Promise<ValueScreenReports> {
  if (periods.length === 0 || codes?.length === 0) return { main: [], income: [] };
  if (codes?.some(code => !/^\d{6}$/.test(code))) throw Error('财报股票范围无效');
  const key = [...new Set(periods)].sort().join('~');
  const selected = codes ? [...new Set(codes)].sort() : undefined;
  const batches = selected
    ? Array.from({ length: Math.ceil(selected.length / REPORT_CODE_BATCH) }, (_, index) => selected.slice(index * REPORT_CODE_BATCH, (index + 1) * REPORT_CODE_BATCH))
    : [undefined];
  const results = await mapLimit(batches, REPORT_BATCH_CONCURRENCY, batch =>
    cached(`value-screen-reports-v3:${key}:${today}:${batch ? batch.join(',') : 'all'}`, 300e3, async () => {
      const [main, income] = await Promise.all([
        fetchValueScreenReportPages('RPT_F10_FINANCE_MAINFINADATA', MAIN_COLUMNS, periods, today, undefined, batch),
        fetchValueScreenReportPages('RPT_F10_FINANCE_GINCOME', INCOME_COLUMNS, periods, today, undefined, batch),
      ]);
      return { main, income };
    }));
  return { main: results.flatMap(result => result.main), income: results.flatMap(result => result.income) };
}

export async function fetchValueScreenReports(periods: string[], today: string, codes?: string[]): Promise<ValueScreenReports> {
  const store = getMarketStore();
  if (!store) return fetchFreshValueScreenReports(periods, today, codes);
  const targets = codes ?? universe.map(row => row.code);
  return storedScreenFinancials(targets, periods, async missing => {
    const reports = await fetchFreshValueScreenReports(periods, today, !codes && missing.length === targets.length ? undefined : missing);
    const identities = new Set(missing), allowed = new Set(periods);
    const accept = (row: RawRow) => identities.has(String(row.SECURITY_CODE)) && validReport(row, allowed, today);
    return { main: reports.main.filter(accept), income: reports.income.filter(accept) };
  }, store);
}

function validReport(row: RawRow, allowedPeriods: Set<string>, today: string): boolean {
  const notice = dateOnly(row.NOTICE_DATE);
  const update = dateOnly(row.UPDATE_DATE);
  const report = dateOnly(row.REPORT_DATE);
  return /^\d{6}$/.test(String(row.SECURITY_CODE ?? '')) &&
    report !== null && allowedPeriods.has(report) && notice !== null && notice <= today &&
    (!update || update <= today) && row.CURRENCY === 'CNY';
}

/**
 * Two-level winner per code: the newest report date first, then the newest
 * disclosure version inside that date. `allowedPeriods` only bounds which dates
 * may compete; ordering comes from the date string, not list position.
 */
function latestReports(rows: RawRow[], allowedPeriods: Set<string>, today: string): Map<string, { row: RawRow; period: string }> {
  const result = new Map<string, { row: RawRow; period: string }>();
  const version = (row: RawRow) => `${row.UPDATE_DATE ?? ''}|${row.NOTICE_DATE ?? ''}`;
  for (const row of rows) {
    if (!validReport(row, allowedPeriods, today)) continue;
    const code = String(row.SECURITY_CODE), period = dateOnly(row.REPORT_DATE)!;
    const current = result.get(code);
    if (!current || period > current.period ||
      (period === current.period && version(row) > version(current.row)))
      result.set(code, { row, period });
  }
  return result;
}

/** ROEJQ is disclosed weighted ROE; no PB/PE substitute is used anywhere here. */
export function parseValueScreenFinancials(reports: ValueScreenReports, periods: string[], today: string): Map<string, ValueScreenFinancial> {
  const allowedPeriods = new Set(periods);
  const main = latestReports(reports.main, allowedPeriods, today);
  const income = latestReports(reports.income.filter(row => dateOnly(row.REPORT_DATE) === main.get(String(row.SECURITY_CODE))?.period), allowedPeriods, today);
  return new Map([...main].map(([code, entry]) => {
    const row = entry.row;
    const cashFlow = finite(row.NETCASH_OPERATE_PK);
    // MAINFINADATA contains attributable profit only. GINCOME.NETPROFIT is total
    // consolidated after-tax profit, unlike PARENTNETPROFIT or pretax TOTAL_PROFIT.
    // The income row may sit in an earlier period than main, so look it up by code.
    const totalNetProfit = finite(income.get(code)?.row.NETPROFIT);
    const cashToProfit = cashFlow !== null && totalNetProfit !== null && totalNetProfit > 0
      ? cashFlow / totalNetProfit * 100 : null;
    return [code, {
      code, name: typeof row.SECURITY_NAME_ABBR === 'string' ? row.SECURITY_NAME_ABBR : code,
      period: entry.period, noticeDate: dateOnly(row.NOTICE_DATE),
      roe: finite(row.ROEJQ), netMargin: finite(row.XSJLL),
      revenueGrowth: finite(row.TOTALOPERATEREVETZ), profitGrowth: finite(row.PARENTNETPROFITTZ),
      deductedGrowth: finite(row.KCFJCXSYJLRTZ), debtRatio: finite(row.ZCFZL),
      operatingCashFlow: yi(row.NETCASH_OPERATE_PK),
      ocfToProfit: cashToProfit !== null && Number.isFinite(cashToProfit) ? cashToProfit : null,
      ocfPerShare: finite(row.MGJYXJJE), deductedProfit: yi(row.KCFJCXSYJLR),
    }];
  }));
}

export interface ValueScreenOptions {
  now?: Date;
  universe?: ValueScreenCandidate[];
  periods?: string[];
  reports?: (periods: string[], today: string, codes?: string[]) => Promise<ValueScreenReports>;
}

/** Financial conditions run first; at most four 50-symbol quote batches run together. */
export async function runValueScreen(
  criteria: ValueScreenCriteria,
  getQuotes: QuoteFetcher,
  options: ValueScreenOptions = {},
): Promise<ValueScreenResult> {
  const now = options.now ?? new Date();
  const candidates = selectValueScreenUniverse(options.universe ?? universe, criteria);
  const periods = valueScreenRequestedPeriods(criteria, options.periods ?? valueScreenPeriods(now));
  const newestPeriod = periods[0] ?? criteria.period;
  const empty: ValueScreenResult = {
    rows: [], total: 0, universeCount: candidates.length, financialCount: 0,
    quoteCount: 0, scannedCount: 0, unknownConditionCount: 0, period: newestPeriod,
    requestedPeriod: criteria.period, fallbackCount: 0,
    updatedAt: now.toISOString(), partial: false,
  };
  if (candidates.length === 0) return empty;
  // Keep the bulk path for a genuinely unrestricted full-directory scan. Every
  // narrower industry/watchlist selection must constrain the upstream request.
  const codes = !options.universe && candidates.length === universe.length
    ? undefined : candidates.map(candidate => candidate.code);
  const reports = await (options.reports ?? fetchValueScreenReports)(periods, valueScreenToday(now), codes);
  const financials = parseValueScreenFinancials(reports, periods, valueScreenToday(now));
  const all = candidates.map(candidate => {
    const financial = financials.get(candidate.code);
    // `...financial` wins so a row carries the report date actually matched.
    return { ...emptyValueScreenRow(candidate, newestPeriod), ...financial, financialAvailable: !!financial };
  });
  const financialCount = all.filter(row => row.financialAvailable).length;
  const fallbackCount = all.filter(row => row.financialAvailable && row.period !== newestPeriod).length;
  let unknownConditionCount = 0;
  const scanned = all.filter(row => {
    const status = valueScreenFinancialStatus(row, criteria);
    if (status === 'unknown') unknownConditionCount++;
    return status === 'match';
  });
  const batches = Array.from({ length: Math.ceil(scanned.length / 50) }, (_, index) => scanned.slice(index * 50, index * 50 + 50));
  const quotes = new Map<string, Quote>();
  let failedQuoteBatch = false;
  await mapLimit(batches, 4, async batch => {
    try {
      const received = await getQuotes(batch.map(row => row.symbol));
      const requested = new Set(batch.map(row => row.symbol));
      for (const quote of received) {
        if (quote.kind === 'stock' && ['SH', 'SZ', 'BJ'].includes(quote.market) && requested.has(quote.symbol))
          quotes.set(quote.symbol, quote);
      }
    } catch { failedQuoteBatch = true; }
  });
  let quoteCount = 0, stale = false;
  const rows: ValueScreenRow[] = scanned.map(row => {
    const quote = quotes.get(row.symbol);
    const price = finite(quote?.price);
    const available = quote !== undefined && price !== null && price > 0;
    if (!available) return row;
    quoteCount++;
    stale ||= quote.stale;
    const cap = finite(quote.totalMarketCap);
    return {
      ...row, name: quote.name || row.name, price,
      pe: finite(quote.pe), pb: finite(quote.pb),
      totalMarketCap: cap !== null && cap > 0 ? cap : null,
      quoteAvailable: true, quoteTime: quote.ts,
    };
  }).filter(row => {
    const status = valueScreenQuoteStatus(row, criteria);
    if (status === 'unknown') unknownConditionCount++;
    return status === 'match';
  });
  return {
    ...empty, rows, total: rows.length, financialCount, quoteCount, scannedCount: scanned.length,
    unknownConditionCount, fallbackCount,
    partial: unknownConditionCount > 0 || financialCount < candidates.length || quoteCount < scanned.length || failedQuoteBatch || stale,
  };
}
