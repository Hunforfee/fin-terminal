import { cachedMarketInput } from '../marketInputs';
import { seriesStats } from '../valuation';
import { fetchJson } from './http';
import { sumFiscalYearDividend, type HkDividendRecord } from './hkDividends';
import type { Candle, Valuation, ValuationPoint } from './types';

export type HkHistoryMetric = 'pe' | 'pb';
export interface HkRatioHistory {
  symbol: string;
  metric: HkHistoryMetric;
  years: number;
  provider: 'baidu';
  rows: { date: string; value: number | null }[];
}
const labels = { pe: '市盈率(TTM)', pb: '市净率' } as const;
const isoDate = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const todayOf = (now: number) => new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
const startOf = (years: number, now: number) => {
  const d = new Date(now + 8 * 3600e3), month = d.getUTCMonth();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  if (d.getUTCMonth() !== month) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};
export const hkRatioHistoryKey = (symbol: string, metric: HkHistoryMetric, years: number) =>
  `source-hk-valuation:v1:${symbol}:${metric}:${years}`;

/** Source observations only: never forward-fill or turn report-end dates into announcement dates. */
export function parseHkRatioHistory(payload: unknown, code: string, metric: HkHistoryMetric, years: number, now = Date.now()): HkRatioHistory {
  const response = payload as any;
  const result = response?.Result?.[0]?.DisplayData?.resultData?.tplData?.result;
  const chart = result?.chartInfo?.[0];
  if (String(result?.code) !== code || chart?.header?.[0] !== labels[metric] || !Array.isArray(chart?.body))
    throw Error(`港股历史${labels[metric]}来源返回了错误证券或指标`);
  const byDate = new Map<string, number | null>();
  const start = startOf(years, now), today = todayOf(now);
  for (const row of chart.body) {
    if (!Array.isArray(row) || row.length !== 2 || !isoDate(row[0])) throw Error('港股历史估值日期或行格式无效');
    const [date, raw] = row;
    if (date < start || date > today) continue;
    const n = typeof raw === 'number' || typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
    // Losses, negative equity and missing values remain gaps, never zero or an older profitable value.
    const value = Number.isFinite(n) && n > 0 ? n : null;
    if (byDate.has(date) && byDate.get(date) !== value) throw Error('港股历史估值同日数据冲突');
    byDate.set(date, value);
  }
  const rows = [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
  if (!rows.length) throw Error(`港股历史${labels[metric]}暂无所选区间数据`);
  return { symbol: `hk${code}`, metric, years, provider: 'baidu', rows };
}

export function fetchHkRatioHistory(symbol: string, metric: HkHistoryMetric, years: number): Promise<HkRatioHistory> {
  if (!/^hk\d{5}$/.test(symbol) || !(metric in labels) || ![5, 10].includes(years)) throw Error('港股历史估值参数无效');
  const code = symbol.slice(2);
  return cachedMarketInput(hkRatioHistoryKey(symbol, metric, years), 'source-hk-valuation', 'baidu:reported-historical-ratios', 6 * 3600e3, async () => {
    const url = new URL('https://finance.baidu.com/opendata');
    url.search = new URLSearchParams({ openapi: '1', dspName: 'iphone', tn: 'tangram', client: 'app',
      query: labels[metric], code, word: '', resource_id: '51171', market: 'hk', tag: labels[metric],
      chart_select: years === 5 ? '近五年' : '近十年', industry_select: '', skip_industry: '1', finClientType: 'pc' }).toString();
    return parseHkRatioHistory(await fetchJson(url.toString(), { timeoutMs: 8000, retries: 0,
      headers: { Referer: `https://gushitong.baidu.com/stock/hk-${code}` } }), code, metric, years);
  }, value => {
    if (value.symbol !== symbol || value.metric !== metric || value.years !== years || value.provider !== 'baidu'
      || !Array.isArray(value.rows) || !value.rows.length
      || value.rows.some((r, i) => !isoDate(r.date) || i > 0 && r.date <= value.rows[i - 1].date
        || r.value !== null && (!Number.isFinite(r.value) || r.value <= 0))) throw Error('港股历史估值存储输入未通过校验');
  });
}

/** PE/PB source samples and fiscal-year cash yields have separate dates and separate failure states. */
export function attachHkValuationHistory(snapshot: Valuation, inputs: {
  pe: HkRatioHistory | null; pb: HkRatioHistory | null;
  prices?: Candle[]; dividends?: HkDividendRecord[] | null;
}, now = Date.now()): Valuation {
  const start = startOf(snapshot.years ?? 5, now), today = todayOf(now);
  const prices = (inputs.prices ?? []).filter(c => isoDate(c.date) && c.date >= start && c.date <= today && c.close > 0 && Number.isFinite(c.close));
  const byDate = new Map(prices.map(c => [c.date, c]));
  const histories: Record<'pe' | 'pb' | 'dy', ValuationPoint[]> = { pe: [], pb: [], dy: [] };
  const reasons: Partial<Record<'pe' | 'pb' | 'dy', string>> = {};
  const asOf: Partial<Record<'pe' | 'pb' | 'dy', string>> = {};
  for (const metric of ['pe', 'pb'] as const) {
    histories[metric] = (inputs[metric]?.rows ?? []).filter(r => r.date >= start && r.date <= today).map(r => ({
      date: r.date, pe: metric === 'pe' ? r.value : null, pb: metric === 'pb' ? r.value : null,
      dy: null, close: byDate.get(r.date)?.close ?? null, rawClose: byDate.get(r.date)?.close,
    }));
    asOf[metric] = histories[metric].at(-1)?.date;
    if (!histories[metric].some(r => r[metric] !== null)) reasons[metric] = `历史${labels[metric]}暂缺或有效样本不足；不影响其他指标。`;
    else if (asOf[metric]! < today && Date.parse(today) - Date.parse(asOf[metric]!) > 7 * 864e5)
      reasons[metric] = `历史${labels[metric]}仅更新至 ${asOf[metric]}，不代表当前估值。`;
  }
  // Unknown announcement dates cannot establish what was known on a historical day.
  const verifiedEvents = inputs.dividends?.filter(d => isoDate(d.noticeDate)) ?? null;
  if (verifiedEvents?.length) histories.dy = prices.map(c => {
    const fiscal = sumFiscalYearDividend(verifiedEvents, c.date);
    const value = fiscal.complete && fiscal.ttmDps !== null ? fiscal.ttmDps / c.close * 100 : null;
    return { date: c.date, pe: null, pb: null, close: c.close, rawClose: c.close,
      dy: value !== null && Number.isFinite(value) ? value : null };
  });
  asOf.dy = histories.dy.at(-1)?.date;
  if (!histories.dy.some(r => r.dy !== null)) reasons.dy = '历史股息率需要不复权价格，以及已核实公告日、除息日和港元金额的完整财年派息记录；当前输入不足，其他估值走势仍可查看。';
  const stats = Object.fromEntries((['pe', 'pb', 'dy'] as const).map(metric => [metric,
    seriesStats(histories[metric].map(r => r[metric]), metric === 'dy' ? snapshot.dividendYield : histories[metric].at(-1)?.[metric] ?? null),
  ])) as Pick<NonNullable<Valuation['stats']>, 'pe' | 'pb' | 'dy'>;
  const union = new Map<string, ValuationPoint>();
  for (const metric of ['pe', 'pb', 'dy'] as const) for (const row of histories[metric]) {
    const old = union.get(row.date) ?? { ...row, pe: null, pb: null, dy: null };
    old[metric] = row[metric]; union.set(row.date, old);
  }
  const history = [...union.values()].sort((a, b) => a.date.localeCompare(b.date));
  const dates = history.map(r => r.date);
  return { ...snapshot, history, historyByMetric: histories, historyBasis: 'provider', historyMetricAsOf: asOf,
    historyUnavailableReasons: reasons, historyUnavailableReason: undefined,
    priceAdjust: 'none', source: `${snapshot.source} + baidu-hk-history + implemented-HKD-dividends`,
    // Current cards retain the shared live snapshot. Never compare its PE/PB to another source's sample set.
    pePercentile: null, pbPercentile: null, dyPercentile: stats.dy.percentile,
    stats: { ...stats, from: dates[0] ?? today, to: dates.at(-1) ?? today },
    warnings: [...(snapshot.warnings ?? []).filter(w => !w.includes('不回填历史曲线')),
      '历史 PE-TTM、PB 为百度股市通返回的估值观测值，并非本站按历史公告逐日复算。分位按源端返回的采样日期统计，不插值为逐交易日数据。',
      '当前估值卡片沿用东财财务与最新股价；历史统计中的末值和分位采用历史数据源自身口径，可能与当前卡片不同。',
      '港股历史股息率仅使用当时已公告且已除息的完整财年港元现金分红与同日不复权收盘价；缺失不填零。',
      ...Object.values(reasons)],
  };
}

export function hkValuationHistoryCovered(value: Valuation, from: string, to: string): boolean {
  return (['pe', 'pb'] as const).every(metric => {
    const rows = value.historyByMetric?.[metric] ?? [];
    return rows.filter(r => r[metric] !== null).length >= 10 && Date.parse(rows[0]?.date) - Date.parse(from) <= 14 * 864e5
      && Date.parse(to) - Date.parse(rows.at(-1)!.date) <= 7 * 864e5;
  });
}
