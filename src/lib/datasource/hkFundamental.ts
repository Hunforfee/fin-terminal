import { fetchJson, UpstreamError } from './http';
import { hkPerShareValues } from './hkCurrency';
import { sumFiscalYearDividend, type HkDividendRecord } from './hkDividends';
export {
  parseHkDps,
  parseHkDividends,
  fetchHkDividends,
  sumTtmDividend,
  sumFiscalYearDividend,
  sumRollingTtmDividend,
  type HkDividendRecord,
} from './hkDividends';

/** A current F10 snapshot with the book value normalized to the HKD quote. */
export interface HkFundamental {
  reportDate: string;
  reportType: string;
  /** Latest book value per share in HKD; invalid/missing latest values stay null. */
  bps: number | null;
  totalMarketCap: number | null;
  /** Same-snapshot trading price, derived from total market cap / ordinary shares. */
  referencePrice?: number | null;
  /** Provider TTM earnings basis, not price divided by its separate EPS_TTM field. */
  peTTM?: number | null;
  financialCurrency?: 'CNY';
  quoteCurrency?: string;
  rawBps?: number | null;
  hkdPerCny?: number | null;
}

export interface HkValuation {
  pe: number | null;
  pb: number | null;
  /** The exact normalized book value underlying this current snapshot. */
  bookValuePerShareHkd: number | null;
  /** Completed fiscal year's cash dividends / current HKD price (%). */
  dividendYield: number | null;
  /** Legacy property name: this is fiscal-year DPS, not rolling-twelve-month DPS. */
  ttmDps: number | null;
  ordinaryDps: number | null;
  specialDps: number | null;
  fiscalYear: string | null;
  batches: number;
  reportDate: string | null;
  reportType: string | null;
}

type Row = Record<string, unknown>;
type Response = {
  success: boolean;
  result?: { pages: number; data: Row[] } | null;
};
const positive = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean')
    return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const dateOnly = (v: unknown): string => {
  const s = typeof v === 'string' ? v.slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
};
const HK_HEADERS = { Referer: 'https://emweb.securities.eastmoney.com/' };

export function parseHkFundamental(rows: Row[]): HkFundamental | null {
  const latest = [...rows]
    .filter((row) => dateOnly(row.REPORT_DATE))
    .sort((a, b) =>
      dateOnly(b.REPORT_DATE).localeCompare(dateOnly(a.REPORT_DATE)),
    )[0];
  if (!latest) return null;
  const normalized = hkPerShareValues(latest);
  return {
    reportDate: dateOnly(latest.REPORT_DATE),
    reportType:
      typeof latest.REPORT_TYPE === 'string' ? latest.REPORT_TYPE : '',
    bps: normalized.bpsHkd,
    totalMarketCap: positive(latest.TOTAL_MARKET_CAP),
    referencePrice: normalized.referencePrice,
    peTTM: normalized.referencePeTTM,
    financialCurrency: normalized.financialCurrency,
    quoteCurrency: normalized.quoteCurrency,
    rawBps: normalized.bpsCny,
    hkdPerCny: normalized.hkdPerCny,
  };
}

/** Latest main indicators. CURRENCY=HKD labels the quote, not its CNY BPS. */
export async function fetchHkFundamental(
  code: string,
): Promise<HkFundamental | null> {
  if (!/^\d{5}$/.test(code)) throw new Error('港股代码无效');
  const url = new URL(
    'https://datacenter.eastmoney.com/securities/api/data/v1/get',
  );
  url.search = new URLSearchParams({
    reportName: 'RPT_HKF10_FN_MAININDICATOR',
    columns: 'ALL',
    filter: `(SECURITY_CODE="${code}")`,
    pageSize: '6',
    sortColumns: 'REPORT_DATE',
    sortTypes: '-1',
  }).toString();
  const data = await fetchJson<Response>(url.toString(), {
    timeoutMs: 15000,
    headers: HK_HEADERS,
  });
  if (!data.success || !data.result || !Array.isArray(data.result.data))
    throw new UpstreamError('港股财务指标不可用', url.toString(), 'parse');
  return parseHkFundamental(data.result.data);
}

/** All current valuation consumers share this calculation; only raw inputs cache. */
export function computeHkValuation(
  f: HkFundamental | null,
  dividends: HkDividendRecord[] | null,
  price: number | null,
  asOf?: string | Date,
): HkValuation {
  const p = positive(price);
  const pb = f?.bps != null && f.bps > 0 && p !== null ? p / f.bps : null;
  const ref = positive(f?.referencePrice),
    providerPe = positive(f?.peTTM);
  const pe =
    p !== null && ref !== null && providerPe !== null
      ? (providerPe * p) / ref
      : null;
  const fiscal =
    dividends !== null ? sumFiscalYearDividend(dividends, asOf) : null;
  const dy =
    fiscal?.ttmDps != null && p !== null ? (fiscal.ttmDps / p) * 100 : null;
  const valid = (n: number | null) =>
    n !== null && Number.isFinite(n) && n > 0 ? n : null;
  const round = (n: number | null, digits: number) =>
    n !== null && Number.isFinite(n)
      ? Math.round(n * 10 ** digits) / 10 ** digits
      : null;
  return {
    pe: round(valid(pe), 3),
    pb: round(valid(pb), 3),
    bookValuePerShareHkd: f?.bps ?? null,
    dividendYield: round(dy, 2),
    ttmDps: fiscal?.ttmDps ?? null,
    ordinaryDps: fiscal?.ordinaryDps ?? null,
    specialDps: fiscal?.specialDps ?? null,
    fiscalYear: fiscal?.fiscalYear ?? null,
    batches: fiscal?.batches ?? 0,
    reportDate: f?.reportDate ?? null,
    reportType: f?.reportType ?? null,
  };
}
