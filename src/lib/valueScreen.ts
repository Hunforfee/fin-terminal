import { industryStockSymbol } from './industryResearch';
import { normalizeStockCode } from './datasource/codes';
import { SCREEN_AUTO_PERIOD as VALUE_SCREEN_AUTO_PERIOD } from './screenerPreferences';

export const VALUE_SCREEN_NUMBER_KEYS = [
  'peMin', 'peMax', 'pbMin', 'pbMax', 'roeMin', 'netMarginMin',
  'revenueGrowthMin', 'profitGrowthMin', 'deductedGrowthMin', 'debtRatioMax',
  'marketCapMin', 'marketCapMax', 'ocfMin', 'ocfToProfitMin',
] as const;
export type ValueScreenNumberKey = (typeof VALUE_SCREEN_NUMBER_KEYS)[number];
export const VALUE_SCREEN_BOOLEAN_KEYS = ['cashflowPositive', 'deductedProfitPositive'] as const;

/** Percentages use percentage points (100 = 100%); monetary filters use CNY yi. */
export interface ValueScreenCriteria extends Partial<Record<ValueScreenNumberKey, number>> {
  /** SCREEN_AUTO_PERIOD, or a YYYY-12-31 annual report date. */
  period: string;
  /** Included industries; empty/undefined means all. */
  industries?: string[];
  /** Excluded industries; exclusion always wins over inclusion. */
  excludedIndustries?: string[];
  scope: 'all' | 'watchlist';
  codes?: string[];
  cashflowPositive?: boolean;
  deductedProfitPositive?: boolean;
}

export interface ValueScreenRow {
  code: string;
  symbol: string;
  name: string;
  industry: string;
  period: string;
  noticeDate: string | null;
  price: number | null;
  pe: number | null;
  pb: number | null;
  totalMarketCap: number | null;
  roe: number | null;
  netMargin: number | null;
  revenueGrowth: number | null;
  profitGrowth: number | null;
  deductedGrowth: number | null;
  debtRatio: number | null;
  /** Operating cash flow, CNY yi. */
  operatingCashFlow: number | null;
  /** Operating cash flow / total net profit, percent; nonpositive profit is unavailable. */
  ocfToProfit: number | null;
  ocfPerShare: number | null;
  /** Deducted attributable profit, CNY yi, for the selected annual report. */
  deductedProfit: number | null;
  financialAvailable: boolean;
  quoteAvailable: boolean;
  quoteTime: string | null;
}

export interface ValueScreenResult {
  rows: ValueScreenRow[];
  total: number;
  /** Candidates after scope and industry selection, before financial conditions. */
  universeCount: number;
  financialCount: number;
  quoteCount: number;
  /** Candidates that passed financial conditions and were queried for current quotes. */
  scannedCount: number;
  /** Companies with an active condition that cannot be evaluated, unless another active condition already rejects them. */
  unknownConditionCount?: number;
  /** Newest requested annual report; 'auto' when each company picks its own newest. */
  period: string;
  /** What the caller asked for, preserved for display. */
  requestedPeriod: string;
  /** Companies whose financials come from an earlier report than the newest requested one. */
  fallbackCount: number;
  updatedAt: string;
  partial: boolean;
}

export interface ValueScreenMeta {
  periods: string[];
  /** Newest-first report dates used when period is 'auto'. */
  fallbackPeriods: string[];
  industries: { name: string; count: number }[];
  universeCount: number;
  defaultPeriod: string;
}

export interface ValueScreenCandidate {
  code: string;
  symbol: string;
  industry: string;
}
export type ValueScreenFinancial = Pick<ValueScreenRow,
  'code' | 'name' | 'period' | 'noticeDate' | 'roe' | 'netMargin' | 'revenueGrowth' |
  'profitGrowth' | 'deductedGrowth' | 'debtRatio' | 'operatingCashFlow' |
  'ocfToProfit' | 'ocfPerShare' | 'deductedProfit'>;

export function valueScreenToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** Annual reports finish their normal disclosure window on the following April 30. */
export function valueScreenPeriods(now = new Date()): string[] {
  const today = valueScreenToday(now);
  const newest = Number(today.slice(0, 4)) - (today.slice(5) >= '05-01' ? 1 : 2);
  return Array.from({ length: 5 }, (_, index) => `${newest - index}-12-31`);
}

/** How many report dates 'auto' scans; later dates cover the vast majority of companies. */
export const VALUE_SCREEN_FALLBACK_DEPTH = 3;
/** Newest-first dates actually requested when period is 'auto'. */
export function valueScreenFallbackPeriods(periods: string[]): string[] {
  return periods.slice(0, VALUE_SCREEN_FALLBACK_DEPTH);
}

/** Report dates a screen run must fetch: one explicit date, or the auto fallback set. */
export function valueScreenRequestedPeriods(criteria: ValueScreenCriteria, periods: string[]): string[] {
  if (criteria.period === VALUE_SCREEN_AUTO_PERIOD) return valueScreenFallbackPeriods(periods);
  return [criteria.period];
}

/** Use the same A-share rules as industry research, retaining stock/index disambiguation. */
export function valueScreenUniverse(industries: { name: string; stocks: string[] }[]): ValueScreenCandidate[] {
  const rows = new Map<string, ValueScreenCandidate>();
  for (const industry of industries) {
    for (const code of industry.stocks) {
      const symbol = industryStockSymbol(code);
      if (symbol && !rows.has(code)) rows.set(code, { code, symbol, industry: industry.name });
    }
  }
  return [...rows.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export function selectValueScreenUniverse(universe: ValueScreenCandidate[], criteria: ValueScreenCriteria): ValueScreenCandidate[] {
  const selected = new Set((criteria.codes ?? []).flatMap(input => {
    const stock = normalizeStockCode(input);
    return stock && industryStockSymbol(stock.code) === stock.symbol ? [stock.symbol] : [];
  }));
  const included = criteria.industries?.length ? new Set(criteria.industries) : null;
  const excluded = new Set(criteria.excludedIndustries ?? []);
  return universe.filter(row =>
    (!included || included.has(row.industry)) &&
    !excluded.has(row.industry) &&
    (criteria.scope !== 'watchlist' || selected.has(row.symbol)));
}

/** Trimmed, deduplicated industry names; every entry must exist in the classification. */
function readIndustries(value: unknown, industries: string[], label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50 || value.some(item => typeof item !== 'string'))
    throw Error(`${label}必须为字符串数组`);
  const result: string[] = [];
  for (const item of value as string[]) {
    const name = item.trim();
    if (!name || name.length > 100) throw Error(`${label}名称无效`);
    if (!industries.includes(name)) throw Error('请选择有效的申万一级行业');
    if (!result.includes(name)) result.push(name);
  }
  return result;
}

export function readValueScreenCriteria(raw: unknown, industries: string[], now = new Date()): ValueScreenCriteria {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('筛选条件必须为 JSON 对象');
  const input = raw as Record<string, unknown>;
  const allowed = new Set<string>(['period', 'industries', 'excludedIndustries', 'industry', 'scope', 'codes', ...VALUE_SCREEN_NUMBER_KEYS, ...VALUE_SCREEN_BOOLEAN_KEYS]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw Error('包含不支持的筛选条件');
  const period = input.period;
  if (typeof period !== 'string' || (period !== VALUE_SCREEN_AUTO_PERIOD &&
    (!/^\d{4}-12-31$/.test(period) ||
      Number(period.slice(0, 4)) < 1998 || period >= valueScreenToday(now))))
    throw Error('请选择已结束年度的年报日期，如 2025-12-31');
  const scope = input.scope ?? 'all';
  if (scope !== 'all' && scope !== 'watchlist') throw Error('股票范围仅支持全部 A 股或自选 A 股');
  const result: ValueScreenCriteria = { period, scope };
  // `industry` is the legacy single-value shape; older clients still send it.
  const legacy = input.industry === undefined ? undefined
    : typeof input.industry === 'string' ? (input.industry.trim() ? [input.industry] : [])
    : input.industry;
  const included = readIndustries(input.industries ?? legacy, industries, '行业');
  const excluded = readIndustries(input.excludedIndustries, industries, '排除行业');
  if (included?.length) result.industries = included;
  if (excluded?.length) {
    const overlap = included?.filter(name => excluded.includes(name));
    if (overlap?.length) throw Error(`行业「${overlap[0]}」同时被包含和排除，请只保留一项`);
    result.excludedIndustries = excluded;
  }
  if (input.codes !== undefined) {
    if (!Array.isArray(input.codes) || input.codes.length > 10000 || input.codes.some(code => typeof code !== 'string'))
      throw Error('自选代码必须为字符串数组，最多 10000 项');
    result.codes = input.codes as string[];
  }
  for (const key of VALUE_SCREEN_NUMBER_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw Error('筛选数值必须为有效数字');
    result[key] = value;
  }
  for (const key of VALUE_SCREEN_BOOLEAN_KEYS) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') throw Error('筛选开关必须为布尔值');
    result[key] = input[key] as boolean;
  }
  for (const [min, max] of [['peMin', 'peMax'], ['pbMin', 'pbMax'], ['marketCapMin', 'marketCapMax']] as const)
    if (result[min] !== undefined && result[max] !== undefined && result[min]! > result[max]!)
      throw Error('筛选范围的下限不能大于上限');
  return result;
}

const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);
const minimum = (value: number | null, threshold?: number): boolean | null => threshold === undefined ? true : finite(value) ? value >= threshold : null;
const maximum = (value: number | null, threshold?: number): boolean | null => threshold === undefined ? true : finite(value) ? value <= threshold : null;
const positive = (value: number | null, enabled?: boolean): boolean | null => !enabled ? true : finite(value) ? value > 0 : null;
export type ValueScreenConditionStatus = 'match' | 'reject' | 'unknown';
const conditionStatus = (checks: (boolean | null)[]): ValueScreenConditionStatus =>
  checks.includes(false) ? 'reject' : checks.includes(null) ? 'unknown' : 'match';

export function valueScreenFinancialStatus(row: ValueScreenRow, c: ValueScreenCriteria): ValueScreenConditionStatus {
  return conditionStatus([
    minimum(row.roe, c.roeMin), minimum(row.netMargin, c.netMarginMin),
    minimum(row.revenueGrowth, c.revenueGrowthMin), minimum(row.profitGrowth, c.profitGrowthMin),
    minimum(row.deductedGrowth, c.deductedGrowthMin), maximum(row.debtRatio, c.debtRatioMax),
    minimum(row.operatingCashFlow, c.ocfMin), minimum(row.ocfToProfit, c.ocfToProfitMin),
    positive(row.operatingCashFlow, c.cashflowPositive), positive(row.deductedProfit, c.deductedProfitPositive),
  ]);
}

export function valueScreenQuoteStatus(row: ValueScreenRow, c: ValueScreenCriteria): ValueScreenConditionStatus {
  return conditionStatus([
    minimum(row.pe, c.peMin), maximum(row.pe, c.peMax),
    minimum(row.pb, c.pbMin), maximum(row.pb, c.pbMax),
    minimum(row.totalMarketCap, c.marketCapMin), maximum(row.totalMarketCap, c.marketCapMax),
  ]);
}

export function matchesValueScreenFinancial(row: ValueScreenRow, c: ValueScreenCriteria): boolean {
  return valueScreenFinancialStatus(row, c) === 'match';
}

export function matchesValueScreenQuote(row: ValueScreenRow, c: ValueScreenCriteria): boolean {
  return valueScreenQuoteStatus(row, c) === 'match';
}

export function emptyValueScreenRow(candidate: ValueScreenCandidate, period: string): ValueScreenRow {
  return {
    ...candidate, name: candidate.code, period, noticeDate: null,
    price: null, pe: null, pb: null, totalMarketCap: null,
    roe: null, netMargin: null, revenueGrowth: null, profitGrowth: null,
    deductedGrowth: null, debtRatio: null, operatingCashFlow: null,
    ocfToProfit: null, ocfPerShare: null, deductedProfit: null,
    financialAvailable: false, quoteAvailable: false, quoteTime: null,
  };
}
