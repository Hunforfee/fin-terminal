export const SCREEN_PREFERENCES_KEY = 'fin.screener.preferences.v1';
export const SCREEN_SCHEMES_KEY = 'fin.screener.schemes.v1';
/** Period sentinel: use each company's newest disclosed annual report. */
export const SCREEN_AUTO_PERIOD = 'auto';

export interface ScreenerDraft {
  scope: string;
  /** Included industries; empty means all. */
  industries: string[];
  /** Excluded industries; exclusion always wins over inclusion. */
  excludedIndustries: string[];
  /** 'auto' means newest available annual report, falling back per company. */
  period: string;
  peMin: string;
  peMax: string;
  pbMin: string;
  pbMax: string;
  roeMin: string;
  netMarginMin: string;
  revenueGrowthMin: string;
  profitGrowthMin: string;
  deductedGrowthMin: string;
  debtRatioMax: string;
  marketCapMin: string;
  marketCapMax: string;
  ocfMin: string;
  ocfToProfitMin: string;
  cashflowPositive: boolean;
  deductedProfitPositive: boolean;
}

export function emptyScreenerDraft(period: string): ScreenerDraft {
  return {
    scope: 'all',
    industries: [],
    excludedIndustries: [],
    period,
    peMin: '',
    peMax: '',
    pbMin: '',
    pbMax: '',
    roeMin: '',
    netMarginMin: '',
    revenueGrowthMin: '',
    profitGrowthMin: '',
    deductedGrowthMin: '',
    debtRatioMax: '',
    marketCapMin: '',
    marketCapMax: '',
    ocfMin: '',
    ocfToProfitMin: '',
    cashflowPositive: false,
    deductedProfitPositive: false,
  };
}

export const SCREEN_COLUMNS = [
  { id: 'pe', label: 'PE-TTM', kind: 'number', tone: 'valuation' },
  { id: 'pb', label: 'PB', kind: 'number', tone: 'valuation' },
  { id: 'roe', label: '加权ROE', kind: 'percent', tone: 'quality' },
  { id: 'netMargin', label: '净利率', kind: 'percent', tone: 'quality' },
  { id: 'revenueGrowth', label: '营收同比', kind: 'percent', tone: 'growth' },
  { id: 'deductedGrowth', label: '扣非净利同比', kind: 'percent', tone: 'growth' },
  { id: 'profitGrowth', label: '归母净利同比', kind: 'percent', tone: 'growth' },
  { id: 'debtRatio', label: '资产负债率', kind: 'percent', tone: 'risk' },
  {
    id: 'operatingCashFlow',
    label: '经营现金流（亿）',
    kind: 'currency',
    tone: 'cash',
  },
  {
    id: 'ocfToProfit',
    label: '现金净利比',
    kind: 'percent',
    tone: 'cash',
  },
  {
    id: 'totalMarketCap',
    label: '总市值（亿）',
    kind: 'currency',
    tone: 'neutral',
  },
  {
    id: 'ocfPerShare',
    label: '每股经营现金流（元）',
    kind: 'currency',
    tone: 'cash',
  },
  { id: 'period', label: '报告期', kind: 'date', tone: 'neutral' },
] as const;
export type ScreenColumnId = (typeof SCREEN_COLUMNS)[number]['id'];
export const DEFAULT_SCREEN_COLUMNS: ScreenColumnId[] = [
  'pe',
  'pb',
  'totalMarketCap',
  'roe',
  'revenueGrowth',
  'deductedGrowth',
  'debtRatio',
  'operatingCashFlow',
  'period',
];
export interface ScreenerSort {
  key: ScreenColumnId | 'name' | 'industry';
  direction: 'asc' | 'desc';
}
export interface ScreenerPreferences {
  columns: ScreenColumnId[];
  sort: ScreenerSort;
  filtersCollapsed: boolean;
}
export interface ScreenerScheme {
  id: string;
  name: string;
  criteria: ScreenerDraft;
  columns: ScreenColumnId[];
  sort: ScreenerSort;
}

const isRecord = (raw: unknown): raw is Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const prototype = Object.getPrototypeOf(raw);
  return (
    (prototype === Object.prototype || prototype === null) &&
    !['__proto__', 'prototype', 'constructor'].some((key) =>
      Object.hasOwn(raw, key),
    )
  );
};
const isColumn = (raw: unknown): raw is ScreenColumnId =>
  typeof raw === 'string' && SCREEN_COLUMNS.some((column) => column.id === raw);

/** Fresh arrays/objects prevent edits to one saved preference changing another. */
export function readScreenerPreferences(raw: unknown): ScreenerPreferences {
  const value = isRecord(raw) ? raw : {};
  const columns = Array.isArray(value.columns)
    ? [...new Set(value.columns.filter(isColumn))]
    : [...DEFAULT_SCREEN_COLUMNS];
  const fallback: ScreenerSort = columns.includes('totalMarketCap')
    ? { key: 'totalMarketCap', direction: 'desc' }
    : columns.includes('roe') ? { key: 'roe', direction: 'desc' }
    : { key: 'name', direction: 'asc' };
  const saved = isRecord(value.sort) ? value.sort : null;
  const sort: ScreenerSort =
    saved &&
    (saved.key === 'name' ||
      saved.key === 'industry' ||
      columns.includes(saved.key as ScreenColumnId)) &&
    (saved.direction === 'asc' || saved.direction === 'desc')
      ? { key: saved.key as ScreenerSort['key'], direction: saved.direction }
      : fallback;
  return { columns, sort, filtersCollapsed: value.filtersCollapsed === true };
}

const NUMBER_FIELDS = [
  'peMin',
  'peMax',
  'pbMin',
  'pbMax',
  'roeMin',
  'netMarginMin',
  'revenueGrowthMin',
  'profitGrowthMin',
  'deductedGrowthMin',
  'debtRatioMax',
  'marketCapMin',
  'marketCapMax',
  'ocfMin',
  'ocfToProfitMin',
] as const;
const noControls = (value: string) => !/[\u0000-\u001f\u007f]/.test(value);
const validDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
  );
};
const numberString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (
    trimmed.length > 64 ||
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)
  )
    return null;
  return Number.isFinite(Number(trimmed)) ? trimmed : null;
};

/**
 * Accepts legacy single string, current array, or missing, and returns a
 * deduplicated list. Legacy schemes stored `industry`; both keys are merged so
 * an in-flight upgrade never drops a saved selection.
 */
function normalizeIndustries(...values: unknown[]): string[] | null {
  const result: string[] = [];
  for (const value of values) {
    if (value === undefined || value === null) continue;
    // Legacy shape: a single industry name, empty meaning "all".
    const items = typeof value === 'string' ? (value.trim() ? [value] : []) : value;
    if (!Array.isArray(items) || items.length > 50) return null;
    for (const item of items) {
      if (typeof item !== 'string') return null;
      const name = item.trim();
      if (!name || name.length > 100 || !noControls(name)) return null;
      if (!result.includes(name)) result.push(name);
    }
  }
  return result;
}

function readCriteria(
  raw: unknown,
  defaultPeriod: string,
): ScreenerDraft | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.scope !== 'string' ||
    !noControls(raw.scope) ||
    !(
      raw.scope === 'all' ||
      raw.scope === 'watchlist' ||
      (raw.scope.startsWith('group:') && raw.scope.slice(6).trim())
    )
  )
    return null;
  const industries = normalizeIndustries(raw.industries, raw.industry);
  const excludedIndustries = normalizeIndustries(raw.excludedIndustries);
  if (!industries || !excludedIndustries) return null;
  const period = raw.period === undefined ? defaultPeriod : raw.period;
  if (
    (period !== SCREEN_AUTO_PERIOD && !validDate(period)) ||
    typeof raw.cashflowPositive !== 'boolean' ||
    typeof raw.deductedProfitPositive !== 'boolean'
  )
    return null;
  const criteria = emptyScreenerDraft(period);
  criteria.scope = raw.scope;
  criteria.industries = industries;
  criteria.excludedIndustries = excludedIndustries;
  criteria.cashflowPositive = raw.cashflowPositive;
  criteria.deductedProfitPositive = raw.deductedProfitPositive;
  for (const key of NUMBER_FIELDS) {
    const value = numberString(raw[key]);
    if (value === null) return null;
    criteria[key] = value;
  }
  // Explicitly reconstruct fields: stock-code snapshots and unknown properties
  // never persist into a scheme. Scope is resolved against the current watchlist.
  return criteria;
}

export function readScreenerSchemes(
  raw: unknown,
  defaultPeriod: string,
): ScreenerScheme[] {
  if (!Array.isArray(raw)) return [];
  const result: ScreenerScheme[] = [],
    seen = new Set<string>();
  for (const item of raw) {
    if (result.length === 12) break;
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.name !== 'string' ||
      !Array.isArray(item.columns) ||
      !isRecord(item.sort)
    )
      continue;
    const id = item.id.trim(),
      name = [...item.name.trim()].slice(0, 24).join('');
    if (
      !id ||
      id.length > 100 ||
      !noControls(id) ||
      seen.has(id) ||
      !name ||
      !noControls(name)
    )
      continue;
    if (
      !(item.sort.direction === 'asc' || item.sort.direction === 'desc') ||
      !(
        isColumn(item.sort.key) ||
        item.sort.key === 'name' ||
        item.sort.key === 'industry'
      )
    )
      continue;
    const criteria = readCriteria(item.criteria, defaultPeriod);
    if (!criteria) continue;
    const preferences = readScreenerPreferences(item);
    result.push({
      id,
      name,
      criteria,
      columns: preferences.columns,
      sort: preferences.sort,
    });
    seen.add(id);
  }
  return result;
}
