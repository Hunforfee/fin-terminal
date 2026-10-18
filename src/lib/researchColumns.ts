export const RESEARCH_TABLE_KEY = 'fin.research.table.v1';
export const RESEARCH_COLUMNS = [
  { id: 'pe', label: 'PE-TTM' },
  { id: 'pb', label: 'PB' },
  { id: 'roe', label: 'ROE（累计）', suffix: '%' },
  { id: 'netMargin', label: '净利率', suffix: '%' },
  { id: 'ocfPerShare', label: '每股经营现金流', suffix: ' 元' },
  { id: 'period', label: '报告期' },
  { id: 'debtRatio', label: '资产负债率', suffix: '%' },
  { id: 'price', label: '最新价' },
  { id: 'changePct', label: '涨跌幅', suffix: '%' },
  { id: 'totalMarketCap', label: '总市值（亿）' },
] as const;
export type ResearchColumnId = (typeof RESEARCH_COLUMNS)[number]['id'];
export type ResearchSort = {
  column: ResearchColumnId | 'name';
  direction: 'asc' | 'desc';
};
export interface ResearchTablePreferences {
  columns: ResearchColumnId[];
  sort: ResearchSort | null;
}
export const defaultResearchTable = (): ResearchTablePreferences => ({
  columns: ['pe', 'pb', 'roe', 'netMargin', 'ocfPerShare', 'period'],
  sort: null,
});
export function readResearchTable(raw: unknown): ResearchTablePreferences {
  const defaults = defaultResearchTable();
  if (!raw || typeof raw !== 'object') return defaults;
  const value = raw as Partial<ResearchTablePreferences>;
  const allowed = new Set<string>(RESEARCH_COLUMNS.map((c) => c.id));
  const columns = Array.isArray(value.columns)
    ? [
        ...new Set(
          value.columns.filter(
            (c): c is ResearchColumnId =>
              typeof c === 'string' && allowed.has(c),
          ),
        ),
      ]
    : defaults.columns;
  const sort =
    value.sort &&
    (value.sort.column === 'name' || columns.includes(value.sort.column)) &&
    ['asc', 'desc'].includes(value.sort.direction)
      ? value.sort
      : null;
  return { columns, sort };
}
// Missing or nonfinite values stay last in both directions. Ties retain saved order.
export function compareResearchValues(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
  direction: 'asc' | 'desc',
): number {
  const missing = (v: typeof a) =>
    v == null || (typeof v === 'number' && !Number.isFinite(v)) || v === '';
  if (missing(a)) return missing(b) ? 0 : 1;
  if (missing(b)) return -1;
  const delta =
    typeof a === 'number' && typeof b === 'number'
      ? a - b
      : String(a).localeCompare(String(b), 'zh-CN');
  return direction === 'asc' ? delta : -delta;
}
