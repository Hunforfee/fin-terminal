import { cachedMarketInput, validateDatedRows } from './marketInputs';
import { fetchDividendPlans, type DividendPlan } from './datasource/dividendPlans';
import { fetchDividends, type DividendEvent } from './datasource/sinaBonus';
import { getMarketStore } from './marketStore';

export function reconcileCashDividends(events: DividendEvent[], plans: DividendPlan[], today: string): DividendEvent[] {
  const latest = new Map<string, DividendPlan>();
  for (const p of plans.filter(p => typeof p.announceDate === 'string' && p.announceDate <= today)
    .sort((a,b) => a.announceDate.localeCompare(b.announceDate)))
    latest.set(`${p.reportDate}:${p.special ? 'special' : 'ordinary'}`, p);
  const implemented = new Map<string, number>();
  for (const p of latest.values()) if (p.implemented && !p.cancelled && p.exDate && p.exDate <= today && p.perShare != null)
    implemented.set(p.exDate, (implemented.get(p.exDate) ?? 0) + p.perShare);
  return events.filter(e => e.exDate <= today).map(e => {
    // The backup already comes from these same implementation records; comparing
    // it to a proposal projection is not an independent source reconciliation.
    if(e.cashSource==='eastmoney-implemented')return e;
    const amount = implemented.get(e.exDate);
    if (amount == null || Math.abs(amount - e.perShare) <= 1e-10) return e;
    const tolerance = (e.precisionPerShare ?? 0) / 2 + 1e-10;
    if (Math.abs(amount - e.perShare) > tolerance) return { ...e, cashConflict: { sina: e.perShare, eastmoney: amount } };
    // Same implemented cash event; one source has a coarser displayed value.
    // This is rounding reconciliation, never an original-document verification.
    return { ...e, perShare: amount, cashSource: 'sina+eastmoney-rounding-reconciled' as const };
  });
}
export function getValuationPlans(code: string): Promise<DividendPlan[]> {
  return cachedMarketInput(`dividend-plans-v2:${code}`, 'announced-dividend-plans',
    'eastmoney:CNY:tax-before:per-share:announced-not-implemented', 1800e3, () => fetchDividendPlans(code), plans => {
      const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0,10);
      if (!plans.length || plans.some(p => p.announceDate > today || p.perShare != null && (!Number.isFinite(p.perShare) || p.perShare < 0))) throw Error('分红公告或金额无效');
    });
}
export function getValuationDividends(code: string): Promise<DividendEvent[]> {
  return cachedMarketInput(`implemented-dividends-v4:${code}`, 'implemented-dividends',
    'sina+eastmoney:CNY:tax-before:per-share:ex-date:rounding-reconciled', 1800e3, async () => {
      const [events, plans] = await Promise.all([fetchDividends(code), getValuationPlans(code)]);
      const reconciled = reconcileCashDividends(events, plans, new Date(Date.now() + 8 * 3600e3).toISOString().slice(0,10));
      const conflicts = reconciled.filter(e => e.cashConflict);
      if (conflicts.length) try { await getMarketStore()?.incident(code, 'cash_dividend_conflict', conflicts); } catch {}
      return reconciled;
    }, rows => {
      validateDatedRows(rows as unknown as Record<string, unknown>[], 'exDate', ['perShare']);
      if (rows.some(r => !Number.isFinite(r.perShare) || r.perShare < 0 || r.perShareStock != null && (!Number.isFinite(r.perShareStock) || r.perShareStock < 0))) throw Error('分红金额或送转比例无效');
    },rows=>[...new Set(rows.map(r=>r.cashSource??'existing-dividend-evidence'))].sort().join('+')+':CNY:tax-before:per-share:ex-date');
}
