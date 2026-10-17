/**
 * 估值与财务分析层。
 *
 * 关键设计：在缺少合规财务数据源（iFinD 当前不可用）的前提下，
 * 这里只做**数学上严格成立**的推导，不做编造：
 *
 *   净利润(TTM) = 总市值 / PE
 *   净资产      = 总市值 / PB
 *   ROE         = 净利润 / 净资产 = PB / PE      ← 恒等式，与估值精度等价
 *   总股本      = 总市值 / 股价
 *
 * 这四项完全由真实行情字段推导，因此可标注为"真实派生"。
 * 历史估值带需要历史 EPS 序列——没有财务接口就无法获得真实值，
 * 因此采用「当前 TTM EPS + 由 PE(静)/PE(动) 反解的盈利增速」做复合回溯，
 * 并在返回值里显式标注 estimate=true，UI 必须提示这是估算口径。
 */

import type { Candle, FinancialSummary, Quote, Valuation, ValuationPoint } from './datasource/types';
import type { DividendEvent } from './datasource/sinaBonus';

/** 在升序数组中求 v 的百分位（0-100） */
export function percentileOf(sortedAsc: number[], v: number): number {
  if (sortedAsc.length === 0) return NaN;
  let lo = 0;
  let hi = sortedAsc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedAsc[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return (lo / sortedAsc.length) * 100;
}

export interface DerivedFinancials {
  /** 净利润 TTM（亿元） */
  netProfit: number | null;
  /** 净资产（亿元） */
  netAssets: number | null;
  /** ROE % */
  roe: number | null;
  /** 总股本（亿股） */
  shares: number | null;
  /** 每股收益 TTM（元） */
  eps: number | null;
  /** 每股净资产（元） */
  bps: number | null;
}

/** 由行情字段严格派生财务指标 */
export function deriveFinancials(q: Quote): DerivedFinancials {
  const mc = q.totalMarketCap; // 亿元
  const eps = q.pe && q.price ? q.price / q.pe : null;
  const bps = q.pb && q.price ? q.price / q.pb : null;
  const netProfit = mc !== null && q.pe ? mc / q.pe : null;
  const netAssets = mc !== null && q.pb ? mc / q.pb : null;
  const roe = q.pb !== null && q.pe ? (q.pb / q.pe) * 100 : null;
  const shares = mc !== null && q.price ? mc / q.price : null;
  return { netProfit, netAssets, roe, shares, eps, bps };
}

/**
 * 由 PE(静) 与 PE(动) 反解隐含盈利增速。
 * PE(静) = P / EPS_上年，PE(动) = P / EPS_今年年化
 * 故 g ≈ PE静 / PE动 - 1
 */
export function impliedGrowth(q: Quote): number | null {
  if (!q.peStatic || !q.peForward || q.peForward <= 0) return null;
  const g = q.peStatic / q.peForward - 1;
  // 过滤掉明显失真的极值
  return Number.isFinite(g) && Math.abs(g) < 5 ? g : null;
}

/**
 * 构建历史估值序列（估算口径）。
 * @param candles 前复权 K 线
 * @param q 当前行情（提供 PE/PB 与增速）
 * @param years 回溯年数用于 EPS 复合折现
 */
export function buildValuationSeries(
  q: Quote,
  candles: Candle[],
  opts?: { dyByDate?: Map<string, number> },
): ValuationPoint[] {
  if (!q.price || !q.pe || candles.length === 0) return [];

  const epsNow = q.price / q.pe;
  const g = impliedGrowth(q) ?? 0;
  const bpsNow = q.pb ? q.price / q.pb : null;

  const last = candles[candles.length - 1];
  const lastTime = new Date(last.date).getTime();

  return candles.map((c) => {
    const yearsAgo = Math.max(0, (lastTime - new Date(c.date).getTime()) / (365.25 * 864e5));
    // 越往前，盈利越低（按复合增速回溯）
    const epsT = epsNow / Math.pow(1 + g, yearsAgo);
    const pe = epsT > 0 ? c.close / epsT : null;
    let pb: number | null = null;
    if (bpsNow) {
      // 净资产按留存收益累积回溯：BPS 增速低于 EPS 增速，用 0.6g 近似并标注估算
      const bpsT = bpsNow / Math.pow(1 + g * 0.6, yearsAgo);
      pb = bpsT > 0 ? c.close / bpsT : null;
    }
    const dy = opts?.dyByDate?.get(c.date) ?? null;
    return { date: c.date, pe, pb, close: c.close, dy };
  });
}

/** 汇总估值：当前值 + 历史分位 + 估算序列 */
export function computeValuation(
  q: Quote,
  candles: Candle[],
  opts?: { dividends?: DividendEvent[]; rawCandles?: Candle[]; years?: number },
): Valuation {
  const dyByDate = buildDividendYieldByDate(opts?.dividends ?? [], opts?.rawCandles ?? candles);
  const history = buildValuationSeries(q, candles, { dyByDate });
  const d = deriveFinancials(q);

  const dyList = [...dyByDate.values()].filter((v): v is number => v !== null);
  const dividendYield = dyList.length > 0 ? dyList[dyList.length - 1] : null;

  const peList = history.map((h) => h.pe).filter((v): v is number => v !== null && Number.isFinite(v));
  const pbList = history.map((h) => h.pb).filter((v): v is number => v !== null && Number.isFinite(v));

  const peSorted = [...peList].sort((a, b) => a - b);
  const pbSorted = [...pbList].sort((a, b) => a - b);

  const pePercentile =
    q.pe !== null && peSorted.length > 10 ? round1(percentileOf(peSorted, q.pe)) : null;
  const pbPercentile =
    q.pb !== null && pbSorted.length > 10 ? round1(percentileOf(pbSorted, q.pb)) : null;

  return {
    code: q.code,
    basis: 'estimate',
    years: opts?.years ?? 5,
    pe: q.pe,
    pb: q.pb,
    pePercentile,
    pbPercentile,
    dividendYield,
    roe: d.roe,
    netProfit: d.netProfit,
    netAssets: d.netAssets,
    history: downsample(history, Math.max(240, Math.round((opts?.years ?? 5) * 100))),
    source: q.source,
    stale: q.stale,
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** 抽稀，避免前端绘制过多点 */
export function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  out.push(arr[arr.length - 1]);
  return out;
}

/**
 * 生成财务摘要。
 * 有 iFinD 时用真实三表（由调用方传入），否则只给派生单期并如实标注。
 */
export function buildFinancialSummary(q: Quote, real?: FinancialSummary): FinancialSummary {
  if (real && real.provenance === 'fetched') return real;
  const d = deriveFinancials(q);
  const g = impliedGrowth(q);
  // 单期：只有 TTM 口径是可靠的
  return {
    code: q.code,
    periods: ['TTM'],
    revenue: [null],
    netProfit: [d.netProfit],
    roe: [d.roe],
    grossMargin: [null],
    debtRatio: [null],
    revenueGrowth: [null],
    profitGrowth: [g === null ? null : g * 100],
    provenance: 'derived',
    note:
      '营收/毛利率/负债率需三表数据，当前由行情估值字段按 PE/PB 恒等式派生出净利润、净资产与 ROE；' +
      '接入同花顺 iFinD 后可自动切换为真实财报口径',
  };
}

/** 移动均线 */
export function movingAverage(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}

/** 区间涨跌幅 % */
export function rangeChange(candles: Candle[], days: number): number | null {
  if (candles.length === 0) return null;
  const last = candles[candles.length - 1].close;
  const idx = Math.max(0, candles.length - 1 - days);
  const first = candles[idx].close;
  if (!first) return null;
  return ((last - first) / first) * 100;
}

/** 年化波动率 %（由日收益标准差推得） */
export function annualVolatility(candles: Candle[]): number | null {
  if (candles.length < 20) return null;
  const rets: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    if (prev > 0) rets.push(Math.log(candles[i].close / prev));
  }
  if (rets.length < 10) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varr * 244) * 100;
}

/** 最大回撤 %（负数） */
export function maxDrawdown(candles: Candle[]): number | null {
  if (candles.length === 0) return null;
  let peak = candles[0].close;
  let mdd = 0;
  for (const c of candles) {
    if (c.close > peak) peak = c.close;
    const dd = (c.close - peak) / peak;
    if (dd < mdd) mdd = dd;
  }
  return mdd * 100;
}

/* ---------------------------------------------------------- 股息率 */

/**
 * 逐日 TTM 股息率（%）：
 *   dy_t = 过去 365.25 天内除权除息的每股现金分红合计 ÷ 不复权收盘价_t × 100
 * 注意：分子为名义分红、分母为不复权价，口径一致；无分红记录（上市不足一年或从未分红）为 null。
 */
export function buildDividendYieldByDate(
  dividends: DividendEvent[],
  rawCandles: Candle[],
): Map<string, number> {
  const out = new Map<string, number>();
  const events = [...dividends].sort((a,b) => a.exDate.localeCompare(b.exDate));
  for (const c of rawCandles) {
    if (!(c.close > 0)) continue;
    const time = Date.parse(c.date);
    const perShare = events.filter(e => e.perShare > 0 && e.exDate <= c.date && Date.parse(e.exDate) > time - 365.25 * 864e5)
      .reduce((sum,e) => {
        const split = events.filter(x => x.exDate >= e.exDate && x.exDate <= c.date)
          .reduce((factor,x) => factor * (1 + (x.perShareStock ?? 0)), 1);
        return sum + e.perShare / split;
      }, 0);
    out.set(c.date, perShare / c.close * 100);
  }
  return out;
}

/**
 * 按分红/送转事件把**不复权**日线回填为后复权序列（仅用于画图，估值仍用不复权价）。
 * 分红或送转发生时，次日价格会出现除权缺口；直接用不复权价会让曲线出现假跌。
 *   factor = (前收 − 每股现金分红) / (前收 × (1 + 每股送转))
 * 与行情软件的「后复权」一致：最新价保持原值，历史价按因子累乘放大。
 */
export function adjustCandlesForChart(
  candles: Candle[],
  dividends: DividendEvent[],
): { candles: Candle[]; gaps: number } {
  if (candles.length === 0) return { candles, gaps: 0 };
  const events = dividends
    .filter((e) => (e.perShare > 0 || (e.perShareStock ?? 0) > 0) && /^\d{4}-\d{2}-\d{2}$/.test(e.exDate))
    .sort((a, b) => a.exDate.localeCompare(b.exDate));
  if (events.length === 0) return { candles, gaps: 0 };

  const factorFrom = new Map<string, number>();
  let gaps = 0;
  for (const e of events) {
    // 找除权日前最后一个交易日
    let idx = -1;
    for (let i = candles.length - 1; i >= 0; i--) {
      if (candles[i].date < e.exDate) {
        idx = i;
        break;
      }
    }
    if (idx < 0) continue;
    const prevClose = candles[idx].close;
    if (!(prevClose > 0)) continue;
    const stock = e.perShareStock ?? 0;
    const f = (prevClose - e.perShare) / (prevClose * (1 + stock));
    if (!Number.isFinite(f) || f <= 0 || f > 1.0001) continue;
    if (f < 0.9999) gaps += 1;
    factorFrom.set(candles[idx].date, f);
  }
  if (factorFrom.size === 0) return { candles, gaps: 0 };

  const out: Candle[] = new Array(candles.length);
  let acc = 1;
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    out[i] = {
      ...c,
      open: r2(c.open * acc),
      high: r2(c.high * acc),
      low: r2(c.low * acc),
      close: r2(c.close * acc),
    };
    acc *= factorFrom.get(c.date) ?? 1;
  }
  return { candles: out, gaps };
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

