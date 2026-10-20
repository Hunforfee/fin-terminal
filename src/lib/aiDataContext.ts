import type { FinancialSummary, Market, Quote, Valuation } from './datasource/types';

interface Context {
  market?: Market;
  quote: Quote | null;
  valuation: Valuation | null;
  financial: FinancialSummary | null;
  profile: { holder: string | null; holderRatio: number | null; controller: string | null; industryPath?: string | null; industry: string | null } | null;
}
const value = (v: number | null | undefined, suffix = '') =>
  typeof v === 'number' && Number.isFinite(v) ? `${v}${suffix}` : '缺失';

/** Formatting is shared with tests so AI cannot lose financial provenance. */
export function formatAiDataContext({ market, quote: q, valuation: v, financial: f, profile: p }: Context): string {
  const hk = (q?.market ?? market) === 'HK';
  const currency = hk ? '港元' : '人民币元';
  const amountCurrency = hk ? '亿港元' : '亿元人民币';
  const parts: string[] = [];
  if (q) parts.push(`行情（来源 ${q.source}；时间 ${q.ts ?? '未知'}；${q.stale ? '历史快照，非实时' : '接口行情，未人工复核'}）：价格 ${value(q.price, currency)}；总市值 ${value(q.totalMarketCap, amountCurrency)}；PE-TTM ${value(q.pe)}；PB ${value(q.pb)}`);
  if (v) {
    parts.push(`估值（来源 ${v.source}；数据截至 ${v.stats?.to || v.fin?.report || '未知'}；${v.basis === 'real' ? '财报复算/数据源口径' : '估算口径'}；${v.stale ? '含过期数据' : '未人工原文复核'}）：PE ${value(v.pe)}；PB ${value(v.pb)}；PE历史分位 ${value(v.pePercentile, '%')}；PB历史分位 ${value(v.pbPercentile, '%')}。分位缺失时不能据此判断高估/低估。`);
    const dyBasis = v.dividendYieldMethod === 'announced-forward' ? '公告方案延续的预期值，不是确定的未来分红' : v.dividendYieldMethod === 'hk-static' ? '完整财年静态口径' : '口径未注明';
    parts.push(`股息率 ${value(v.dividendYield, '%')}（${dyBasis}）；静态股息率 ${value(v.staticDividendYield, '%')}。`);
    if (v.roe != null) parts.push(hk ? `数据源年化ROE ${value(v.roe, '%')}，不等同于累计加权平均ROE。` : `PB/PE派生ROE ${value(v.roe, '%')}，不等同于披露的加权平均ROE。`);
    if (v.netProfit != null) parts.push(`归母净利润TTM ${value(v.netProfit, amountCurrency)}（报告期 ${v.fin?.report ?? '未知'}）。`);
    if (v.warnings?.length) parts.push(`数据限制：${v.warnings.join('；')}`);
  }
  if (f) {
    const derived = f.provenance !== 'fetched';
    parts.push(`财务摘要：${derived ? '行情派生/样本，非已披露财报，不得称为实际财报' : '数据接口财报，未人工原文复核'}。${f.note ?? ''}`);
    const unit = f.currency ? f.currency === 'CNY' ? '亿元人民币' : f.currency === 'HKD' ? '亿港元' : `亿（${f.currency}）`
      : derived ? amountCurrency : hk ? '币种未注明，不能跨币种比较' : '亿元人民币';
    for (let i = 0; i < Math.min(f.periods.length, 5); i++) {
      parts.push(`${f.periods[i]}：营收 ${value(f.revenue[i], `（${unit}）`)}；净利润 ${value(f.netProfit[i], `（${unit}）`)}；ROE ${value(f.roe[i], '%')}（${derived ? '派生值，非披露加权平均' : '按数据源口径'}）；营收同比 ${derived ? '缺失' : value(f.revenueGrowth[i], '%')}；净利同比 ${derived ? '缺失' : value(f.profitGrowth[i], '%')}；负债率 ${value(f.debtRatio[i], '%')}。`);
    }
  }
  if (p) parts.push(`公司资料：控股股东 ${p.holder ?? '缺失'}；持股比例 ${value(p.holderRatio, '%')}；实控人 ${p.controller ?? '缺失'}；行业 ${p.industryPath ?? p.industry ?? '缺失'}。`);
  return parts.length ? `\n\n─── 站内接口资料（不代表人工核验结论）───\n${parts.join('\n')}\n缺失值不等于零；不混用币种、报告期、累计/年化/TTM口径。\n─── 站内资料结束 ───\n` : '';
}
