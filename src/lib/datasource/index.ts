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
import * as ifind from './ifind';
import * as snapshot from './snapshot';
import * as hkFinance from './hkFinance';
import { cached, defaultTtl, putCache } from './cache';
import { normalizeCode, normalizeStockCode } from './codes';
import { computeValuation, buildFinancialSummary } from '../analytics';
import * as sinaBonus from './sinaBonus';
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
} from '../valuation';
import * as sinaFinStmt from './sinaFinStatements';
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
  const kw = keyword.trim();
  if (!kw) return [];
  return cached(`search:${kw}`, 5 * 60 * 1000, async () => {
    const out: SearchHit[] = [];
    const seen = new Set<string>();

    const push = (hits: SearchHit[]) => {
      for (const h of hits) {
        const key = `${h.market}${h.code}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(h);
      }
    };

    const tasks: Promise<SearchHit[]>[] = [
      eastmoney.fetchSearch(kw).catch(() => []),
      tencent.fetchSearch(kw).catch(() => []),
    ];
    const results = await Promise.all(tasks);
    // 东财的代码/名称匹配质量更高，优先展示
    push(results[0]);
    push(results[1]);

    // 本地池兜底 + 行业名搜索（如搜“银行”）
    push(localSearch(kw));
    return out.slice(0, 20);
  });
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
  const n = normalizeCode(input);
  if (!n) return null;
  return cached(`quote:${n.symbol}`, defaultTtl(), async () => {
    try {
      const q = await tencent.fetchQuote(n.symbol);
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
}

/** 批量行情：分块并发 + 逐块降级 */
export async function getQuotes(inputs: string[]): Promise<Quote[]> {
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
    chunks.map((chunk) =>
      cached(`quotes:${chunk.join(',')}`, defaultTtl(), () => fetchQuotesChunk(chunk)),
    ),
  );
  return results.flat();
}

async function fetchQuotesChunk(symbols: string[]): Promise<Quote[]> {
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
): Promise<KLineSeries> {
  const n = normalizeCode(input);
  if (!n) throw new Error(`无法解析代码 ${input}`);
  const key = `kline:${n.symbol}:${period}:${adjust}:${count}:${startDate ?? ''}`;
  return cached(key, defaultTtl() * 6, async () => {
    try {
      return await tencent.fetchKLine(n.symbol, period, adjust, count, startDate);
    } catch {
      /* 落到下一级 */
    }
    try {
      if (adjust !== 'none') throw new Error('新浪仅提供不复权价格');
      return await sina.fetchKLine(n.symbol, period, count);
    } catch {
      /* 落到下一级 */
    }
    const snap = await snapshot.snapshotKLine(n.symbol, period);
    if (snap && snap.adjust === adjust) return snap;
    throw new Error(`无法获取 ${n.symbol} 的 ${period} 线数据（${adjust}）`);
  });
}

export async function getMinute(input: string): Promise<MinutePoint[]> {
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
export async function getValuation(input: string, years = 10, method: ValuationMethod = 'disclosure'): Promise<Valuation> {
  const n = normalizeCode(input);
  if (!n || n.kind !== 'stock') throw new Error('真实财报估值仅支持 A 股 / 港股股票');
  if (n.market === 'HK') {
    const span = Math.min(Math.max(years, 1), 10);
    return cached(`val-hk-v1:${n.symbol}:${span}`, 60 * 60 * 1000, async () => {
      const [q, raw] = await Promise.all([
        getQuote(n.symbol),
        getKLine(n.symbol, 'day', 'none', 3200, ymdYearsAgo(span + 1)),
      ]);
      if (!q) throw new Error('行情获取失败');
      return hkFinance.buildHkValuation(`${n.code}.HK`, n.code, raw.candles, q, span);
    });
  }
  const span = Math.min(Math.max(years, 1), 10);
  return cached(`val-qfq-v1:${n.symbol}:${span}:${method}`, defaultTtl(), async () => {
    const start = ymdYearsAgo(span + 1);
    const [q, points, shares, dates, dividends, raw, adjusted] = await Promise.all([
      getQuote(n.symbol),
      cached(`statements-v2:${n.code}`, 864e5, () => sinaFinStmt.fetchStatementHistory(n.code, span + 2)),
      cached(`shares-v2:${n.code}`, 864e5, () => sinaFinance.fetchShareHistory(n.code)),
      cached(`disclosures:${n.code}`, 864e5, () => fetchDisclosureDates(n.code, new Date().getUTCFullYear() - span - 2)),
      cached(`dividends-v2:${n.code}`, 864e5, () => sinaBonus.fetchDividends(n.code)).catch(() => null),
      getKLine(n.symbol, 'day', 'none', 3200, start),
      getKLine(n.symbol, 'day', 'qfq', 3200, start),
    ]);
    if (!q) throw new Error('行情获取失败');
    if (!points.length) throw new Error('财报数据不可用，已停止估值计算，请稍后重试');
    if (!shares.length) throw new Error('真实股本变动史不可用，已停止估值计算');
    if (raw.adjust !== 'none' || adjusted.adjust !== 'qfq') throw new Error('价格复权口径不匹配，已停止估值计算');
    const cutoff = ymdYearsAgo(span);
    const candles = raw.candles.filter(c => c.date >= cutoff);
    const adjustedByDate = new Map(adjusted.candles.map(c => [c.date, c]));
    const dyByDate = dividends ? buildDividendYieldByDate(dividends, candles) : new Map<string, number>();
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
    const options = { dyByDate, adjustedByDate, shareHistory: shares };
    const history = buildRealValuationSeries(candles, timeline, options);
    if (!history.length) throw new Error('财报、股本与前复权价格没有可对齐的日期');
    const last = history[history.length - 1];
    const lastFin = timeline.filter(p => p.eff <= last.date).sort((a,b) => a.report.localeCompare(b.report)).at(-1);
    const main = summarizeReal(history, q, { years: span });
    const altHistory = buildRealValuationSeries(candles, alternate, options);
    const alt = altHistory.length ? summarizeReal(altHistory, q, { years: span }) : null;
    const warnings: string[] = [];
    const missingDates = points.filter(p => !dates.has(p.date) && effectiveDate(p.date) >= cutoff && p.date <= last.date).length;
    if (missingDates) warnings.push(`${missingDates} 个报告期未取得原始公告日期，不用于建立新估值点。`);
    if (completePoints.some(p => !points.includes(p) && p.date >= cutoff)) warnings.push('部分已公告报告缺少财务金额，相应区间不计算估值。');
    if (history.length < candles.length) warnings.push('部分交易日缺少可对齐的前复权价格或已披露财报，已排除。');
    if (history[0].date > cutoff && history[0].date > candles[0]?.date) warnings.push('数据覆盖不足所选区间，请以实际起止日期和样本数为准。');
    if (dividends === null) warnings.push('分红数据源不可用，股息率暂不计算。');
    if (raw.stale || adjusted.stale || q.stale) warnings.push('部分行情来自历史快照，请留意数据日期。');
    warnings.push('财务金额为数据源当前披露版本，可能包含后续重述；历史序列不能替代严格的时点回测数据。');
    return { ...main, code: n.code, method, priceAdjust: 'qfq', warnings,
      netProfit: lastFin?.npTTM ?? null,
      marketComparison: { pe: q.pe, pb: q.pb, ts: q.ts },
      fin: { report: lastFin?.report ?? null, npTTM: lastFin?.npTTM ?? null,
        shares: lastFin?.shares ?? null, bps: lastFin?.bps ?? null, points: points.length,
        realDates: true, adjustGaps: 0 },
      ...(alt && alt.stats ? { alt: { method: method === 'cutoff' ? 'disclosure' as const : 'cutoff' as const,
        history: alt.history, stats: alt.stats, current: { pe: alt.pe, pb: alt.pb, dy: alt.dividendYield } } } : {}),
      source: 'sina-statements + sina-disclosures + tencent-qfq',
      stale: q.stale || raw.stale || adjusted.stale,
    };
  });
}

export async function getFinancial(input: string): Promise<FinancialSummary> {
  const n = normalizeStockCode(input);
  if (!n) throw new Error(`无法解析代码 ${input}`);
  return cached(`fin:${n.code}`, 30 * 60 * 1000, async () => {
    const q = await getQuote(n.symbol);
    if (!q) throw new Error('行情获取失败');
    // 优先走 iFinD 真实三表；未启用则降级为恒等式派生
    if (ifind.isEnabled()) {
      try {
        return await ifind.fetchFinancial(n.code);
      } catch {
        /* 降级 */
      }
    }
    return buildFinancialSummary(q);
  });
}

/** 行业对比：同行业标的的实时行情 + 派生 ROE */
export async function getPeers(input: string): Promise<{ industry: string | null; rows: PeerRow[] }> {
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
  const pool = STOCKS.filter((s) => {
    if (criteria.market && criteria.market !== 'all') {
      const n = normalizeCode(s.code);
      if (n && n.market !== criteria.market) return false;
    }
    if (criteria.industry && s.industry !== criteria.industry) return false;
    return true;
  });

  const qs = await getQuotes(pool.map((s) => s.code));
  const industryMap = new Map(STOCKS.map((s) => [s.code, s.industry]));

  let rows = qs.map((q) => {
    const roe = q.pb !== null && q.pe ? (q.pb / q.pe) * 100 : null;
    return {
      code: q.code,
      name: q.name,
      industry: industryMap.get(q.code) ?? '--',
      price: q.price,
      changePct: q.changePct,
      pe: q.pe,
      pb: q.pb,
      roe,
      totalMarketCap: q.totalMarketCap,
      stale: q.stale,
    };
  });

  const between = (v: number | null, min?: number, max?: number) => {
    if (v === null) return false;
    if (min !== undefined && v < min) return false;
    if (max !== undefined && v > max) return false;
    return true;
  };

  rows = rows.filter((r) => {
    if (criteria.peMin !== undefined || criteria.peMax !== undefined) {
      // PE 为负（亏损）时排除，避免落入区间
      if (!between(r.pe, criteria.peMin, criteria.peMax)) return false;
    }
    if (criteria.pbMin !== undefined || criteria.pbMax !== undefined) {
      if (!between(r.pb, criteria.pbMin, criteria.pbMax)) return false;
    }
    if (criteria.roeMin !== undefined && (r.roe === null || r.roe < criteria.roeMin)) return false;
    if (criteria.marketCapMin !== undefined && (r.totalMarketCap === null || r.totalMarketCap < criteria.marketCapMin))
      return false;
    if (criteria.marketCapMax !== undefined && (r.totalMarketCap === null || r.totalMarketCap > criteria.marketCapMax))
      return false;
    if (criteria.changePctMin !== undefined && (r.changePct === null || r.changePct < criteria.changePctMin))
      return false;
    if (criteria.changePctMax !== undefined && (r.changePct === null || r.changePct > criteria.changePctMax))
      return false;
    return true;
  });

  const limit = criteria.limit ?? 100;
  return { total: rows.length, rows: rows.slice(0, limit) };
}

/* ---------------------------------------------------------------- 大盘 */

export async function getMarketOverview(): Promise<MarketOverview> {
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
  years = 6,
  granularity: sinaFinancial.Granularity = 'semi',
) {
  const list = codes.slice(0, 4);
  return cached(`fincomp:${list.join(',')}:${years}:${granularity}`, 60 * 60 * 1000, async () => {
    const results = await Promise.all(
      list.map(async (c) => {
        const n = normalizeCode(c);
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
            // 财务页抓取失败时返回空骨架，前端提示而非白屏
            f = {
              code: n.code,
              name: q?.name ?? n.code,
              periods: [],
              periodLabels: [],
              series: {},
              source: sinaFinancial.PROVIDER_NAME,
            };
          }
        }
        return sinaFinancial.filterByGranularity(f, granularity);
      }),
    );
    return {
      companies: results,
      indicators: sinaFinancial.INDICATORS,
      groups: sinaFinancial.GROUP_META,
    };
  });
}

/* ------------------------------------------------ 三大报表全字段（新浪） */

import * as sinaStatements from './sinaStatements';

/** 三大报表字段目录（含全部披露科目），缓存 24h。 */
export async function getFinanceFieldsCatalog(code: string) {
  const n = normalizeCode(code);
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
  const catalog = await cached(`fincatalog:${n.code}`, 24 * 60 * 60 * 1000, () =>
    sinaStatements.fetchStatementCatalog(n.code),
  );
  return {
    code: n.code,
    name: q?.name ?? n.code,
    statements: catalog,
    indicators: sinaFinancial.INDICATORS,
    indicatorGroups: sinaFinancial.GROUP_META,
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
  years = 6,
  granularity: sinaFinancial.Granularity = 'semi',
) {
  const list = codes.slice(0, 4);
  const fieldKey = encodeURIComponent(fields.join(','));
  return cached(`finfield:${list.join(',')}:${fieldKey}:${years}:${granularity}`, 60 * 60 * 1000, async () => {
    const results = await Promise.all(
      list.map(async (c) => {
        const n = normalizeCode(c);
        if (!n) throw new Error(`无法解析代码 ${c}`);
        const q = await getQuote(n.symbol).catch(() => null);
        if (n.market === 'HK') {
          return filterCustom(
            await hkFinance.fetchHkCustomFinancials(`${n.code}.HK`, n.code, fields, years, q?.name),
            granularity,
          );
        }
        let f: sinaStatements.CustomFinancials;
        try {
          f = await sinaStatements.fetchCustomFinancials(n.code, fields, years, q?.name);
        } catch {
          throw new Error(`无法获取 ${q?.name ?? n.code} 的财报数据，请稍后重试`);
        }
        return filterCustom(f, granularity);
      }),
    );
    return { companies: results };
  });
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

