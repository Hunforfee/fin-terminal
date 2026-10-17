/**
 * 历史估值序列（真实财报口径）。
 *
 * 与「用当前 EPS 按增速倒推」的估算做法不同，这里用**已披露的定期报告**
 * 还原每个交易日当时真正可得的 TTM 净利润与每股净资产：
 *
 *   净利润 TTM 拼接（按法定披露截止日次日生效）：
 *     05-01 ~ 08-31：一季报累计 × 4
 *     09-01 ~ 10-31：中报累计 × 2
 *     11-01 ~ 次年 04-30：三季报 + 上年年报 − 上年三季度
 *     次年 05-01 起：年报
 *   净资产 / BPS：直接用当期披露的每股净资产（送转、增发已体现在披露值中）
 *
 * PE 需要「当时股价 ÷ 当时 EPS」，因此：
 *   股本(t) = 净资产(t) ÷ BPS(t)        （同一报告期两个披露值，口径自洽）
 *   EPS(t)  = 净利润TTM(t) ÷ 股本(t)
 *   市值(t) = 不复权收盘价(t) × 股本(t)
 *
 * 关键：价格必须用**不复权**收盘价。用前复权价会因历史除权除息而系统性
 * 低估历史股价，从而把历史 PE 画低、把当前分位画高——这正是与理杏仁
 * 走势不一致的根因。
 */

import type { Candle, SeriesStats, Valuation, ValuationPoint } from './datasource/types';
import type { PeriodFinancial, ShareChange } from './datasource/sinaFinance';
import type { FinStatementPoint } from './datasource/sinaFinStatements';
import { sharesAt } from './datasource/sinaFinance';

/**
 * 报告期 → 生效日（法定披露截止日次日）。
 * 三处日历条件变量用于「可复现」对比：默认 A 股法定截止日口径。
 */
export interface CalendarOpts {
  /** 一季报生效日 MM-DD（默认 05-01） */
  q1?: string;
  /** 中报生效日 MM-DD（默认 09-01） */
  h1?: string;
  /** 三季报生效日 MM-DD（默认 11-01） */
  q3?: string;
  /** 年报生效日规则：'may'（次年 5/1，默认）| 'jan'（次年 1/1） */
  annual?: 'may' | 'jan';
}

export function effectiveDate(reportDate: string, o: CalendarOpts = {}): string {
  const y = Number(reportDate.slice(0, 4));
  const md = reportDate.slice(5);
  if (md === '03-31') return `${y}-${o.q1 ?? '05-01'}`;
  if (md === '06-30') return `${y}-${o.h1 ?? '09-01'}`;
  if (md === '09-30') return `${y}-${o.q3 ?? '11-01'}`;
  return `${y + 1}-${o.annual === 'jan' ? '01-01' : '05-01'}`;
}

/**
 * 新版时间轴：直接用**三大报表**的归母净利润 + 期末总股本（实收资本反推）。
 *
 * 与旧版（buildFinancialTimeline）的区别：
 *   1. 分子用「归属于母公司所有者的净利润」（理杏仁/同花顺 PE 口径），不是含少数股东损益的净利润；
 *   2. 分母股本取**该报告期期末股本**（资产负债表实收资本 ÷ 面值），不用当前股本，
 *      送转股的历史 PE 因此不会被放大；
 *   3. 支持自定义「生效日历」，用于复现不同数据商的 TTM 拼接口径。
 */
export function buildTimelineFromStatements(
  points: FinStatementPoint[],
  opts: { calendar?: CalendarOpts } = {},
): FinPoint[] {
  const npByDate = new Map<string, number>();
  const shByDate = new Map<string, number>();
  const eqByDate = new Map<string, number>();
  for (const p of points) {
    const np = p.npParent ?? p.npTotal;
    if (np !== null) npByDate.set(p.date, np);
    if (p.sharesYi !== null) shByDate.set(p.date, p.sharesYi);
    const eq = p.equityParent ?? p.equityTotal;
    if (eq !== null) eqByDate.set(p.date, eq);
  }
  const dates = Array.from(npByDate.keys()).sort();
  const out: FinPoint[] = [];
  for (const d of dates) {
    const y = Number(d.slice(0, 4));
    const md = d.slice(5);
    const np = npByDate.get(d) as number;
    const prev = npByDate.get(`${y - 1}-12-31`);
    let npTTM: number | null = null;
    if (md === '03-31') {
      // TTM(Q1) = 今年Q1 + 上年年报 − 上年Q1（四个单季 = 上年Q2~Q4 + 今年Q1）
      const q1 = npByDate.get(`${y - 1}-03-31`);
      npTTM = prev !== undefined && q1 !== undefined ? np + prev - q1 : null;
    } else if (md === '06-30') {
      const h1 = npByDate.get(`${y - 1}-06-30`);
      npTTM = prev !== undefined && h1 !== undefined ? np + prev - h1 : null;
    } else if (md === '09-30') {
      const q3 = npByDate.get(`${y - 1}-09-30`);
      npTTM = prev !== undefined && q3 !== undefined ? np + prev - q3 : null;
    } else {
      npTTM = np;
    }
    if (npTTM === null || npTTM <= 0) continue;

    let sharesYi = shByDate.get(d) ?? null;
    if (sharesYi === null) {
      const known = dates.filter((x) => x <= d && shByDate.has(x));
      sharesYi = known.length ? (shByDate.get(known[known.length - 1]) as number) : null;
    }
    if (sharesYi === null || sharesYi <= 0) continue;

    const equity = eqByDate.get(d) ?? null;
    out.push({
      eff: effectiveDate(d, opts.calendar),
      report: d,
      eps: np / (sharesYi * 1e8),
      epsTTM: npTTM / (sharesYi * 1e8),
      bps: equity !== null ? equity / (sharesYi * 1e8) : null,
      shares: sharesYi,
      npTTM: npTTM / 1e8,
    });
  }
  // 注意：不能用「生效日去重」——年报与次年一季报的生效日都是 5/1，
  // 去重会把更新的季报点丢掉，导致整年沿用上一年的年报 EPS（历史 PE 突然跳高）。
  return out.sort((a, b) => a.report.localeCompare(b.report));
}

export interface FinPoint {
  /** 生效日 YYYY-MM-DD */
  eff: string;
  /** 报告期 */
  report: string;
  /** 报告期累计每股收益（元） */
  eps: number | null;
  /** TTM 每股收益（元，由累计值拼接） */
  epsTTM: number | null;
  /** 每股净资产（元） */
  bps: number | null;
  /** 报告期总股本（亿股） */
  shares: number | null;
  /** TTM 净利润（亿元） */
  npTTM: number | null;
}

/** 报告期净利润（元） */
export interface ProfitPoint {
  date: string;
  netProfit: number;
}

/**
 * 把「利润表净利润 + 总股本变动史」转成「生效日 → TTM EPS / BPS / 股本」。
 *
 * TTM 一律按**最近四个单季**滚动（与主流数据商 PE-TTM 口径一致）：
 *   Q1     ：今年Q1 + 上年年报 − 上年Q3
 *   中报   ：今年中报 + 上年年报 − 上年中报
 *   三季报 ：今年三季报 + 上年年报 − 上年三季报
 *   年报   ：今年年报
 * 不用「累计 ×4 / ×2」年化 —— 白酒等季节性行业会被系统性高估、低估历史 PE。
 *
 * 分母用**利润表净利润 ÷ 该报告期股本**，而不是网页上的 EPS：
 * 新浪 EPS 在送转/追溯调整时会换口径（五粮液 2025 年报 EPS 2.40 vs 三季报 5.72），
 * 净利润金额本身才是一直可比的。
 */
export function buildFinancialTimeline(
  periods: PeriodFinancial[],
  profits: ProfitPoint[],
  shares: ShareChange[] = [],
): FinPoint[] {
  const bpsByDate = new Map(periods.map((p) => [p.date, p.bps]));
  const npByDate = new Map(profits.map((p) => [p.date, p.netProfit]));
  const sharesByReport = new Map<string, number | null>();
  for (const p of profits) {
    const wan = sharesAt(shares, p.date);
    sharesByReport.set(p.date, wan !== null ? wan / 1e4 : null); // 万股 → 亿股
  }

  const out: FinPoint[] = [];
  for (const p of profits) {
    const y = Number(p.date.slice(0, 4));
    const md = p.date.slice(5);
    const np = p.netProfit; // 元
    const annual = npByDate.get(`${y - 1}-12-31`) ?? null;
    let npTTM: number | null = null;

    if (md === '03-31') {
      // TTM(Q1) = 今年Q1 + 上年年报 − 上年Q1（不是 − 上年Q3！四个单季 = 上年Q2~Q4 + 今年Q1）
      const prevQ1 = npByDate.get(`${y - 1}-03-31`) ?? null;
      npTTM = annual !== null && prevQ1 !== null ? np + annual - prevQ1 : null;
    } else if (md === '06-30') {
      const prevH1 = npByDate.get(`${y - 1}-06-30`) ?? null;
      npTTM = annual !== null && prevH1 !== null ? np + annual - prevH1 : null;
    } else if (md === '09-30') {
      const prevQ3 = npByDate.get(`${y - 1}-09-30`) ?? null;
      npTTM = annual !== null && prevQ3 !== null ? np + annual - prevQ3 : null;
    } else if (md === '12-31') {
      npTTM = np;
    }
    if (npTTM === null || npTTM <= 0) continue; // 亏损期不给 PE（保持 PE > 0 的常规定义）

    const sh = sharesByReport.get(p.date) ?? null;
    // 该报告期股本；缺失时用最近的已知股本
    let sharesYi = sh;
    if (sharesYi === null) {
      const known = [...sharesByReport.entries()].filter(([d]) => d <= p.date && sharesByReport.get(d));
      sharesYi = known.length ? (known[known.length - 1][1] as number) : null;
    }
    if (sharesYi === null || sharesYi <= 0) continue;

    const epsTTM = npTTM / (sharesYi * 1e8); // 元/股

    out.push({
      eff: effectiveDate(p.date),
      report: p.date,
      eps: np / (sharesYi * 1e8),
      epsTTM,
      bps: bpsByDate.get(p.date) ?? null,
      shares: sharesYi,
      npTTM: npTTM / 1e8,
    });
  }

  // 先按报告期排序（新报告期必然后生效），再清掉生效日相同的旧点：
  // 年报与次年一季报的生效日都是 5/1，若按生效日排序会把更新的季报点挤掉，
  // 导致整年沿用上年年报 EPS —— 这是历史 PE 突然跳高的元凶。
  out.sort((a, b) => a.report.localeCompare(b.report));
  const dedup: FinPoint[] = [];
  for (const p of out) {
    if (dedup.length > 0 && dedup[dedup.length - 1].eff === p.eff) dedup[dedup.length - 1] = p;
    else dedup.push(p);
  }
  return dedup.sort((a, b) => a.eff.localeCompare(b.eff));
}

/**
 * 构建历史估值序列。
 * @param candles 不复权日线（可含财报覆盖之前的日期，函数会自行裁剪）
 * @param timeline buildFinancialTimeline 的结果
 * @param dyByDate 股息率（按日期）
 */
export function buildRealValuationSeries(
  candles: Candle[],
  timeline: FinPoint[],
  opts?: { dyByDate?: Map<string, number> },
): ValuationPoint[] {
  if (candles.length === 0 || timeline.length === 0) return [];
  const out: ValuationPoint[] = [];
  let ti = -1;
  for (const c of candles) {
    while (ti + 1 < timeline.length && timeline[ti + 1].eff <= c.date) ti++;
    if (ti < 0) continue; // 财报覆盖之前不画，避免无分母的长尾
    const f = timeline[ti];

    let pe: number | null = null;
    if (f.epsTTM !== null && f.epsTTM > 0) {
      const v = c.close / f.epsTTM;
      // 过滤极端值：亏损转盈、重组导致的分母异常
      if (Number.isFinite(v) && v > 0 && v < 2000) pe = round2(v);
    }
    const pb = f.bps !== null && f.bps > 0 ? round2(c.close / f.bps) : null;

    out.push({
      date: c.date,
      pe,
      pb: pb !== null && Number.isFinite(pb) && pb > 0 && pb < 500 ? pb : null,
      close: c.close,
      dy: opts?.dyByDate?.get(c.date) ?? null,
    });
  }
  return out;
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 升序数组中 v 的百分位（0-100） */
function percentileOf(sortedAsc: number[], v: number): number {
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

/** 线性插值分位值 */
function quantile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const pos = (sortedAsc.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  const w = pos - lo;
  return sortedAsc[lo] * (1 - w) + sortedAsc[hi] * w;
}

function seriesStats(values: (number | null)[], current: number | null): SeriesStats {
  const arr = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const s = [...arr].sort((a, b) => a - b);
  const r = (v: number | null) => (v === null ? null : round2(v));
  return {
    current: r(current),
    percentile:
      current !== null && s.length > 5 && current > 0 ? Math.round(percentileOf(s, current) * 10) / 10 : null,
    p80: r(quantile(s, 0.8)),
    p50: r(quantile(s, 0.5)),
    p20: r(quantile(s, 0.2)),
    max: r(s.length ? s[s.length - 1] : null),
    avg: r(s.length ? s.reduce((a, b) => a + b, 0) / s.length : null),
    min: r(s.length ? s[0] : null),
    count: s.length,
  };
}

/**
 * 用真实历史序列汇总出页面上要展示的当前值 / 分位 / 分位值。
 * @param history 已按区间裁剪的估值序列
 */
export function summarizeReal(
  history: ValuationPoint[],
  q: { pe: number | null; pb: number | null; price: number | null; totalMarketCap?: number | null },
  opts: { years: number; epsTTM?: number | null; bps?: number | null },
): ReturnType<typeof pickValuation> {
  const last = history[history.length - 1];
  const peSeries = history.map((h) => h.pe);
  const pbSeries = history.map((h) => h.pb);
  const dySeries = history.map((h) => h.dy);

  // 当前值优先用行情（与收盘价同步、口径实时），缺失时退回序列末值
  const pe = q.pe ?? last?.pe ?? null;
  const pb = q.pb ?? last?.pb ?? null;
  const dyLast = [...dySeries].reverse().find((v) => v !== null) ?? null;

  const peStats = seriesStats(peSeries, pe);
  const pbStats = seriesStats(pbSeries, pb);
  const dyStats = seriesStats(dySeries, dyLast);

  // 净利润 / 净资产：市值 ÷ PE(或 PB)，与序列分母同口径
  const mc = q.totalMarketCap ?? null;
  const np = mc !== null && pe !== null && pe > 0 ? round2(mc / pe) : null;
  const na = mc !== null && pb !== null && pb > 0 ? round2(mc / pb) : null;

  return pickValuation({
    pe: pe === null ? null : round2(pe),
    pb: pb === null ? null : round2(pb),
    pePercentile: peStats.percentile,
    pbPercentile: pbStats.percentile,
    dividendYield: dyLast,
    dyPercentile: dyStats.percentile,
    roe: pe && pb ? round2((pb / pe) * 100) : null,
    netProfit: np,
    netAssets: na,
    history,
    basis: 'real',
    years: opts.years,
    stats: { pe: peStats, pb: pbStats, dy: dyStats, from: history[0]?.date ?? '', to: last?.date ?? '' },
  });
}

function pickValuation(v: {
  pe: number | null;
  pb: number | null;
  pePercentile: number | null;
  pbPercentile: number | null;
  dividendYield: number | null;
  dyPercentile: number | null;
  roe: number | null;
  netProfit: number | null;
  netAssets: number | null;
  history: ValuationPoint[];
  basis: 'real' | 'estimate';
  years: number;
  stats: Valuation['stats'];
}) {
  return v;
}

/**
 * 「当日披露口径」时间轴（理杏仁公司估值默认采用的口径）。
 *
 * 与 buildTimelineFromStatements 的差别只在**生效时机**：
 * 每个报告期从「数据披露之后」才开始使用，而不是等到法定截止日的次日。
 * 披露日采用可获得的近似值：
 *   - 若能取到真实公告日（reportDates 命中）→ 公告日 + 1 天生效；
 *   - 否则按报告期的典型披露滞后（lagDays）估算（一季报 ~28 天、中报 ~58 天、三季报 ~28 天、年报 ~95 天）。
 *
 * 另外每个交易日优先使用「最近一个已披露报告期」的 TTM 净利润，
 * 这正是理杏仁文档中「出了即纳入」的做法，因此曲线在财报季逐家跳变，
 * 而不是像「截止日后统一切换」那样一次性跳变。
 */
export function buildDisclosureTimeline(
  points: FinStatementPoint[],
  opts: { lagDays?: Partial<Record<'03-31' | '06-30' | '09-30' | '12-31', number>>; reportDates?: Map<string, string> } = {},
): (FinPoint & { eff: string })[] {
  const base = buildTimelineFromStatements(points);
  const lag = { '03-31': 28, '06-30': 58, '09-30': 28, '12-31': 95, ...opts.lagDays };
  const shift = (d: string, days: number) => {
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + days);
    return t.toISOString().slice(0, 10);
  };
  return base.map((p) => {
    const md = p.report.slice(5) as '03-31' | '06-30' | '09-30' | '12-31';
    const real = opts.reportDates?.get(p.report);
    const eff = real ? shift(real, 1) : shift(p.report, lag[md] ?? 60);
    return { ...p, eff };
  });
}
