import { SW2021 } from '../sw2021';
import {
  emptyValueScreenRow, valueScreenFinancialStatus, valueScreenQuoteStatus,
  selectValueScreenUniverse, valueScreenPeriods, valueScreenToday, valueScreenUniverse,
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
    industries: SW2021.industries.map(industry => ({
      name: industry.name,
      count: universe.filter(candidate => candidate.industry === industry.name).length,
    })),
    universeCount: universe.length,
    defaultPeriod: periods[0],
  };
}

/** Stable code ordering and verified page counts prevent silent first-page truncation. */
export async function fetchValueScreenReportPages(
  reportName: string,
  columns: string,
  period: string,
  today: string,
  fetcher: JsonFetcher = url => fetchJson<DataPage>(url, {
    timeoutMs: 15000, headers: { Referer: 'https://data.eastmoney.com/' },
  }),
): Promise<RawRow[]> {
  const read = async (page: number) => {
    const params = new URLSearchParams({
      reportName, columns,
      filter: `(REPORT_DATE='${period}')(NOTICE_DATE<='${today} 23:59:59')`,
      sortColumns: 'SECURITY_CODE,UPDATE_DATE', sortTypes: '1,-1',
      pageNumber: String(page), pageSize: String(PAGE_SIZE),
    });
    const response = await fetcher(`${DC_URL}?${params}`);
    const result = response.result;
    if (!response.success || !result || !Array.isArray(result.data))
      throw Error('年报数据暂不可用，请稍后重试');
    const pages = Number(result.pages), count = Number(result.count);
    if (!Number.isInteger(pages) || pages < 0 || pages > 100 ||
      !Number.isInteger(count) || count < 0 ||
      (count > 0 && pages < 1) || (count === 0 && result.data.length > 0))
      throw Error('年报分页信息不完整，请稍后重试');
    return { rows: result.data, pages, count };
  };
  const first = await read(1);
  const remaining = await mapLimit(Array.from({ length: Math.max(0, first.pages - 1) }, (_, index) => index + 2), 4, read);
  if (remaining.some(page => page.pages !== first.pages || page.count !== first.count))
    throw Error('年报分页数据发生变化，请重新筛选');
  const rows = [first, ...remaining].flatMap(page => page.rows);
  if (rows.length !== first.count) throw Error('年报数据分页不完整，请重新筛选');
  const identities = new Set(rows.map(row => `${row.SECURITY_CODE}|${row.REPORT_DATE}|${row.UPDATE_DATE}|${row.NOTICE_DATE}`));
  if (identities.size !== rows.length) throw Error('年报分页出现重复记录，请重新筛选');
  return rows;
}

/** Cache only raw reports. Prices and final valuation/filter results never use this TTL. */
export async function fetchValueScreenReports(period: string, today: string): Promise<ValueScreenReports> {
  return cached(`value-screen-reports-v1:${period}:${today}`, 3600e3, async () => {
    const [main, income] = await Promise.all([
      fetchValueScreenReportPages('RPT_F10_FINANCE_MAINFINADATA', MAIN_COLUMNS, period, today),
      fetchValueScreenReportPages('RPT_F10_FINANCE_GINCOME', INCOME_COLUMNS, period, today),
    ]);
    return { main, income };
  });
}

function validReport(row: RawRow, period: string, today: string): boolean {
  const notice = dateOnly(row.NOTICE_DATE);
  const update = dateOnly(row.UPDATE_DATE);
  return /^\d{6}$/.test(String(row.SECURITY_CODE ?? '')) &&
    dateOnly(row.REPORT_DATE) === period && notice !== null && notice <= today &&
    (!update || update <= today) && row.CURRENCY === 'CNY';
}

function latestReports(rows: RawRow[], period: string, today: string): Map<string, RawRow> {
  const result = new Map<string, RawRow>();
  for (const row of rows) {
    if (!validReport(row, period, today)) continue;
    const code = String(row.SECURITY_CODE), current = result.get(code);
    const version = `${row.UPDATE_DATE ?? ''}|${row.NOTICE_DATE ?? ''}`;
    const previous = current ? `${current.UPDATE_DATE ?? ''}|${current.NOTICE_DATE ?? ''}` : '';
    if (!current || version > previous) result.set(code, row);
  }
  return result;
}

/** ROEJQ is disclosed weighted ROE; no PB/PE substitute is used anywhere here. */
export function parseValueScreenFinancials(reports: ValueScreenReports, period: string, today: string): Map<string, ValueScreenFinancial> {
  const main = latestReports(reports.main, period, today);
  const income = latestReports(reports.income, period, today);
  return new Map([...main].map(([code, row]) => {
    const cashFlow = finite(row.NETCASH_OPERATE_PK);
    // MAINFINADATA contains attributable profit only. GINCOME.NETPROFIT is total
    // consolidated after-tax profit, unlike PARENT_NETPROFIT or pretax TOTAL_PROFIT.
    const totalNetProfit = finite(income.get(code)?.NETPROFIT);
    const cashToProfit = cashFlow !== null && totalNetProfit !== null && totalNetProfit > 0
      ? cashFlow / totalNetProfit * 100 : null;
    return [code, {
      code, name: typeof row.SECURITY_NAME_ABBR === 'string' ? row.SECURITY_NAME_ABBR : code,
      period, noticeDate: dateOnly(row.NOTICE_DATE),
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
  reports?: (period: string, today: string) => Promise<ValueScreenReports>;
}

/** Financial conditions run first; at most four 50-symbol quote batches run together. */
export async function runValueScreen(
  criteria: ValueScreenCriteria,
  getQuotes: QuoteFetcher,
  options: ValueScreenOptions = {},
): Promise<ValueScreenResult> {
  const now = options.now ?? new Date();
  const candidates = selectValueScreenUniverse(options.universe ?? universe, criteria);
  const empty: ValueScreenResult = {
    rows: [], total: 0, universeCount: candidates.length, financialCount: 0,
    quoteCount: 0, scannedCount: 0, unknownConditionCount: 0, period: criteria.period,
    updatedAt: now.toISOString(), partial: false,
  };
  if (candidates.length === 0) return empty;
  const reports = await (options.reports ?? fetchValueScreenReports)(criteria.period, valueScreenToday(now));
  const financials = parseValueScreenFinancials(reports, criteria.period, valueScreenToday(now));
  const all = candidates.map(candidate => {
    const financial = financials.get(candidate.code);
    return { ...emptyValueScreenRow(candidate, criteria.period), ...financial, financialAvailable: !!financial };
  });
  const financialCount = all.filter(row => row.financialAvailable).length;
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
    unknownConditionCount,
    partial: unknownConditionCount > 0 || financialCount < candidates.length || quoteCount < scanned.length || failedQuoteBatch || stale,
  };
}
