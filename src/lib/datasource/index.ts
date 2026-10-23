import { HISTORY_YEARS } from '../marketHistoryPlan';
import { crossCheckMainlandRaw, MarketDataConflict } from '../klineCrossCheck';
import { databaseOnly } from '../marketReadPolicy';
import { withMarketReadStatus } from '../marketReadContext';
import { getMarketStore, getMarketReadStore } from '../marketStore';
import { readStoredFinancialSummary } from '../storedFinancialSummary';
import { readRemoteMarketData, remoteMarketDataEnabled } from '../marketDataClient';
import { cachedValuationResult, valuationInputVersion, type ValuationCacheOptions } from '../valuationResultCache';
import { sharedQuotes } from '../quoteInputs';
import { searchSources } from '../searchSources';
import { getValuationPlans, getValuationDividends } from '../valuationInputs';
import { getFinancialHistoryInput } from '../financialHistoryInputs';
import { fetchHkRatioHistory, attachHkValuationHistory } from './hkValuationHistory';
import { getWatchlistFinancialInputs, WATCHLIST_FINANCIAL_FIELDS } from '../watchlistFinancialInputs';
import { cachedMarketInput as storedMarketInput, validateDatedRows } from '../marketInputs';
import { storedKLine, validateKLine, readDatabaseKLine } from '../klineStorage';
import { fetchDisclosureDates } from './disclosures';
/**
 * 数据源编排层 —— 全站唯一的数据入口。
 *
 * 职责：
 *   1. 串联多个 Provider，按优先级 fallback（腾讯 → 新浪 → 本地快照）；
 *   2. 统一 TTL 缓存，避免同一标的被重复抓取；
 *   3. 并发分块，把上百只股票的行情压缩成几次批量请求；
 *   4. 暴露 health()，让页面能如实展示每个数据源的可用状态。
 *
 * 上层（页面 / 组件 / API Route）只 import 本文件，不直接碰具体 Provider。
 */

import * as tencent from './tencent';
import * as sina from './sina';
import * as eastmoney from './eastmoney';
import * as eastmoneyKline from './eastmoneyKline';
import * as ifind from './ifind';
import * as snapshot from './snapshot';
import * as hkFinance from './hkFinance';
import * as profile from './profile';
import { getValueScreenMeta, runValueScreen } from './valueScreen';
import {
  fetchHkFundamental, fetchHkFundamentals, fetchHkDividends, computeHkValuation,
  type HkFundamental, type HkValuation,
} from './hkFundamental';
import { cached, defaultTtl, putCache } from './cache';
import { normalizeCode, normalizeStockCode } from './codes';
import { computeValuation, buildFinancialSummary } from '../analytics';
import * as sinaBonus from './sinaBonus';
import { fetchDividendPlans } from './dividendPlans';
import { buildExpectedDividendYieldByDate } from '../dividends';
import type { DividendEvent } from './sinaBonus';
import * as sinaFinance from './sinaFinance';
import type { PeriodFinancial, ShareChange } from './sinaFinance';
import {
  buildDisclosureTimeline,
  effectiveDate,
  buildFinancialTimeline,
  buildRealValuationSeries,
  buildTimelineFromStatements,
  summarizeReal,
  seriesStats,
} from '../valuation';
import { buildDividendYieldByDate, adjustCandlesForChart } from '../analytics';
import type { Candle, SeriesStats, Valuation, ValuationMethod, ValuationPoint, ValuationStats } from './types';
import { INDICES, STOCKS, FUNDS, peersOf, industryOf } from '../universe';
import type {
  FinancialSummary,
  KLineSeries,
  MarketOverview,
  MinutePoint,
  PeerRow,
  Period,
  ProviderStatus,
  Quote,
  ScreenCriteria,
  SearchHit,
  Adjust,
} from './types';

const CHUNK = 50;

/** N 年前的 YYYY-MM-DD（用于 K 线起始日期 / 区间截取） */
function ymdYearsAgo(years: number): string {
  const d = new Date(Date.now() + 8 * 3600_000);
  const whole = Math.floor(years);
  d.setUTCFullYear(d.getUTCFullYear() - whole);
  d.setTime(d.getTime() - Math.round((years - whole) * 365.25) * 864e5);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ 搜索 */

/** 代码 / 名称 / 拼音搜索：东财联想 → 腾讯联想 → 本地池兜底 */
export async function search(keyword: string): Promise<SearchHit[]> {
  if (remoteMarketDataEnabled()) return readRemoteMarketData<SearchHit[]>('search', { q: keyword });
  const kw = keyword.trim().toLowerCase();
  if (!kw) return [];
  return cached(`search-markets-v3:${kw}`, 5 * 60 * 1000, () => searchSources([
    signal=>eastmoney.fetchSearch(kw,12,signal),
    signal=>tencent.fetchSearch(kw,signal),
  ],localSearch(kw)),{staleOnError:false});
}

function localSearch(kw: string): SearchHit[] {
  const lower = kw.toLowerCase();
  const out: SearchHit[] = [];
  const tryPush = (code: string, name: string, kind: SearchHit['kind'], board: string) => {
    if (!code.includes(lower) && !name.toLowerCase().includes(lower)) return;
    const n = kind === 'stock' ? normalizeStockCode(code) : normalizeCode(code);
    if (!n) return;
    out.push({
      code,
      symbol: n.symbol,
      name,
      market: n.market,
      kind,
      board,
      secid: n.secid,
    });
  };
  for (const i of INDICES) tryPush(i.code, i.name, 'index', '指数');
  for (const s of STOCKS) tryPush(s.code, s.name, 'stock', s.board);
  for (const f of FUNDS) tryPush(f.code, f.name, 'fund', f.board);
  return out.slice(0, 12);
}

/* ------------------------------------------------------------------ 行情 */

/** 单标的实时行情 */
export async function getQuote(input: string): Promise<Quote | null> {
  return withMarketReadStatus(()=>getQuoteData(input));
}
async function getQuoteData(input: string): Promise<Quote | null> {
  if (remoteMarketDataEnabled()) return readRemoteMarketData<Quote>('quote', { code: input });
  const n = normalizeCode(input);
  if (!n) return null;
  const ttl = defaultTtl(n.market === 'HK' ? 'HK' : 'A');
  const key = `quote:${n.symbol}${n.market === 'HK' ? `:hk-hours-v1:${ttl}` : ''}`;
  const quote = await cached(key, ttl, async () => {
    try {
      const q = (await fetchQuotesRaw([n.symbol]))[0];
      if (q) return q;
    } catch {
      /* 落到下一级 */
    }
    try {
      const list = await sina.fetchQuotes([n.symbol]);
      if (list[0]) return list[0];
    } catch {
      /* 落到下一级 */
    }
    const snap = await snapshot.snapshotQuote(n.symbol);
    if (snap) return snap;
    throw new Error(`无法获取 ${n.symbol} 行情：所有数据源均不可用`);
  });
  return n.market === 'HK' ? (await withHkValuation([quote]))[0] : quote;
}

/** 批量行情：分块并发 + 逐块降级 */
export async function getQuotes(inputs: string[]): Promise<Quote[]> {
  return withMarketReadStatus(()=>getQuotesData(inputs));
}
async function getQuotesData(inputs: string[]): Promise<Quote[]> {
  if (remoteMarketDataEnabled()) {
    const rows: Quote[] = [];
    for (let at = 0; at < inputs.length; at += 200)
      rows.push(...await readRemoteMarketData<Quote[]>('quote', { codes: inputs.slice(at, at + 200).join(',') }));
    return rows;
  }
  const symbols: string[] = [];
  const map = new Map<string, string>();
  for (const i of inputs) {
    const n = normalizeCode(i);
    if (!n || map.has(n.symbol)) continue;
    map.set(n.symbol, n.code);
    symbols.push(n.symbol);
  }
  if (symbols.length === 0) return [];

  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += CHUNK) chunks.push(symbols.slice(i, i + CHUNK));

  const results = await Promise.all(
    chunks.map((chunk) => {
      const ttl = quoteTtl(chunk);
      const key = `quotes:${chunk.join(',')}${chunk.some((s) => s.startsWith('hk')) ? `:hk-hours-v1:${ttl}` : ''}`;
      return cached(key, ttl, () => fetchQuotesChunk(chunk));
    }),
  );
  return results.flat();
}

/** Industry tables need quotes and HKD PB, without per-security dividend work. */
export async function getIndustryQuotes(inputs: string[]): Promise<Quote[]> {
  if (remoteMarketDataEnabled()) return getQuotes(inputs);
  const normalized = [...new Map(
    inputs.flatMap((input) => {
      const n = normalizeStockCode(input);
      return n ? [[n.symbol, n] as const] : [];
    }),
  ).values()];
  const hk = normalized.filter((n) => n.market === 'HK');
  const mainland = normalized.filter((n) => n.market !== 'HK');
  const mainlandQuotes = getQuotes(mainland.map((n) => n.symbol)).catch(() => []);
  const chunks: string[][] = [];
  for (let i = 0; i < hk.length; i += CHUNK)
    chunks.push(hk.slice(i, i + CHUNK).map((n) => n.symbol));
  const hkTtl = defaultTtl('HK');
  const rawQuotes = mapLimit(chunks, 4, (chunk) =>
    cached(`industry-quotes-raw-v1:${chunk.join(',')}:hk-hours-v1:${hkTtl}`, hkTtl, () =>
      fetchQuotesRaw(chunk),
    ).catch(() => []),
  );

  // The per-security keys are shared with ordinary quotes/detail. A lazy batch
  // starts only when a financial cache miss exists; successful reports keep the
  // normal six-hour TTL, while missing/failed reports are retried after one minute.
  let batch: Promise<Map<string, HkFundamental | null>> | undefined;
  const fundamentals = Promise.all(
    hk.map(async (n) => {
      const f = await storedMarketInput(`hk-main-currency-v4:${n.symbol}`, 'latest-hk-financials', 'eastmoney:main:CNY-input:HKD-book-normalized:provider-implied-fx', 1800e3, async () => {
        batch ??= cached(
          `hk-industry-main-v1:${hk.map((item) => item.code).sort().join(',')}`,
          60_000,
          () => fetchHkFundamentals(hk.map((item) => item.code)),
        );
        const value = (await batch).get(n.code);
        if (!value) throw new Error('港股财务指标暂缺');
        return value;
      }, value => validateDatedRows([value as unknown as Record<string, unknown>], 'reportDate', ['bps', 'peTTM'])).catch(() => null);
      return [n.symbol, f] as const;
    }),
  );
  const [aQuotes, hkQuotes, financials] = await Promise.all([
    mainlandQuotes, rawQuotes, fundamentals,
  ]);
  const financialMap = new Map(financials);
  const allQuotes = new Map(aQuotes.map((quote) => [quote.symbol, quote]));
  for (const quote of hkQuotes.flat()) {
    const valuation = computeHkValuation(financialMap.get(quote.symbol) ?? null, null, quote.stale ? null : quote.price);
    allQuotes.set(quote.symbol, {
      ...quote,
      marketPe: quote.marketPe === undefined ? quote.pe : quote.marketPe,
      pe: valuation.pe,
      pb: valuation.pb,
    });
  }
  return normalized.flatMap((n) => {
    const quote = allQuotes.get(n.symbol);
    return quote ? [quote] : [];
  });
}

/** Mixed baskets refresh while either market trades; A-only baskets keep their TTL. */
function quoteTtl(symbols: string[]): number {
  return symbols.reduce((ttl, symbol) =>
    Math.min(ttl, defaultTtl(symbol.startsWith('hk') ? 'HK' : 'A')), 600_000);
}

/** 受控并发，避免一次打满上游 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

async function fetchQuotesChunk(symbols: string[]): Promise<Quote[]> {
  const got = await fetchQuotesRaw(symbols);
  return withHkValuation(got);
}

/**
 * 只缓存低频的财务与派息记录，PB/股息率始终结合调用方当前行情计算。
 * 列表、单只行情、股息接口与详情页共用此入口，避免价格或股息口径不一致。
 */
export async function getHkCurrentValuation(symbol: string, price: number | null, asOf?: string): Promise<HkValuation> {
  if (remoteMarketDataEnabled()) return readRemoteMarketData<HkValuation>('hk-valuation', { code: symbol, price: price ?? undefined, asOf });
  const n = normalizeStockCode(symbol);
  if (!n || n.market !== 'HK') throw new Error('港股代码无效');
  const [fundamental, dividends] = await Promise.all([
    storedMarketInput(`hk-main-currency-v4:${n.symbol}`, 'latest-hk-financials', 'eastmoney:main:CNY-input:HKD-book-normalized:provider-implied-fx', 1800e3, async () => {
      const value = await fetchHkFundamental(n.code);
      if (!value) throw new Error('港股财务指标暂缺');
      return value;
    }, value => validateDatedRows([value as unknown as Record<string, unknown>], 'reportDate', ['bps', 'peTTM'])).catch(() => null),
    getHkDividendInputs(n.symbol).catch(() => null),
  ]);
  return computeHkValuation(fundamental, dividends, price, asOf);
}

function getHkDividendInputs(symbol: string) {
  const n = normalizeStockCode(symbol)!;
  return storedMarketInput(`hk-dividend-events-v4:${n.symbol}`, 'hk-recent-dividend-events', 'eastmoney:HKD-confirmed-DPS:tax-before:recent-100-events', 1800e3, () => fetchHkDividends(n.code), rows => {
      // 空数组 = 上游已确认该证券无派息记录（从未分红的公司）；只有金额非法才算坏数据。
      // 落库空记录后，覆盖检查不再把「确认无分红」误判为缺失数据。
      if (rows.some(r => r.dps != null && (!Number.isFinite(r.dps) || r.dps < 0))) throw Error('港股分红金额无效');
  });
}

async function withHkValuation(quotes: Quote[]): Promise<Quote[]> {
  const hk = quotes.filter((q) => q.kind === 'stock' && /^hk\d{5}$/.test(q.symbol));
  if (hk.length === 0) return quotes;
  const map = new Map<string, HkValuation>();
  await mapLimit(hk, 4, async (q) => {
    const v = await getHkCurrentValuation(q.symbol, q.stale ? null : q.price);
    map.set(q.symbol, v);
  });
  return quotes.map((q) => {
    const v = map.get(q.symbol);
    return v ? { ...q, marketPe: q.marketPe === undefined ? q.pe : q.marketPe, pe: v.pe, pb: v.pb, dividendYield: v.dividendYield,
      dividendYieldMethod: 'hk-static', dividendFiscalYear: v.fiscalYear,
      dividendPerShare: { ordinary: v.ordinaryDps, special: v.specialDps, total: v.ttmDps } } : q;
  });
}

async function fetchQuotesRaw(symbols: string[]): Promise<Quote[]> {
  return sharedQuotes(symbols,fetchQuotesRawUpstream);
}
async function fetchQuotesRawUpstream(symbols: string[]): Promise<Quote[]> {
  try {
    const got = await tencent.fetchQuotes(symbols);
    if (got.length > 0) {
      // 腾讯偶发漏掉个别代码，缺口用新浪补齐
      const gotSet = new Set(got.map((q) => q.symbol));
      const missing = symbols.filter((s) => !gotSet.has(s));
      if (missing.length > 0) {
        const extra = await sina.fetchQuotes(missing).catch(() => []);
        got.push(...extra);
      }
      return got;
    }
  } catch {
    /* 落到下一级 */
  }
  try {
    const got = await sina.fetchQuotes(symbols);
    if (got.length > 0) return got;
  } catch {
    /* 落到下一级 */
  }
  return snapshot.snapshotQuotes(symbols);
}

/* ------------------------------------------------------------------ K 线 */

export async function getKLine(
  input: string,
  period: Period = 'day',
  adjust: Adjust = 'qfq',
  count = 320,
  startDate?: string,
  recentOnly = false,
): Promise<KLineSeries> {
  if (remoteMarketDataEnabled()) return readRemoteMarketData<KLineSeries>('kline', { code: input, period, adjust, count, start: startDate });
  const n = normalizeCode(input);
  if (!n) throw new Error(`无法解析代码 ${input}`);
  const key = `kline:${n.symbol}:${period}:${adjust}:${count}:${startDate ?? ''}${recentOnly ? ':recent-only' : ''}`;
  const read = () =>
    storedKLine({ symbol: n.symbol, period, adjust, count, start: startDate, recentOnly }, async request => {
      try {
        const value = await tencent.fetchKLine(n.symbol, period, adjust, request.count, request.start, request.end);
        validateKLine(value, request);
        if (adjust === 'none' && n.market !== 'HK' && n.kind === 'stock' && !request.end) {
          try {
            const comparison = await sina.fetchKLine(n.symbol, period, Math.min(80, request.count));
            validateKLine(comparison, request);
            return crossCheckMainlandRaw(value, comparison, new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10));
          } catch (error) {
            if (error instanceof MarketDataConflict) {
              try { await getMarketStore()?.incident(n.symbol, 'cross_source_conflict', error.differences); } catch {}
              throw error;
            }
            return { ...value, warnings: [...(value.warnings ?? []), '备用来源暂不可核对；当前仅通过结构校验。'] };
          }
        }
        return value;
      } catch (error) { if (error instanceof MarketDataConflict) throw error; /* semantic-preserving fallback only */ }
      if (adjust === 'none' && !request.end) {
        try {
          const series = await sina.fetchKLine(n.symbol, period, request.count);
          validateKLine(series, request);
          return { ...series, candles: series.candles.filter(c => !request.start || c.date >= request.start).slice(-request.count) };
        } catch { /* historical snapshot remains explicitly stale */ }
      }
      try{
        const value=await eastmoneyKline.fetchKLine(n.symbol,period,adjust,request.count,request.start,request.end);
        validateKLine(value,request);return value;
      }catch{ /* Unavailable is never substituted with another adjustment basis. */ }
      const snap = await snapshot.snapshotKLine(n.symbol, period);
      if (snap && snap.adjust === adjust) return { ...snap, stale: true, complete: false,
        candles: snap.candles.filter(c => (!request.start || c.date >= request.start) && (!request.end || c.date <= request.end)).slice(-request.count) };
      throw new Error(`无法获取 ${n.symbol} 的 ${period} 线数据（${adjust}）`);
    });
  return databaseOnly() ? read() : cached(key, Math.min(defaultTtl(n.market === 'HK' ? 'HK' : 'A'), 60_000), read);
}

export async function getMinute(input: string): Promise<MinutePoint[]> {
  if (remoteMarketDataEnabled()) return readRemoteMarketData<MinutePoint[]>('minute', { code: input });
  const n = normalizeCode(input);
  if (!n) return [];
  return cached(`minute:${n.symbol}`, 60 * 1000, async () => {
    try {
      return await tencent.fetchMinute(n.symbol);
    } catch {
      return [];
    }
  });
}

/* -------------------------------------------------------- 估值 / 财务 */

/**
 * 估值分析：当前值 + 真实历史 PE/PB/股息率序列 + 分位。
 *
 * 历史序列用**已披露定期报告**还原当期 TTM EPS 与 BPS（见 `lib/valuation.ts`），
 * 价格为不复权收盘价 —— 与前复权价倒推的旧口径相比，不会因除权而低估历史 PE。
 */
export async function getValuation(input: string, years = HISTORY_YEARS, method: ValuationMethod = 'disclosure', options: ValuationCacheOptions = {}): Promise<Valuation> {
  if (remoteMarketDataEnabled()) return readRemoteMarketData<Valuation>('valuation', { code: input, years, method });
  const n=normalizeStockCode(input);
  if(!n || n.kind!=='stock')throw Error('真实财报估值仅支持 A 股 / 港股股票');
  const span=Math.min(Math.max(years,1),HISTORY_YEARS);
  const value=await cachedValuationResult(n.symbol,span,method,()=>withMarketReadStatus(()=>calculateValuation(n.symbol,span,method)),options);
  if(n.market!=='HK' || !value.historyCache)return value;
  // Historical samples are durable, while HK current cards still use live prices.
  try {
    const quote=await getQuote(n.symbol);
    const current=await getHkCurrentValuation(n.symbol,quote?.stale?null:quote?.price??null);
    const dyStats=seriesStats((value.historyByMetric?.dy??value.history).map(p=>p.dy),current.dividendYield);
    return {...value,pe:current.pe,pb:current.pb,dividendYield:current.dividendYield,
      dyPercentile:dyStats.percentile,...(value.stats?{stats:{...value.stats,dy:dyStats}}:{}),
      dividendFiscalYear:current.fiscalYear,
      dividendPerShare:{ordinary:current.ordinaryDps,special:current.specialDps,total:current.ttmDps},
      marketComparison:{pe:quote?.marketPe??quote?.pe??null,pb:quote?.pb??null,ts:quote?.ts??null},
      stale:!quote || quote.stale};
  } catch {return {...value,stale:true,warnings:[...(value.warnings??[]),'当前港股估值刷新失败，保留已保存数据，请留意日期。']};}
}
async function calculateValuation(input: string, years = HISTORY_YEARS, method: ValuationMethod = 'disclosure'): Promise<Valuation> {
  const n = normalizeStockCode(input);
  if (!n || n.kind !== 'stock') throw new Error('真实财报估值仅支持 A 股 / 港股股票');
  if (n.market === 'HK') {
    const span = Math.min(Math.max(years, 1), HISTORY_YEARS);
    const [q, points] = await Promise.all([
      getQuote(n.symbol),
        cached(`hk-indicators-currency-v3:${n.symbol}:${span}:${await valuationInputVersion(getMarketStore(),n.symbol)}`, 6 * 3600e3,
        () => hkFinance.fetchHkIndicatorPoints(`${n.code}.HK`, span + 3)),
    ]);
    if (!q) throw new Error('行情获取失败');
    const current = await getHkCurrentValuation(n.symbol, q.stale ? null : q.price);
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const snapshot = hkFinance.summarizeHkSnapshot(points, n.code, q, date, span, current);
    // Provider exposes only five/ten-year ratio presets; never invent an twelve-year query.
    const historySpan = span > 5 ? 10 : 5;
    const store = getMarketStore();
    const [pe, pb, prices, dividends] = await Promise.all([
      fetchHkRatioHistory(n.symbol, 'pe', historySpan).catch(() => null),
      fetchHkRatioHistory(n.symbol, 'pb', historySpan).catch(() => null),
      store ? readDatabaseKLine({ symbol: n.symbol, period: 'day', adjust: 'none', count: Math.min(3200, span * 280 + 60), start: ymdYearsAgo(span) }, store).catch(() => null) : null,
      getHkDividendInputs(n.symbol).catch(() => null),
    ]);
    const result = attachHkValuationHistory(snapshot, { pe, pb, prices: prices?.stale ? [] : prices?.candles, dividends });
    return { ...result, stale: q.stale };
  }
  const span = Math.min(Math.max(years, 1), HISTORY_YEARS);
  return cached(`val-qfq-forward-dy-v3:${n.symbol}:${span}:${method}:${databaseOnly()}:${await valuationInputVersion(getMarketStore(),n.symbol)}`, databaseOnly()?0:defaultTtl(), async () => {
    const start = ymdYearsAgo(span);
    // 行情两条 3200 根分页链（raw/qfq）并行会触发上游限频，改为串行；
    // qfq 仅用于价格曲线；缺失时留空，不能缩短用 raw 计算的估值历史。
    const [q, points, shares, dates, dividends, plans] = await Promise.all([
      getQuote(n.symbol),
      getFinancialHistoryInput(n.code, span + 1),
      storedMarketInput(`shares-v3:${n.code}`, 'share-events', 'public-shares:10000shares', 1800e3, () => sinaFinance.fetchShareHistory(n.code), rows => { validateDatedRows(rows as unknown as Record<string, unknown>[], 'date', ['sharesWan']); if (rows.some(r => !(r.sharesWan > 0))) throw Error('股本数值无效'); },sinaFinance.shareHistorySource),
      storedMarketInput(`disclosures-v3:${n.code}:${span + 2}`, 'disclosure-dates', 'sina+eastmoney:first-original-publication', 1800e3, () => fetchDisclosureDates(n.code, new Date().getUTCFullYear() - span - 2), dates => { if (!dates.size) throw Error('缺少原始公告日期'); const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); for (const [report, published] of dates) if (!/^\d{4}-\d{2}-\d{2}$/.test(published) || published <= report || published > today) throw Error('公告日期无效'); }),
      getValuationDividends(n.code).catch(() => null),
      getValuationPlans(n.code).catch(() => null),
    ]).catch(error => { throw Error(`财报数据不可用或股本/公告输入未通过核验：${error instanceof Error ? error.message : String(error)}`); });
    const count=Math.min(3200,span*280+60);
    const raw = await getKLine(n.symbol, 'day', 'none', count, start);
    const adjusted = await getKLine(n.symbol, 'day', 'qfq', count, start).catch(() => null);
    if (!q) throw new Error('行情获取失败');
    if (!points.length) throw new Error('财报数据不可用，已停止估值计算，请稍后重试');
    if (!shares.length) throw new Error('真实股本变动史不可用，已停止估值计算');
    if (raw.adjust !== 'none' || adjusted && adjusted.adjust !== 'qfq') throw new Error('价格复权口径不匹配，已停止估值计算');
    const cutoff = ymdYearsAgo(span);
    const candles = raw.candles.filter(c => c.date >= cutoff);
    const adjustedByDate = new Map((adjusted?.candles ?? []).map(c => [c.date, c]));
    const staticDyByDate = dividends ? buildDividendYieldByDate(dividends, candles) : new Map<string, number>();
    const dyByDate = plans && dividends ? buildExpectedDividendYieldByDate(plans, candles, dividends) : new Map<string, number | null>();
    const completePoints = [...points];
    const firstReport = points[0].date;
    for (const report of dates.keys()) {
      if (report < firstReport || points.some(p => p.date === report)) continue;
      const actual = sinaFinance.sharesAt(shares, report);
      completePoints.push({ date: report, npParent: null, npTotal: null,
        equityParent: null, equityTotal: null, sharesYi: actual !== null ? actual / 1e4 : null });
    }
    const disclosure = buildDisclosureTimeline(completePoints, { reportDates: dates });
    if (!points.some(p => dates.has(p.date))) throw new Error('真实财报公告日期不可用，无法还原历史估值');
    // Even cutoff mode cannot use a report before its actual publication.
    const cutoffTimeline = buildTimelineFromStatements(completePoints).flatMap(p => {
      const known = disclosure.find(d => d.report === p.report);
      return known ? [{ ...p, eff: p.eff > known.eff ? p.eff : known.eff }] : [];
    });
    const timeline = method === 'cutoff' ? cutoffTimeline : disclosure;
    const alternate = method === 'cutoff' ? disclosure : cutoffTimeline;
    const options = { dyByDate, staticDyByDate, adjustedByDate, shareHistory: shares };
    const history = buildRealValuationSeries(candles, timeline, options);
    if (!history.length) throw new Error('财报、股本与不复权价格没有可对齐的日期');
    const last = history[history.length - 1];
    const lastRawClose = last.rawClose ?? candles.at(-1)!.close;
    const lastFin = timeline.filter(p => p.eff <= last.date).sort((a,b) => a.report.localeCompare(b.report)).at(-1);
    const main = summarizeReal(history, q, { years: span });
    const altHistory = buildRealValuationSeries(candles, alternate, options);
    const alt = altHistory.length ? summarizeReal(altHistory, q, { years: span }) : null;
    const warnings: string[] = [];
    const missingDates = points.filter(p => !dates.has(p.date) && effectiveDate(p.date) >= cutoff && p.date <= last.date).length;
    if (missingDates) warnings.push(`${missingDates} 个报告期未取得原始公告日期，不用于建立新估值点。`);
    if (completePoints.some(p => !points.includes(p) && p.date >= cutoff)) warnings.push('部分已公告报告缺少财务金额，相应区间不计算估值。');
    if (history.length < candles.length || history.some(p => p.missingInputs?.length)) warnings.push('部分交易日缺少已披露财报、股本或财务金额，相应估值不计算。');
    const missingAdjusted = history.filter(p => p.close === null).length;
    if (missingAdjusted) warnings.push(`${missingAdjusted} 个交易日前复权价格缺失，价格曲线留空；估值仍按不复权价格与当日股本计算。`);
    if (raw.complete===false || Date.parse(history[0].date)-Date.parse(cutoff)>14*864e5) warnings.push('估值数据覆盖不足所选区间，请以实际起止日期和样本数为准。');
    if (dividends === null) warnings.push('分红数据源不可用，股息率暂不计算。');
    if (dividends?.some(e=>e.reconciliationPending)) warnings.push('已实施分红已取得，独立分红方案核对暂不可用；相关金额尚未完成跨源核对。');
    if (dividends?.some(e => e.cashConflict)) warnings.push('部分历史分红来源金额有冲突，相关十二个月静态股息率留空，不将争议金额计入。');
    if (plans === null) warnings.push('分红方案数据不可用，预期股息率暂不计算；静态值仍按可取得的已实施分红计算。');
    if (raw.stale || adjusted?.stale || q.stale) warnings.push('部分行情来自历史快照，请留意数据日期。');
    warnings.push('财务金额为数据源当前披露版本，可能包含后续重述；历史序列不能替代严格的时点回测数据。');
    return { ...main, code: n.code, method, priceAdjust: 'qfq', warnings,
      dividendYieldMethod: 'announced-forward',
      dividendForecast: { asOf: last.date, rawClose: lastRawClose,
        expectedPerShare: main.dividendYield === null ? null : main.dividendYield * lastRawClose / 100,
        staticPerShare: main.staticDividendYield === null ? null : main.staticDividendYield * lastRawClose / 100 },
      netProfit: lastFin?.npTTM ?? null,
      netAssets: lastFin?.equityYi ?? (lastFin?.bps != null && lastFin.shares != null ? lastFin.bps * lastFin.shares : null),
      marketComparison: { pe: q.pe, pb: q.pb, ts: q.ts },
      fin: { report: lastFin?.report ?? null, npTTM: lastFin?.npTTM ?? null,
        shares: lastFin?.shares ?? null, bps: lastFin?.bps ?? null, points: points.length,
        realDates: true, adjustGaps: 0 },
      ...(alt && alt.stats ? { alt: { method: method === 'cutoff' ? 'disclosure' as const : 'cutoff' as const,
        history: alt.history, stats: alt.stats, current: { pe: alt.pe, pb: alt.pb, dy: alt.dividendYield } } } : {}),
      source: `${[...new Set(points.flatMap(p=>p.sources??['public-statements']))].join(' + ')} + sina/eastmoney-disclosures + eastmoney-dividend-plans + ${raw.source}-raw + ${adjusted?.source ?? 'missing'}-qfq`,
      stale: q.stale || raw.stale || adjusted?.stale || false,
    };
  }, { staleOnError: !databaseOnly() });
}

export async function getFinancial(input: string): Promise<FinancialSummary> {
  return withMarketReadStatus(()=>getFinancialData(input));
}
async function getFinancialData(input: string): Promise<FinancialSummary> {
  if (remoteMarketDataEnabled()) return readRemoteMarketData<FinancialSummary>('financial', { code: input });
  const n = normalizeStockCode(input);
  if (!n) throw new Error(`无法解析代码 ${input}`);
  return cached(`fin:${n.code}`, 30 * 60 * 1000, async () => {
    if(n.market!=='HK' && n.kind==='stock'){
      const transient=new Map<string,import('./eastmoneyStatements').StatementSourcePage>();
      if (!databaseOnly()) {
        const year=new Date(Date.now()+8*3600e3).getUTCFullYear();
        await Promise.allSettled([year,year-1].flatMap(y=>['profit','balance'].map(async id=>{
          const page=await sinaStatements.fetchStatementSourcePage(n.code,id as 'profit'|'balance',y);
          transient.set(`source-sina-page:v1:${n.code}:${id}:${y}`,page);
        })));
      }
      const persisted=getMarketReadStore();
      const readStore=transient.size ? {read:async<T>(key:string)=>transient.has(key)
        ? {payload:transient.get(key)} as import('../marketStore').MarketRecord<T>
        : persisted?.read<T>(key).catch(()=>null)??null} : persisted;
      const reported=await readStoredFinancialSummary(readStore,n.code);
      if(reported)return {...reported,stale:false};
    }
    const q = await getQuote(n.symbol);
    if (!q) throw new Error('行情获取失败');
    // 优先走 iFinD 真实三表；未启用则降级为恒等式派生
    if (ifind.isEnabled()) {
      try {
        return {...await ifind.fetchFinancial(n.code),stale:false};
      } catch {
        /* 降级 */
      }
    }
    return {...buildFinancialSummary(q),stale:q.stale};
  });
}

/** 行业对比：同行业标的的实时行情 + 派生 ROE */
export async function getPeers(input: string): Promise<{ industry: string | null; rows: PeerRow[] }> {
  if (remoteMarketDataEnabled()) return readRemoteMarketData<{ industry: string | null; rows: PeerRow[] }>('peers', { code: input });
  const n = normalizeStockCode(input);
  if (!n) return { industry: null, rows: [] };
  const industry = industryOf(n.code);
  const peers = peersOf(n.code, 15);
  if (peers.length === 0) return { industry, rows: [] };

  const codes = [n.code, ...peers.map((p) => p.code)];
  return cached(`peers:${n.code}`, defaultTtl(), async () => {
    const qs = await getQuotes(codes);
    const rows: PeerRow[] = qs.map((q) => {
      const roe = q.pb !== null && q.pe ? (q.pb / q.pe) * 100 : null;
      return {
        code: q.code,
        name: q.name,
        price: q.price,
        changePct: q.changePct,
        pe: q.pe,
        pb: q.pb,
        roe,
        totalMarketCap: q.totalMarketCap,
      };
    });
    return { industry, rows };
  });
}

/* ------------------------------------------------------------ 条件选股 */

export async function screen(criteria: ScreenCriteria) {
  if (remoteMarketDataEnabled()) return readRemoteMarketData<import('../valueScreen').ValueScreenResult>('screen', {}, criteria);
  return runValueScreen(criteria, getQuotes);
}

export function getScreenMeta() {
  return getValueScreenMeta();
}

/* ---------------------------------------------------------------- 大盘 */

export async function getMarketOverview(): Promise<MarketOverview> {
  if (remoteMarketDataEnabled()) return readRemoteMarketData<MarketOverview>('market');
  return cached('market:overview', defaultTtl(), async () => {
    const symbols = INDICES.map((i) => i.symbol);
    const indices = await getQuotes(symbols);
    const stale = indices.some((i) => i.stale);
    return {
      indices,
      updatedAt: new Date().toISOString(),
      source: indices[0]?.source ?? 'unknown',
      stale,
    };
  });
}

/* -------------------------------------------------- 真实财务（新浪） */

import * as sinaFinancial from './sinaFinancial';

/**
 * 财务对比数据：最多四家公司（主 + 三家对比），近 N 年真实财报指标。
 * 财务数据更新频率低（季报），缓存 1 小时。
 */
export async function getFinancialCompare(
  codes: string[],
  years = HISTORY_YEARS,
  granularity: sinaFinancial.Granularity = 'semi',
) {
  if (remoteMarketDataEnabled()) return readRemoteMarketData<{
    companies: sinaFinancial.CompanyFinancials[]; indicators: typeof sinaFinancial.INDICATORS; groups: typeof sinaFinancial.GROUP_META;
  }>('finance-compare', { codes: codes.join(','), years, granularity });
  const list = codes.slice(0, 4);
  return (async () => {
    const results = await Promise.all(
      list.map(async (c) => {
        const n = normalizeStockCode(c);
        if (!n) throw new Error(`无法解析代码 ${c}`);
        const q = await getQuote(n.symbol).catch(() => null);
        let f: sinaFinancial.CompanyFinancials;
        if (n.market === 'HK') {
          f = await hkFinance
            .fetchHkFinancials(`${n.code}.HK`, n.code, years, q?.name)
            .catch(() => {
              return {
                code: n.code,
                name: q?.name ?? n.code,
                periods: [],
                periodLabels: [],
                series: {},
                source: hkFinance.PROVIDER_NAME,
              } as sinaFinancial.CompanyFinancials;
            });
        } else {
          try {
            f = await sinaFinancial.fetchSinaFinancial(n.code, years, q?.name);
          } catch {
            // 财务页抓取失败时返回空骨架并明确标注缺失，前端提示而非白屏
            f = {
              code: n.code,
              name: q?.name ?? n.code,
              periods: [],
              periodLabels: [],
              series: {},
              source: sinaFinancial.PROVIDER_NAME,
              missing: '财务指标序列未入库且公网抓取失败（请通过维护端补齐后重试）',
            };
          }
        }
        return n.market === 'HK' ? hkFinance.filterHkPeriods(f, granularity) : sinaFinancial.filterByGranularity(f, granularity);
      }),
    );
    return {
      companies: results,
      indicators: sinaFinancial.INDICATORS,
      groups: sinaFinancial.GROUP_META,
    };
  })();
}

/* ------------------------------------------------ 三大报表全字段（新浪） */

import * as sinaStatements from './sinaStatements';

/** 三大报表字段目录（含全部披露科目），缓存 24h。 */
export async function getFinanceFieldsCatalog(code: string) {
  if (remoteMarketDataEnabled()) return readRemoteMarketData<{
    code: string; name: string; statements: sinaStatements.StatementCatalog[]; indicators: typeof sinaFinancial.INDICATORS;
    indicatorGroups: typeof sinaFinancial.GROUP_META; defaultFields?: string[];
  }>('finance-fields', { code });
  const n = normalizeStockCode(code);
  if (!n) throw new Error(`无法解析代码 ${code}`);
  const q = await getQuote(n.symbol).catch(() => null);
  if (n.market === 'HK') {
    const catalog = await cached(`fincatalog-hk:${n.symbol}`, 24 * 60 * 60 * 1000, () =>
      hkFinance.fetchHkCatalog(`${n.code}.HK`),
    );
    return {
      code: n.code,
      name: q?.name ?? n.code,
      statements: catalog,
      indicators: sinaFinancial.INDICATORS,
      indicatorGroups: sinaFinancial.GROUP_META,
      defaultFields: hkDefaultFields(catalog),
    };
  }
  // 缓存 1h：字段目录模板稳定，但部分表缺失时需在维护端补齐后较快恢复完整目录
  const catalog = await cached(`fincatalog:${n.code}`, 60 * 60 * 1000, () =>
    sinaStatements.fetchStatementCatalog(n.code),
  );
  // 部分报表源页未入库时正常返回已有表，缺失项明确标注
  const missing = (Object.keys(sinaStatements.STATEMENT_META) as sinaStatements.StatementId[])
    .filter((id) => !catalog.some((c) => c.id === id))
    .map((id) => `${sinaStatements.STATEMENT_META[id].label}字段目录未入库（需先通过维护端补齐现金流量表源页）`);
  return {
    code: n.code,
    name: q?.name ?? n.code,
    statements: catalog,
    indicators: sinaFinancial.INDICATORS,
    indicatorGroups: sinaFinancial.GROUP_META,
    ...(missing.length ? { missing } : {}),
  };
}

/** 港股合并报表默认展示字段：指标 + 各表前几个科目（按东财披露顺序） */
function hkDefaultFields(catalog: { id: string; groups: { fields: { key: string }[] }[] }[]): string[] {
  const picks: string[] = ['roe', 'debtRatio', 'eps', 'bps', 'netMargin', 'revenueGrowth', 'profitGrowth'];
  const want: Record<string, number> = { profit: 4, balance: 4, cashflow: 2 };
  for (const st of catalog) {
    const n = want[st.id] ?? 0;
    const keys = (st.groups[0]?.fields ?? []).slice(0, n).map((f) => f.key);
    picks.push(...keys);
  }
  return picks;
}

/**
 * 自定义字段财务对比：fields 形如 `bs_货币资金,pl_营业收入,roe`。
 * bs_/pl_/cf_ 前缀走三大报表，其余按财务指标 key 处理。
 */
export async function getCustomFinancialCompare(
  codes: string[],
  fields: string[],
  years = HISTORY_YEARS,
  granularity: sinaFinancial.Granularity = 'semi',
) {
  if (remoteMarketDataEnabled()) return readRemoteMarketData<{ companies: sinaStatements.CustomFinancials[] }>('finance-compare', {}, { codes, fields, years, granularity });
  const list = codes.slice(0, 4);
  if (list.some(c=>!normalizeStockCode(c))) throw Error('无效股票代码');
  const watchlist = years === 2 && granularity === 'quarter' && fields.length === WATCHLIST_FINANCIAL_FIELDS.length && WATCHLIST_FINANCIAL_FIELDS.every(f => fields.includes(f));
  const companies = await Promise.all(list.map(async c => {
    const n = normalizeStockCode(c)!;
    const q = await getQuote(n.symbol).catch(() => null);
    try {
      if (watchlist) return { ...await getWatchlistFinancialInputs(n.symbol), name:q?.name??n.code };
      if (n.market==='HK') return hkFinance.filterHkPeriods(
        await hkFinance.fetchHkCustomFinancials(`${n.code}.HK`,n.code,fields,years,q?.name),granularity);
      return filterCustom(await sinaStatements.fetchCustomFinancials(n.code,fields,years,q?.name),granularity);
    } catch(error) {
      return {code:n.code,name:q?.name??n.code,periods:[],periodLabels:[],
        series:Object.fromEntries(fields.map(field=>[field,[]])),source:'unavailable',missingFields:fields,
        missing:error instanceof Error?error.message:'财务数据暂不可用'};
    }
  }));
  return { companies, errors:companies.filter(c=>'missing' in c && c.missing).map(c=>({code:c.code,error:(c as {missing:string}).missing})) };
}

/** 粒度筛选（A 股 / 港股共用逻辑） */
function filterCustom(
  f: sinaStatements.CustomFinancials,
  g: 'annual' | 'semi' | 'quarter',
): sinaStatements.CustomFinancials {
  if (g === 'quarter') return f;
  const keep = f.periods
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => (g === 'annual' ? p.endsWith('-12-31') : p.endsWith('-12-31') || p.endsWith('-06-30')));
  return {
    ...f,
    periods: keep.map((k) => k.p),
    periodLabels: keep.map((k) => f.periodLabels[k.i]),
    series: Object.fromEntries(Object.entries(f.series).map(([k, arr]) => [k, keep.map((x) => arr[x.i])])),
  };
}

/* ---------------------------------------------------------- 数据源体检 */

export async function health(): Promise<{ providers: ProviderStatus[]; snapshot: unknown }> {
  if (remoteMarketDataEnabled()) return readRemoteMarketData<{ providers: ProviderStatus[]; snapshot: unknown }>('health');
  const providers: ProviderStatus[] = [];

  const probe = async (
    name: string,
    label: string,
    fn: () => Promise<unknown>,
    reserved = false,
  ): Promise<ProviderStatus> => {
    const t0 = Date.now();
    try {
      await fn();
      return { name, label, ok: true, latencyMs: Date.now() - t0, detail: '正常', reserved };
    } catch (e) {
      return {
        name,
        label,
        ok: false,
        latencyMs: Date.now() - t0,
        detail: e instanceof Error ? e.message.slice(0, 120) : String(e),
        reserved,
      };
    }
  };

  providers.push(await probe('tencent', '腾讯财经（行情/K线/分时）', () => tencent.fetchQuote('sh600519')));
  providers.push(await probe('sina', '新浪财经（备用 K 线）', () => sina.fetchQuotes(['sh600519'])));
  providers.push(await probe('eastmoney', '东方财富（搜索联想）', () => eastmoney.fetchSearch('600519')));

  const ifindSt = ifind.status();
  providers.push({
    name: 'ifind',
    label: '同花顺 iFinD（真实三表财务）',
    ok: ifindSt.enabled,
    latencyMs: null,
    detail: ifindSt.detail,
    reserved: !ifindSt.enabled,
  });

  const snapInfo = await snapshot.snapshotInfo();
  providers.push({
    name: 'snapshot',
    label: '本地兜底快照',
    ok: snapInfo.count > 0,
    latencyMs: null,
    detail: snapInfo.count > 0 ? `${snapInfo.count} 个标的，生成于 ${snapInfo.generatedAt}` : '未生成（运行 npm run seed）',
  });

  return { providers, snapshot: snapInfo };
}

/** 预热常用标的（启动或定时任务调用） */
export async function warmup(codes: string[] = ['600519', '000300', '000001']): Promise<void> {
  await Promise.allSettled(codes.map((c) => getQuote(c)));
}

export { putCache };

/* ------------------------------------------------------------ 行业板块 */

/** 行业板块内单只成分股 */
export interface IndustryConstituent {
  code: string;
  name: string;
  changePct: number | null;
  pe: number | null;
  pb: number | null;
  roe: number | null;
  totalMarketCap: number | null;
}

/** 行业板块聚合行（理杏仁式行业估值表） */
export interface IndustryRow {
  industry: string;
  /** 成分股数量 */
  count: number;
  /** 其中 PE 为负（亏损）的家数，PE 统计时已剔除 */
  lossCount: number;
  /** 各指标的行业内「中位数」 */
  changePct: number | null;
  pe: number | null;
  pb: number | null;
  roe: number | null;
  /** 行业总市值合计（亿元） */
  totalMarketCap: number | null;
  /** 行业中位 PE/PB 在全部行业中的横截面分位（0-100，越低越便宜） */
  pePercentile: number | null;
  pbPercentile: number | null;
  constituents: IndustryConstituent[];
}

function median(nums: (number | null)[]): number | null {
  const a = nums.filter((v): v is number => v !== null && Number.isFinite(v)).sort((x, y) => x - y);
  if (a.length === 0) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** 横截面分位：v 在数组中的百分位（0-100） */
function crossPercentile(v: number | null, arr: (number | null)[]): number | null {
  if (v === null) return null;
  const a = arr.filter((x): x is number => x !== null && Number.isFinite(x));
  if (a.length < 2) return null;
  const below = a.filter((x) => x < v).length;
  return (below / (a.length - 1)) * 100;
}

/**
 * 行业板块估值表：按行业聚合股票池（中位数口径），PE/PB 附横截面分位。
 * 注：分位点是「当前行业中位数在全部行业中位数里的横向位置」，
 * 与理杏仁的「行业历史分位」不同——后者需要逐股历史序列，暂不提供。
 */
export async function getIndustryBoard() {
  if (remoteMarketDataEnabled()) return readRemoteMarketData<{ updatedAt: string; industries: number; rows: IndustryRow[] }>('industry');
  return cached('industry:board', defaultTtl() * 2, async () => {
    const SKIP = new Set(['宽基指数', '行业指数', '商品']);
    const pool = STOCKS.filter((s) => !SKIP.has(s.industry));
    const qs = await getQuotes(pool.map((s) => s.code));
    const meta = new Map(pool.map((s) => [s.code, s]));

    const groups = new Map<string, IndustryConstituent[]>();
    for (const q of qs) {
      const m = meta.get(q.code);
      if (!m) continue;
      const roe = q.pe !== null && q.pb !== null && q.pe > 0 && q.pb > 0 ? (q.pb / q.pe) * 100 : null;
      const row: IndustryConstituent = {
        code: q.code,
        name: q.name,
        changePct: q.changePct,
        pe: q.pe,
        pb: q.pb,
        roe,
        totalMarketCap: q.totalMarketCap,
      };
      const list = groups.get(m.industry) ?? [];
      list.push(row);
      groups.set(m.industry, list);
    }

    let rows: IndustryRow[] = [...groups.entries()].map(([industry, list]) => {
      // 亏损股 PE 为负，直接参与中位数会把行业 PE 拉到 0 以下，失去可比性 → 统计时剔除
      const profitable = list.filter((r) => r.pe !== null && r.pe > 0);
      return {
        industry,
        count: list.length,
        lossCount: list.length - profitable.length,
        changePct: median(list.map((r) => r.changePct)),
        pe: median(profitable.map((r) => r.pe)),
        pb: median(list.map((r) => r.pb)),
        roe: median(list.map((r) => r.roe)),
        totalMarketCap: list.reduce((s, r) => s + (r.totalMarketCap ?? 0), 0),
        pePercentile: null,
        pbPercentile: null,
        constituents: list.sort((a, b) => (b.totalMarketCap ?? 0) - (a.totalMarketCap ?? 0)),
      };
    });

    const pes = rows.map((r) => r.pe);
    const pbs = rows.map((r) => r.pb);
    rows = rows.map((r) => ({ ...r, pePercentile: crossPercentile(r.pe, pes), pbPercentile: crossPercentile(r.pb, pbs) }));
    rows.sort((a, b) => (b.totalMarketCap ?? 0) - (a.totalMarketCap ?? 0));
    return { updatedAt: new Date().toISOString(), industries: rows.length, rows };
  });
}


/** 公司资料：控股股东 / 实控人 / 所属行业（A 股申万三级，港股东财行业） */
export async function getCompanyProfile(input: string) {
  if (remoteMarketDataEnabled()) return readRemoteMarketData<profile.CompanyProfile>('company-profile', { code: input });
  const n = normalizeCode(input);
  if (!n || n.kind === 'unknown') throw new Error(`无法解析代码 ${input}`);
  return cached(`profile:${n.symbol}`, 24 * 60 * 60 * 1000, () =>
    profile.fetchCompanyProfile(n.code, n.market === 'HK' ? 'HK' : 'A'),
  );
}
