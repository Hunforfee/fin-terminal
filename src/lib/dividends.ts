import type { Candle } from './datasource/types';
import type { DividendEvent } from './datasource/sinaBonus';
import type { DividendPlan } from './datasource/dividendPlans';

function shiftYear(date: string, years: number): string {
  const year = Number(date.slice(0, 4)) + years;
  const md = date.slice(5) === '02-29' ? '02-28' : date.slice(5);
  return `${year}-${md}`;
}

/**
 * 公告方案延续法：以当时已公开、金额明确的最近一个报告年度周期估计未来一年的税前派息。
 * 年报/中报/季报的最新方案合计；新周期同一报告期替换旧期，不叠加两年的年度派息。
 * 超过原公告周年三个月仍未更新的旧方案停止外推；未披露金额不是零分红。
 * 这是分红水平延续的估计，不是盈利预测，也不读取估值日之后公布的分红金额。
 */
export function buildExpectedDividendYieldByDate(
  plans: DividendPlan[], rawCandles: Candle[], splits: DividendEvent[] = [],
): Map<string, number | null> {
  const result = new Map<string, number | null>();
  for (const candle of rawCandles) {
    if (!(candle.close > 0)) continue;
    // 接口只有日期，没有盘中/盘后时间；保守地从公告次日起纳入。
    const known = plans.filter(p => typeof p.announceDate === 'string' && p.announceDate < candle.date);
    // 同一报告期发生修订/取消时取最新公告。金额未知的新公告也不能沿用旧版金额。
    const byReport = new Map<string, DividendPlan>();
    // A special distribution is a separate component, not a revision that
    // replaces the ordinary dividend for the same reporting period.
    for (const p of [...known].sort((a, b) => a.announceDate.localeCompare(b.announceDate)))
      byReport.set(`${p.reportDate}:${p.special ? 'special' : 'ordinary'}`, p);
    const eligible = [...byReport.values()].filter(p => p.perShare !== null);
    if (!eligible.length) { result.set(candle.date, null); continue; }
    const latestReport = eligible.map(p => p.reportDate).sort().at(-1)!;
    const reportStart = shiftYear(latestReport, -1);
    let total = 0;
    let unknown = false;
    for (const p of byReport.values()) {
      if (p.reportDate <= reportStart) continue;
      if (p.perShare === null) {
        // 未结束报告期的政策性预披露不替代已有的完整周期；已结束报告期金额缺失则不猜测。
        if (p.reportDate <= candle.date) unknown = true;
        continue;
      }
      const expiry = new Date(shiftYear(p.announceDate, 1) + 'T00:00:00Z');
      expiry.setUTCDate(expiry.getUTCDate() + 92);
      if (candle.date > expiry.toISOString().slice(0, 10)) continue;
      // 已实施的特别派息不重复预测；特别派息只有已知尚可参与的除息安排才计入。
      if (p.special && (!p.exDate || !p.scheduleKnownDate || p.scheduleKnownDate >= candle.date || p.exDate <= candle.date || p.exDate > shiftYear(candle.date, 1))) continue;
      const factor = splits.filter(e => e.exDate > p.announceDate && e.exDate <= candle.date)
        .reduce((f, e) => f * (1 + (e.perShareStock ?? 0)), 1);
      total += p.perShare / factor;
    }
    result.set(candle.date, unknown ? null : total / candle.close * 100);
  }
  return result;
}
