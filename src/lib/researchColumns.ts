export const RESEARCH_TABLE_KEY = 'fin.research.table.v1';
export const RESEARCH_TABLE_VERSION = 3;
export const RESEARCH_COLUMNS = [
  { id: 'pe', label: 'PE-TTM' },
  { id: 'peDeducted', label: '扣非PE-TTM' },
  { id: 'pb', label: 'PB' },
  { id: 'dy', label: '股息率', suffix: '%' },
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
  /** Older saved preferences predate the dividend-yield column. */
  version?: number;
  columns: ResearchColumnId[];
  sort: ResearchSort | null;
}
export const defaultResearchTable = (): ResearchTablePreferences => ({
  version: RESEARCH_TABLE_VERSION,
  columns: ['pe', 'peDeducted', 'pb', 'dy', 'roe', 'netMargin', 'ocfPerShare', 'period'],
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
  /**
   * 旧版偏好补列。原则：只在「该版本还不存在这一列」时补，用户主动隐藏必须保留。
   * - dy 自 v2 引入：v1 及更早的偏好缺少 dy 一律补在 PB 之后；
   * - peDeducted 自 v3 引入：v2 及更早的偏好缺少 peDeducted 补在 PE-TTM 之后。
   * 空数组始终表示用户隐藏了全部列，不做任何补列。
   */
  // 无版本号视为当前格式（由本函数写出），不补列；只有明确标注旧版本才迁移
  const version = typeof value.version === 'number' ? value.version : RESEARCH_TABLE_VERSION;
  let migratedColumns: ResearchColumnId[] = columns;
  const insertAfter = (id: ResearchColumnId, after: ResearchColumnId) => {
    const at = migratedColumns.indexOf(after);
    migratedColumns =
      at >= 0
        ? [...migratedColumns.slice(0, at + 1), id, ...migratedColumns.slice(at + 1)]
        : [...migratedColumns, id];
  };
  if (migratedColumns.length > 0) {
    if (version < 2 && !migratedColumns.includes('dy')) insertAfter('dy', 'pb');
    if (version < 3 && !migratedColumns.includes('peDeducted')) insertAfter('peDeducted', 'pe');
  }
  const sort =
    value.sort &&
    (value.sort.column === 'name' ||
      migratedColumns.includes(value.sort.column)) &&
    ['asc', 'desc'].includes(value.sort.direction)
      ? value.sort
      : null;
  return { version: RESEARCH_TABLE_VERSION, columns: migratedColumns, sort };
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
