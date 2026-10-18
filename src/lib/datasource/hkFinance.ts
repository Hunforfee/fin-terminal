/**
 * 东方财富 HKF10 Provider —— 港股财务数据源。
 *
 * 已实测可用端点（沙箱 2026-10，均免鉴权）：
 *   主要指标   RPT_HKF10_FN_MAININDICATOR            （宽表，每期一行）
 *   资产负债表 RPT_HKF10_FN_BALANCE_PC               （长表，科目逐行）
 *   利润表     RPT_HKF10_FN_INCOME_PC                （长表）
 *   现金流量表 RPT_HKF10_FN_CASHFLOW_PC              （长表）
 *
 * 口径说明：
 *   - 报表金额单位为元（港币或人民币，随公司账本币种，见 CURRENCY 字段）；
 *     对外统一折算成「万元」，与 A 股新浪口径对齐（前端 ÷1e4 显示为亿）。
 *   - 指标（ROE / 增长率 / 每股等）直接取东财披露值或由披露值恒等式派生。
 *   - 港股披露节奏与 A 股相同：03-31 / 06-30 / 09-30 / 12-31（部分公司仅半年报）。
 */

import { fetchJson } from './http';
import type { CompanyFinancials, Granularity } from './sinaFinancial';
import type { StatementCatalog, CustomFinancials } from './sinaStatements';
import type { Candle, Valuation, ValuationPoint, ValuationStats, SeriesStats } from './types';

export const PROVIDER_NAME = 'eastmoney-hkf10';

const DC_URL = 'https://datacenter.eastmoney.com/securities/api/data/v1/get';
const FX_URL = 'https://open.er-api.com/v6/latest/CNY';

interface DcRow {
  REPORT_DATE?: string;
  START_DATE?: string;
  CURRENCY?: string;
  STD_ITEM_CODE?: string | number;
  STD_ITEM_NAME?: string;
  ITEM_NAME?: string;
  AMOUNT?: number | string;
  [k: string]: unknown;
}

async function dcQuery(reportName: string, filter: string, extra = ''): Promise<DcRow[]> {
  const url =
    `${DC_URL}?reportName=${reportName}&columns=ALL&filter=${encodeURIComponent(filter)}` +
    `&pageNumber=1&pageSize=3000&sortTypes=-1,1&sortColumns=REPORT_DATE,STD_ITEM_CODE&source=F10&client=PC${extra}`;
  const j = await fetchJson<{ result?: { data?: DcRow[] } | null; message?: string }>(url, {
    timeoutMs: 15000,
    headers: { Referer: 'https://emweb.securities.eastmoney.com/' },
  });
  return j.result?.data ?? [];
}

function reportDate(row: DcRow): string | null {
  const raw = row.REPORT_DATE;
  if (!raw) return null;
  const m = String(raw).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------- 主要指标 */

interface IndicatorPoint {
  date: string;
  raw: Record<string, number | null>;
}

const MAIN_URL = `${DC_URL}?reportName=RPT_HKF10_FN_MAININDICATOR&columns=ALL&filter=`;

/** 拉取主要指标（近 N 年，年报 + 中报 + 季报全部披露期） */
export async function fetchHkIndicatorPoints(secucode: string, years = 12): Promise<IndicatorPoint[]> {
  const url =
    `${MAIN_URL}${encodeURIComponent(`(SECUCODE="${secucode}")`)}` +
    `&pageNumber=1&pageSize=200&sortTypes=-1&sortColumns=REPORT_DATE&source=F10&client=PC`;
  const j = await fetchJson<{ result?: { data?: DcRow[] } | null }>(url, {
    timeoutMs: 15000,
    headers: { Referer: 'https://emweb.securities.eastmoney.com/' },
  });
  const rows = j.result?.data ?? [];
  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  const points = rows
    .map((r) => {
      const d = reportDate(r);
      if (!d) return null;
      const raw: Record<string, number | null> = {};
      for (const [k, v] of Object.entries(r)) {
        if (typeof v === 'number' || (typeof v === 'string' && v !== '' && Number.isFinite(Number(v)))) {
          raw[k] = Number(v);
        }
      }
      return { date: d, raw };
    })
    .filter((p): p is IndicatorPoint => p !== null && new Date(`${p.date}T00:00:00Z`) >= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date));
  return points;
}

/** 人民币 → 港币汇率（用于账本币种为人民币的公司把每股指标换算到港币口径） */
async function fetchCnyToHkd(): Promise<number | null> {
  try {
    const j = await fetchJson<{ result?: string; rates?: Record<string, number> }>(FX_URL, { timeoutMs: 8000 });
    const hkd = j.rates?.HKD;
    return hkd && Number.isFinite(hkd) && hkd > 0.8 && hkd < 2 ? hkd : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------- CompanyFinancials（指标趋势） */

type Fn = (p: IndicatorPoint, i: number, all: IndicatorPoint[]) => number | null;

/** 指标 key（与 sinaFinancial.INDICATORS 对齐）→ 计算函数 */
const METRIC_FNS: Record<string, Fn> = {
  roe: (p) => num(p.raw.ROE_AVG),
  netMargin: (p) => num(p.raw.NET_PROFIT_RATIO),
  operatingMargin: (p) => {
    const op = num(p.raw.OPERATE_PROFIT);
    const inc = num(p.raw.OPERATE_INCOME);
    return op !== null && inc !== null && inc !== 0 ? (op / inc) * 100 : null;
  },
  mainMargin: (p) => num(p.raw.GROSS_PROFIT_RATIO),
  roa: (p) => num(p.raw.ROA),
  revenueGrowth: (p) => num(p.raw.OPERATE_INCOME_YOY),
  profitGrowth: (p) => num(p.raw.HOLDER_PROFIT_YOY),
  equityGrowth: (p, _i, all) => yoyOf(p, all, 'TOTAL_PARENT_EQUITY'),
  assetGrowth: (p, _i, all) => yoyOf(p, all, 'TOTAL_ASSETS'),
  debtRatio: (p) => num(p.raw.DEBT_ASSET_RATIO),
  currentRatio: (p) => num(p.raw.CURRENT_RATIO),
  quickRatio: () => null,
  cashRatio: () => null,
  equityRatio: (p) => {
    const eq = num(p.raw.TOTAL_PARENT_EQUITY);
    const ta = num(p.raw.TOTAL_ASSETS);
    return eq !== null && ta !== null && ta !== 0 ? (eq / ta) * 100 : null;
  },
  ocfPerShare: (p) => num(p.raw.PER_NETCASH_OPERATE),
  ocfToRevenue: (p) => {
    const ocf = num(p.raw.NETCASH_OPERATE);
    const inc = num(p.raw.OPERATE_INCOME);
    return ocf !== null && inc !== null && inc !== 0 ? (ocf / inc) * 100 : null;
  },
  ocfToProfit: (p) => {
    const ocf = num(p.raw.NETCASH_OPERATE);
    const np = num(p.raw.HOLDER_PROFIT);
    return ocf !== null && np !== null && np !== 0 ? (ocf / np) * 100 : null;
  },
  cashFlowRatio: () => null,
  eps: (p) => num(p.raw.BASIC_EPS),
  bps: (p) => num(p.raw.BPS),
  undistPerShare: () => null,
};

/** 同比：与上年同期（同月日）比较 */
function yoyOf(p: IndicatorPoint, all: IndicatorPoint[], key: string): number | null {
  const cur = num(p.raw[key]);
  const md = p.date.slice(5);
  const prevYear = Number(p.date.slice(0, 4)) - 1;
  const prev = all.find((x) => x.date === `${prevYear}-${md}`);
  const pv = prev ? num(prev.raw[key]) : null;
  if (cur === null || pv === null || pv === 0) return null;
  return ((cur - pv) / Math.abs(pv)) * 100;
}

/** 港股指标序列 → 与 A 股 CompanyFinancials 同形 */
export async function fetchHkFinancials(
  secucode: string,
  code: string,
  years = 6,
  name?: string,
): Promise<CompanyFinancials> {
  const points = await fetchHkIndicatorPoints(secucode, years + 2);
  if (points.length === 0) throw new Error(`港股财务指标：${code} 未取得任何报告期数据`);
  const crop = new Date();
  crop.setUTCFullYear(crop.getUTCFullYear() - years);
  const kept = points.filter((p) => new Date(`${p.date}T00:00:00Z`) >= crop);
  const periods = kept.map((p) => p.date);
  const series: Record<string, (number | null)[]> = {};
  for (const [key, fn] of Object.entries(METRIC_FNS)) {
    series[key] = kept.map((p, i) => fn(p, i, kept));
  }
  return {
    code,
    name: name ?? code,
    periods,
    periodLabels: periods.map((d) => periodLabel(d)),
    series,
    source: PROVIDER_NAME,
  };
}

/** 报告期 → 展示标签（与 A 股口径一致） */
export function periodLabel(date: string): string {
  const md = date.slice(5);
  const y = date.slice(2, 4);
  if (md === '12-31') return `${y}H2`;
  if (md === '06-30') return `${y}H1`;
  if (md === '03-31') return `${y}Q1`;
  if (md === '09-30') return `${y}Q3`;
  return date.slice(2);
}

/* ------------------------------------------------- 三大报表（长表） */

const STATEMENT_REPORTS: Record<'balance' | 'profit' | 'cashflow', string> = {
  balance: 'RPT_HKF10_FN_BALANCE_PC',
  profit: 'RPT_HKF10_FN_INCOME_PC',
  cashflow: 'RPT_HKF10_FN_CASHFLOW_PC',
};

export type StatementId = 'balance' | 'profit' | 'cashflow';

export interface HkStatementRow {
  date: string;
  itemCode: string;
  itemName: string;
  /** 元（账本币种） */
  amount: number | null;
}

/** 按报告期集合拉取一张表的全部科目行 */
export async function fetchHkStatement(
  secucode: string,
  id: StatementId,
  dates: string[],
): Promise<HkStatementRow[]> {
  if (dates.length === 0) return [];
  const inList = dates.map((d) => `'${d}'`).join(',');
  const rows = await dcQuery(STATEMENT_REPORTS[id], `(SECUCODE="${secucode}")(REPORT_DATE in (${inList}))`);
  return rows
    .map((r) => {
      const d = reportDate(r);
      if (!d) return null;
      const itemCode = String(r.STD_ITEM_CODE ?? '');
      const itemName = String(r.STD_ITEM_NAME ?? r.ITEM_NAME ?? '').trim();
      return {
        date: d,
        itemCode,
        itemName,
        amount: num(r.AMOUNT),
      };
    })
    .filter((x): x is HkStatementRow => x !== null && x.itemName !== '');
}

/** 账本币种（取资产负债表任一行的 CURRENCY） */
export async function fetchHkCurrency(secucode: string): Promise<string | null> {
  try {
    const rows = await dcQuery(
      'RPT_HKF10_FN_BALANCE_PC',
      `(SECUCODE="${secucode}")`,
      // 只取最近报告期：服务端按 REPORT_DATE 排序，第一页首行即最新
    );
    return rows[0]?.CURRENCY ?? null;
  } catch {
    return null;
  }
}

/** 元 → 万元（与 A 股新浪「万元」口径对齐） */
const yuanToWan = (v: number | null): number | null => (v === null ? null : v / 1e4);

/** 字段 key：bs_i1234 形式（i + 东财科目代码），label 用披露科目名 */
export const itemKey = (prefix: 'bs' | 'pl' | 'cf', itemCode: string) => `${prefix}_i${itemCode}`;

/** 三大报表字段目录（供自定义指标选择器） */
export async function fetchHkCatalog(secucode: string): Promise<StatementCatalog[]> {
  const ids: StatementId[] = ['balance', 'profit', 'cashflow'];
  const labels: Record<StatementId, string> = {
    balance: '资产负债表',
    profit: '利润表',
    cashflow: '现金流量表',
  };
  const prefixes: Record<StatementId, 'bs' | 'pl' | 'cf'> = { balance: 'bs', profit: 'pl', cashflow: 'cf' };

  const allDates = (await fetchHkIndicatorPoints(secucode, 12)).map((p) => p.date);
  const sampleDates = allDates.slice(-8);
  const catalogs = await Promise.all(
    ids.map(async (id) => {
      const rows = await fetchHkStatement(secucode, id, sampleDates);
      const seen = new Map<string, string>(); // itemCode → itemName
      for (const r of rows) if (!seen.has(r.itemCode)) seen.set(r.itemCode, r.itemName);
      const items = Array.from(seen.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([ic, nm]) => ({
          key: itemKey(prefixes[id], ic),
          sina: nm,
          label: nm,
          group: '全部科目',
          statement: id,
          unit: 'wan' as const,
        }));
      return {
        id,
        label: labels[id],
        unit: '万元',
        groups: [{ label: '全部科目', fields: items }],
        total: items.length,
      } satisfies StatementCatalog;
    }),
  );
  return catalogs;
}

/** 自定义字段多年序列（与 sinaStatements.fetchCustomFinancials 同形） */
export async function fetchHkCustomFinancials(
  secucode: string,
  code: string,
  fields: string[],
  years = 6,
  name?: string,
): Promise<CustomFinancials> {
  const points = await fetchHkIndicatorPoints(secucode, years + 2);
  if (points.length === 0) throw new Error(`港股财报：${code} 未取得任何报告期数据`);
  const allDates = points.map((p) => p.date);

  const statementFields = fields.filter((k) => /^(bs|pl|cf)_/i.test(k));
  const indicatorKeys = fields.filter((k) => !/^(bs|pl|cf)_/i.test(k));

  const byDate = new Map<string, Map<string, number | null>>();
  for (const d of allDates) byDate.set(d, new Map());

  const tasks: Promise<void>[] = [];

  // 三表科目
  const need = new Map<StatementId, Set<string>>();
  for (const f of statementFields) {
    const m = /^(bs|pl|cf)_i(.+)$/i.exec(f);
    if (!m) continue;
    const id = (m[1].toLowerCase() === 'bs' ? 'balance' : m[1].toLowerCase() === 'pl' ? 'profit' : 'cashflow') as StatementId;
    if (!need.has(id)) need.set(id, new Set());
    need.get(id)!.add(m[2]);
  }
  for (const [id, codes] of need) {
    tasks.push(
      (async () => {
        const rows = await fetchHkStatement(secucode, id, allDates).catch(() => []);
        for (const r of rows) {
          if (!codes.has(r.itemCode)) continue;
          const rec = byDate.get(r.date);
          if (rec) rec.set(itemKey(id === 'balance' ? 'bs' : id === 'profit' ? 'pl' : 'cf', r.itemCode), yuanToWan(r.amount));
        }
      })(),
    );
  }

  // 指标
  if (indicatorKeys.length > 0) {
    tasks.push(
      (async () => {
        for (const p of points) {
          const rec = byDate.get(p.date);
          if (!rec) continue;
          for (const k of indicatorKeys) {
            const fn = METRIC_FNS[k];
            if (fn) rec.set(k, fn(p, allDates.indexOf(p.date), points));
          }
        }
      })(),
    );
  }

  await Promise.all(tasks);

  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  const periods = allDates.filter((d) => new Date(`${d}T00:00:00Z`) >= cutoff);
  const series: Record<string, (number | null)[]> = {};
  for (const key of fields) {
    series[key] = periods.map((d) => byDate.get(d)?.get(key) ?? null);
  }
  if (periods.length === 0) throw new Error(`港股财报：${code} 未取得任何报告期数据`);

  return {
    code,
    name: name ?? code,
    periods,
    periodLabels: periods.map((d) => periodLabel(d)),
    series,
    source: PROVIDER_NAME,
  };
}

/* ------------------------------------------------------- 估值历史 */

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return null as unknown as number;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function statsOf(values: (number | null)[], cur: number | null): SeriesStats {
  const vals = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const sorted = [...vals].sort((a, b) => a - b);
  const pct =
    cur !== null && sorted.length > 0
      ? (sorted.filter((v) => v <= cur).length / sorted.length) * 100
      : null;
  return {
    current: cur,
    percentile: pct,
    p80: sorted.length ? quantile(sorted, 0.8) : null,
    p50: sorted.length ? quantile(sorted, 0.5) : null,
    p20: sorted.length ? quantile(sorted, 0.2) : null,
    max: sorted.length ? sorted[sorted.length - 1] : null,
    avg: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    min: sorted.length ? sorted[0] : null,
    count: vals.length,
  };
}

/** 阶梯取值：日期 d 适用的最近一期报告值 */
function stepValue<T>(points: { date: string; value: T }[], d: string): T | null {
  let out: T | null = null;
  for (const p of points) {
    if (p.date <= d) out = p.value;
    else break;
  }
  return out;
}

/**
 * 港股估值历史：收盘价 ÷ 东财披露 EPS_TTM / BPS（未复权价）。
 * 报告生效日按报告截止日近似（港股无公开的精确公告日接口），误差通常数日内。
 */
export async function buildHkValuation(
  secucode: string,
  code: string,
  candles: Candle[],
  quote: { price: number | null; pe: number | null; name?: string },
  years = 10,
): Promise<Valuation> {
  const points = await fetchHkIndicatorPoints(secucode, years + 3);
  if (points.length === 0) throw new Error(`港股估值：${code} 无财报指标`);
  const currency = (await fetchHkCurrency(secucode)) ?? '';
  // 账本币种为人民币时，把每股指标换算到港币口径再与港股价相除
  const cnyToHkd = currency.includes('人民币') ? await fetchCnyToHkd() : null;

  const epsTtm: { date: string; value: number | null }[] = [];
  const bpsPts: { date: string; value: number | null }[] = [];
  const dyPts: { date: string; value: number | null }[] = [];
  for (const p of points) {
    const eps = num(p.raw.EPS_TTM);
    const bps = num(p.raw.BPS);
    const dy = num(p.raw.DIVIDEND_RATE);
    const fx = cnyToHkd ?? 1;
    epsTtm.push({ date: p.date, value: eps !== null ? eps * fx : null });
    bpsPts.push({ date: p.date, value: bps !== null ? bps * fx : null });
    dyPts.push({ date: p.date, value: dy });
  }

  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  const cut = cutoff.toISOString().slice(0, 10);
  const hist: ValuationPoint[] = [];
  for (const c of candles) {
    if (c.date < cut) continue;
    const eps = stepValue(epsTtm, c.date);
    const bps = stepValue(bpsPts, c.date);
    const dy = stepValue(dyPts, c.date);
    hist.push({
      date: c.date,
      pe: eps !== null && eps > 0 ? c.close / eps : null,
      pb: bps !== null && bps > 0 ? c.close / bps : null,
      close: c.close,
      dy,
    });
  }
  if (hist.length === 0) throw new Error(`港股估值：${code} 价格与财报无法对齐`);

  const latest = points[points.length - 1];
  const latestEps = num(latest.raw.EPS_TTM);
  const latestBps = num(latest.raw.BPS);
  const latestDy = num(latest.raw.DIVIDEND_RATE);
  const fx = cnyToHkd ?? 1;
  const price = quote.price;
  const curPe = quote.pe ?? (price !== null && latestEps ? price / (latestEps * fx) : null);
  const curPb = price !== null && latestBps ? price / (latestBps * fx) : null;
  const npTtm = latestEps !== null ? (num(latest.raw.ISSUED_COMMON_SHARES) ?? 0) * latestEps / 1e8 : null;

  const warnings: string[] = [
    '港股估值口径：收盘价（未复权）÷ 东方财富披露的 EPS_TTM / 每股净资产；报告生效日按报告截止日近似，未使用真实公告日。',
  ];
  if (currency.includes('人民币')) {
    warnings.push(
      cnyToHkd
        ? `公司账本币种为人民币，每股指标已按即期汇率（1 CNY ≈ ${cnyToHkd.toFixed(4)} HKD）换算到港币口径。`
        : '公司账本币种为人民币，汇率换算暂不可用，估值可能存在币种偏差。',
    );
  }

  const stats: ValuationStats = {
    pe: statsOf(hist.map((h) => h.pe), curPe),
    pb: statsOf(hist.map((h) => h.pb), curPb),
    dy: statsOf(hist.map((h) => h.dy), latestDy),
    from: hist[0].date,
    to: hist[hist.length - 1].date,
  };

  return {
    code,
    pe: curPe,
    pb: curPb,
    pePercentile: stats.pe.percentile,
    pbPercentile: stats.pb.percentile,
    dividendYield: latestDy,
    dyPercentile: stats.dy.percentile,
    roe: num(latest.raw.ROE_YEARLY),
    netProfit: npTtm,
    netAssets: latestBps !== null ? ((num(latest.raw.ISSUED_COMMON_SHARES) ?? 0) * latestBps) / 1e8 : null,
    history: hist,
    basis: 'real',
    warnings,
    years,
    stats,
    method: 'disclosure',
    source: PROVIDER_NAME,
    stale: false,
    fin: {
      report: latest.date,
      npTTM: npTtm,
      shares: (num(latest.raw.ISSUED_COMMON_SHARES) ?? 0) / 1e8,
      bps: latestBps,
      points: points.length,
      realDates: false,
      adjustGaps: 0,
    },
  };
}
