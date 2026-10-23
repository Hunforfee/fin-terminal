/** Shared collection range and stable phase IDs (also used by progress labels). */
export const HISTORY_YEARS = 10;
export const HISTORY_BAR_COUNT = 3000;
export const FINANCIAL_LOOKBACK = HISTORY_YEARS + 1;
export const coverageKey = (symbol: string) => `market-coverage:v1:${symbol}:${HISTORY_YEARS}`;
export function historyStart(now = Date.now()) {
  const date = new Date(now + 8 * 3600e3), month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() - HISTORY_YEARS);
  if (date.getUTCMonth() !== month) date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}
/**
 * 财报/财务指标等「输入数据」的准入下限。
 *
 * 图表窗口（historyStart）是日期粒度——十年前的今天；而覆盖检查（marketHistoryCollection）
 * 按年份要求最近 FINANCIAL_LOOKBACK=HISTORY_YEARS+1 年的财报页。若输入准入也按日期粒度，
 * 窗口左边界之前最近一个已披露报告期（前一年年报、当年各季报）会被一并拒绝：
 * 2016-10-24 起算的十年窗口，其最早一批交易日只有 2016-09-30 三季报可作估值依据，
 * 而该日期早于日期粒度的截止点。故输入准入放宽一年、按年度粒度，
 * 与覆盖检查口径一致；保留层（source-sina-page 等多留 2 年）本就允许。
 */
export const financialEarliestYear = (now = Date.now()) =>
  new Date(now + 8 * 3600e3).getUTCFullYear() - HISTORY_YEARS - 1;
export const reportCutoff = (now = Date.now()) => `${financialEarliestYear(now)}-01-01`;
/** Only reports already due for a listed A share are mandatory. A nonempty
 * imported annual page is not proof that all its published quarters are saved. */
export function requiredFinancialReports(year: number, listingDate?: string, now = Date.now()): string[] {
  const today = new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
  return [['03-31', `${year}-05-01`], ['06-30', `${year}-09-01`],
    ['09-30', `${year}-11-01`], ['12-31', `${year + 1}-05-01`]]
    .filter(([period, due]) => due <= today && (!listingDate || `${year}-${period}` >= listingDate))
    .map(([period]) => `${year}-${period}`);
}
// Keep IDs 10–13 stable for existing gap records and the independent resolve API.
export function financialYearForPhase(phase: number, now = Date.now()): number | null {
  const offset = phase >= 3 && phase <= 9 ? phase - 3 : phase >= 14 && phase <= 18 ? phase - 7 : null;
  return offset === null ? null : new Date(now + 8 * 3600e3).getUTCFullYear() - offset;
}
export const FULL_HISTORY_PHASES = [0,1,2,3,4,5,6,7,8,9,14,15,16,17,18,10,11,13,12];
export const RECENT_HISTORY_PHASES = [2,0,1,3,4,10,11,13,12];
export function collectionPhases(mode: string, initialize: boolean) {
  return mode === 'daily' ? [19]
    : mode === 'financial' ? [20]
    : mode === 'ten-year' || mode === 'five-year' || initialize ? FULL_HISTORY_PHASES : RECENT_HISTORY_PHASES;
}
export function collectionPhaseLabel(phase?: number) {
  if (phase === undefined) return '';
  const year = financialYearForPhase(phase);
  return year !== null ? `${year} 年财报` : ({
    19:'指定日行情',20:'财务与分红更新',0:'历史行情', 1:'复权行情', 2:'最新财务与分红', 10:'历史估值基础数据',
    11:'历史估值与公告日期', 12:'完整性检查', 13:'公司资料',
  } as Record<number,string>)[phase] ?? '';
}
