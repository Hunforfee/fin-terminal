import { fetchJson, UpstreamError } from './http';

/**
 * 扣非市盈率（PE-TTM，扣除非经常性损益）。
 *
 * PE-TTM = 总市值 / 最近四个季度扣非归母净利润之和。
 * 口径要点（与同花顺 / 理杏仁「扣非 PE-TTM」一致）：
 * - 单季扣非净利润 = 本报告期累计值 − 上一年度同口径累计值，
 *   一季报本身即为单季，无需相减；
 * - 只有四个单季齐全才给出结果，缺一期就留空，绝不用年报或预估数补位；
 * - 净利润 ≤ 0 时市盈率无经济含义，按惯例留空（显示「—」）。
 *
 * 数据源：东方财富 F10 主要财务指标（RPT_F10_FINANCE_MAINFINADATA），
 * 字段 KCFJCXSYJLR 为「扣除非经常性损益后的归母净利润」累计值，单位元。
 */

export interface DeductedPeriod {
  /** 报告期 YYYY-MM-DD */
  reportDate: string;
  /** 累计扣非归母净利润（元） */
  cumulative: number;
}

export interface DeductedPeResult {
  /** 扣非 PE-TTM，null 表示数据不足或不可比 */
  pe: number | null;
  /** 参与计算的四个单季净利润之和（元） */
  ttmProfit: number | null;
  /** 四个单季对应的报告期，按时间升序 */
  quarters: string[];
  /** 不可用原因，便于排查（不对外展示原始金额） */
  reason?: 'no-data' | 'incomplete' | 'non-positive';
}

type Row = Record<string, unknown>;
type Response = { success: boolean; result?: { pages: number; data: Row[] } | null };

const MIN_TS = 0;
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const dateOnly = (v: unknown): string => {
  const s = typeof v === 'string' ? v.slice(0, 10) : '';
  return /^\d{4}-(03-31|06-30|09-30|12-31)$/.test(s) ? s : '';
};

export function parseDeductedPeriods(rows: Row[]): DeductedPeriod[] {
  const out: DeductedPeriod[] = [];
  for (const row of rows) {
    const reportDate = dateOnly(row.REPORT_DATE);
    const cumulative = num(row.KCFJCXSYJLR);
    if (!reportDate || cumulative === null) continue;
    out.push({ reportDate, cumulative });
  }
  return out.sort((a, b) => a.reportDate.localeCompare(b.reportDate));
}

/**
 * 单季扣非净利润。
 * KCFJCXSYJLR 全为「年初至今累计」：
 *   一季报 = Q1
 *   中报 − 一季报 = Q2
 *   三季报 − 中报 = Q3
 *   年报 − 三季报 = Q4   ← 注意是减同一年的三季报，不是减上年年报
 */
export function singleQuarter(periods: DeductedPeriod[], reportDate: string): number | null {
  const cur = periods.find((p) => p.reportDate === reportDate);
  if (!cur) return null;
  const md = reportDate.slice(5);
  const year = reportDate.slice(0, 4);
  // 本年内上一个累计口径的报告期
  const prevMd =
    md === '06-30' ? '03-31' : md === '09-30' ? '06-30' : md === '12-31' ? '09-30' : null;
  if (prevMd === null) return cur.cumulative; // 一季报直接就是单季
  const prev = periods.find((p) => p.reportDate === `${year}-${prevMd}`);
  return prev ? cur.cumulative - prev.cumulative : null;
}

/**
 * 计算扣非 PE-TTM。
 * @param periods 已按报告期升序排列的累计扣非净利润
 * @param marketCap 总市值（元）
 */
export function computeDeductedPe(periods: DeductedPeriod[], marketCap: number | null): DeductedPeResult {
  if (periods.length === 0) return { pe: null, ttmProfit: null, quarters: [], reason: 'no-data' };
  // 从最新报告期往前找连续四个「单季可算」的报告期
  const sorted = [...periods].sort((a, b) => b.reportDate.localeCompare(a.reportDate));
  const latest = sorted[0].reportDate;
  const quarters: string[] = [];
  const values: number[] = [];
  for (let i = 0; i < 4; i++) {
    const d = shiftQuarter(latest, -i);
    const v = singleQuarter(periods, d);
    if (v === null) return { pe: null, ttmProfit: null, quarters, reason: 'incomplete' };
    quarters.push(d);
    values.push(v);
  }
  const ttmProfit = Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;
  if (ttmProfit <= 0) return { pe: null, ttmProfit, quarters, reason: 'non-positive' };
  const cap = marketCap !== null && marketCap > 0 ? marketCap : null;
  if (cap === null || cap < MIN_TS) return { pe: null, ttmProfit, quarters, reason: 'no-data' };
  return { pe: Math.round((cap / ttmProfit) * 100) / 100, ttmProfit, quarters };
}

/** 报告期按季度平移，始终保持 03-31 / 06-30 / 09-30 / 12-31 之一 */
export function shiftQuarter(reportDate: string, delta: number): string {
  const ends = ['03-31', '06-30', '09-30', '12-31'];
  const idx = ends.indexOf(reportDate.slice(5));
  const year = Number(reportDate.slice(0, 4));
  const abs = year * 4 + (idx < 0 ? 0 : idx) + delta;
  return `${Math.floor(abs / 4)}-${ends[((abs % 4) + 4) % 4]}`;
}

/** 取最近 10 个报告期的累计扣非净利润（足够推算 4 个单季） */
export async function fetchDeductedPeriods(code: string): Promise<DeductedPeriod[]> {
  if (!/^\d{6}$/.test(code)) throw new Error('股票代码无效');
  const url = new URL('https://datacenter-web.eastmoney.com/api/data/v1/get');
  url.search = new URLSearchParams({
    reportName: 'RPT_F10_FINANCE_MAINFINADATA',
    // 该报表接口要求 columns=ALL，指定列名会返回空结果
    columns: 'ALL',
    filter: `(SECURITY_CODE="${code}")`,
    pageSize: '10',
    sortColumns: 'REPORT_DATE',
    sortTypes: '-1',
  }).toString();
  const data = await fetchJson<Response>(url.toString(), {
    timeoutMs: 15000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    },
  });
  if (!data.success || !Array.isArray(data.result?.data)) {
    throw new UpstreamError('扣非净利润数据不可用', url.toString(), 'parse');
  }
  return parseDeductedPeriods(data.result.data);
}
