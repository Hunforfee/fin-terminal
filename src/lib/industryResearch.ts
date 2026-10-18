import { normalizeStockCode } from './datasource/codes';

export interface IndustryResearchRow {
  code: string;
  symbol?: string;
  name: string;
  price: number | null;
  changePct: number | null;
  pe: number | null;
  pb: number | null;
  totalMarketCap: number | null;
  turnoverRate: number | null;
  /** PB / positive PE * 100: an estimate, never a reported financial ROE. */
  roeEstimate?: number | null;
  quoteAvailable?: boolean;
  quoteTime?: string | null;
  stale?: boolean;
  l1?: string | null;
  l2?: string | null;
  l3?: string | null;
}

export type IndustrySortKey =
  | 'name'
  | 'code'
  | 'price'
  | 'pe'
  | 'pb'
  | 'roeEstimate'
  | 'totalMarketCap'
  | 'changePct'
  | 'turnoverRate';
export type IndustryProfitability =
  'all' | 'profitable' | 'loss-making' | 'missing-pe';
export interface IndustryFilters {
  query?: string;
  profitability?: IndustryProfitability;
  quotes?: 'all' | 'available' | 'missing';
}
export interface IndustryResearchSummary {
  totalCount: number;
  quotedCount: number;
  missingQuoteCount: number;
  staleQuoteCount: number;
  positivePeMedian: number | null;
  positivePeCount: number;
  /** Finite nonzero PE values; PE=0 cannot identify a profit or a loss. */
  peAvailableCount: number;
  lossCount: number;
  /** Negative PE / (positive PE + negative PE), percent; unknown PE excluded. */
  lossSharePct: number | null;
  positivePbMedian: number | null;
  positivePbCount: number;
  pbAvailableCount: number;
  estimatedRoeMedian: number | null;
  estimatedRoeCount: number;
  /** Sum of available positive market caps, in the input unit (A shares: CNY yi). */
  totalMarketCap: number | null;
  marketCapCount: number;
  /** Available market-cap sample only; disclose marketCapCount with these metrics. */
  top5MarketCapSharePct: number | null;
  /** Herfindahl-Hirschman concentration index, 0-10000, on available market caps. */
  marketCapHhi: number | null;
  upCount: number;
  downCount: number;
  flatCount: number;
  changeAvailableCount: number;
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const positive = (value: unknown): value is number =>
  finite(value) && value > 0;
const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** The bundled classification also contains B shares; this page is an A-share universe. */
export function industryStockSymbol(code: string): string | null {
  if (!/^(?:[03648]\d{5}|92\d{4})$/.test(code)) return null;
  const stock = normalizeStockCode(code);
  return stock && stock.market !== 'HK' && stock.kind === 'stock'
    ? stock.symbol
    : null;
}

export function hasIndustryQuote(row: IndustryResearchRow): boolean {
  return row.quoteAvailable !== false && positive(row.price);
}

function uniqueRows<T extends IndustryResearchRow>(rows: T[]): T[] {
  const byCode = new Map<string, T>();
  for (const row of rows) {
    const key = (
      row.symbol ??
      industryStockSymbol(row.code) ??
      row.code
    ).toLowerCase();
    const previous = byCode.get(key);
    if (!previous || (!hasIndustryQuote(previous) && hasIndustryQuote(row)))
      byCode.set(key, row);
  }
  return [...byCode.values()];
}

/** Summaries describe the whole supplied industry, independent of table search/sort. */
export function summarizeIndustry(
  rows: IndustryResearchRow[],
  expectedCount?: number,
): IndustryResearchSummary {
  const members = uniqueRows(rows);
  const expected =
    Number.isSafeInteger(expectedCount) && expectedCount! >= 0
      ? expectedCount!
      : 0;
  const totalCount = Math.max(members.length, expected);
  const quoted = members.filter(hasIndustryQuote);
  const positivePe = quoted.map((row) => row.pe).filter(positive);
  const pe = quoted
    .map((row) => row.pe)
    .filter((value) => finite(value) && value !== 0) as number[];
  const positivePb = quoted.map((row) => row.pb).filter(positive);
  const pb = quoted
    .map((row) => row.pb)
    .filter((value) => finite(value) && value !== 0) as number[];
  const lossCount = pe.filter((value) => value < 0).length;
  const roe = quoted.map((row) => row.roeEstimate).filter(finite);
  const caps = quoted
    .map((row) => row.totalMarketCap)
    .filter(positive)
    .sort((a, b) => b - a);
  const cap = caps.length ? caps.reduce((sum, value) => sum + value, 0) : null;
  const changes = quoted.map((row) => row.changePct).filter(finite);
  return {
    totalCount,
    quotedCount: quoted.length,
    missingQuoteCount: totalCount - quoted.length,
    staleQuoteCount: quoted.filter((row) => row.stale === true).length,
    positivePeMedian: median(positivePe),
    positivePeCount: positivePe.length,
    peAvailableCount: pe.length,
    lossCount,
    lossSharePct: pe.length ? (lossCount / pe.length) * 100 : null,
    positivePbMedian: median(positivePb),
    positivePbCount: positivePb.length,
    pbAvailableCount: pb.length,
    estimatedRoeMedian: median(roe),
    estimatedRoeCount: roe.length,
    totalMarketCap: cap,
    marketCapCount: caps.length,
    top5MarketCapSharePct:
      cap !== null
        ? (caps.slice(0, 5).reduce((sum, value) => sum + value, 0) / cap) * 100
        : null,
    marketCapHhi:
      cap !== null
        ? caps.reduce((sum, value) => sum + (value / cap) ** 2, 0) * 10000
        : null,
    upCount: changes.filter((value) => value > 0).length,
    downCount: changes.filter((value) => value < 0).length,
    flatCount: changes.filter((value) => value === 0).length,
    changeAvailableCount: changes.length,
  };
}

export function filterIndustryRows<T extends IndustryResearchRow>(
  rows: T[],
  options: IndustryFilters = {},
): T[] {
  const query = options.query?.trim().normalize('NFKC').toLowerCase() ?? '';
  return rows.filter((row) => {
    const quoted = hasIndustryQuote(row);
    if (
      (options.quotes === 'available' && !quoted) ||
      (options.quotes === 'missing' && quoted)
    )
      return false;
    if (
      options.profitability === 'profitable' &&
      (!quoted || !positive(row.pe))
    )
      return false;
    if (
      options.profitability === 'loss-making' &&
      (!quoted || !finite(row.pe) || row.pe >= 0)
    )
      return false;
    if (
      options.profitability === 'missing-pe' &&
      quoted &&
      finite(row.pe) &&
      row.pe !== 0
    )
      return false;
    return (
      !query ||
      [row.name, row.code, row.symbol, row.l1, row.l2, row.l3].some((value) =>
        value?.normalize('NFKC').toLowerCase().includes(query),
      )
    );
  });
}

export function sortIndustryRows<T extends IndustryResearchRow>(
  rows: T[],
  key: IndustrySortKey,
  direction: 'asc' | 'desc' = 'desc',
): T[] {
  return [...rows].sort((a, b) => {
    const left = a[key],
      right = b[key];
    const text = key === 'name' || key === 'code';
    const validLeft = text ? typeof left === 'string' && !!left : finite(left);
    const validRight = text
      ? typeof right === 'string' && !!right
      : finite(right);
    if (!validLeft || !validRight) return validLeft ? -1 : validRight ? 1 : 0;
    const compared = text
      ? String(left).localeCompare(String(right), 'zh-CN', { numeric: true })
      : (left as number) - (right as number);
    return direction === 'asc' ? compared : -compared;
  });
}

export interface IndustryComparisonRow {
  name: string;
  level: 1 | 2 | 3;
  /** Membership without this classification depth is not a synthetic industry link. */
  unclassified?: boolean;
  summary: IndustryResearchSummary;
}

/** Compare direct children from already loaded members; never fetch all industries. */
export function compareIndustryChildren(
  rows: IndustryResearchRow[],
  level: 1 | 2 | 3,
  children: { name: string; count?: number }[] = [],
): IndustryComparisonRow[] {
  const key = `l${level}` as 'l1' | 'l2' | 'l3';
  const grouped = new Map<string, IndustryResearchRow[]>();
  const unclassified: IndustryResearchRow[] = [];
  for (const row of uniqueRows(rows)) {
    const name = row[key];
    if (!name) {
      unclassified.push(row);
      continue;
    }
    const members = grouped.get(name) ?? [];
    members.push(row);
    grouped.set(name, members);
  }
  const names = new Set([
    ...children.map((child) => child.name),
    ...grouped.keys(),
  ]);
  const result: IndustryComparisonRow[] = [...names].map((name) => ({
    name,
    level,
    summary: summarizeIndustry(
      grouped.get(name) ?? [],
      children.find((child) => child.name === name)?.count,
    ),
  }));
  if (unclassified.length)
    result.push({
      name: '未细分',
      level,
      unclassified: true,
      summary: summarizeIndustry(unclassified),
    });
  return result;
}
