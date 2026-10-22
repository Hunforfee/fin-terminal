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
// Keep IDs 10–13 stable for existing gap records and the independent resolve API.
export function financialYearForPhase(phase: number, now = Date.now()): number | null {
  const offset = phase >= 3 && phase <= 9 ? phase - 3 : phase >= 14 && phase <= 18 ? phase - 7 : null;
  return offset === null ? null : new Date(now + 8 * 3600e3).getUTCFullYear() - offset;
}
export const FULL_HISTORY_PHASES = [0,1,2,3,4,5,6,7,8,9,14,15,16,17,18,10,11,13,12];
export const RECENT_HISTORY_PHASES = [2,0,1,3,4,10,11,13,12];
export function collectionPhases(mode: string, initialize: boolean) {
  return mode === 'daily' && !initialize ? [2,12]
    : mode === 'ten-year' || mode === 'five-year' || initialize ? FULL_HISTORY_PHASES : RECENT_HISTORY_PHASES;
}
export function collectionPhaseLabel(phase?: number) {
  if (phase === undefined) return '';
  const year = financialYearForPhase(phase);
  return year !== null ? `${year} 年财报` : ({
    0:'历史行情', 1:'复权行情', 2:'最新财务与分红', 10:'历史估值基础数据',
    11:'历史估值与公告日期', 12:'完整性检查', 13:'公司资料',
  } as Record<number,string>)[phase] ?? '';
}
