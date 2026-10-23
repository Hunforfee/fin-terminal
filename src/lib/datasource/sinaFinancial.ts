/**
 * 新浪财经-财务指标 Provider（真实三表衍生指标）。
 *
 * 端点：https://money.finance.sina.com.cn/corp/go.php/vFD_FinancialGuideLine/stockid/{code}/ctrl/{year}/displaytype/4.phtml
 * 返回 HTML 表格（GBK）：每年一页，每页含该年 4 个报告期 × 约 85 项指标。
 *
 * 已实测可用（2026-10），覆盖：盈利能力 / 成长性 / 偿债能力 / 现金流 / 每股指标，
 * 全部为交易所披露口径的真实财报数据，可直接用于财务体检与双公司对比。
 *
 * 解析说明：表格第一行是「报告日期」，其后每行 = 指标名 + 各期数值（'--' 表示未披露）。
 */

import { fetchText } from './http';
import { cachedMarketInput } from '../marketInputs';
import { missingIndicatorReports } from '../financialPageQuality';
import { fetchDebtRatios } from './debtRatios';
import { fetchEastmoneyIndicators, financialPageSource, type IndicatorSourcePage } from './eastmoneyStatements';

const URL_TEMPLATE =
  'https://money.finance.sina.com.cn/corp/go.php/vFD_FinancialGuideLine/stockid/{code}/ctrl/{year}/displaytype/4.phtml';

export const PROVIDER_NAME = 'sina-financial';

/* ------------------------------------------------------- 指标目录 */

export * from './financeIndicators';
import { INDICATORS } from './financeIndicators';

/* ------------------------------------------------------- 解析 */

export interface ReportPoint {
  /** 报告期，如 2023-12-31 */
  date: string;
  /** 指标 key → 数值（未披露为 null） */
  values: Record<string, number | null>;
}

interface ParsedPage {
  dates: string[];
  /** 新浪指标名 → 各期原始值 */
  rows: Map<string, (string | null)[]>;
}

function parsePage(html: string): ParsedPage {
  const dates: string[] = [];
  const rows = new Map<string, (string | null)[]>();

  // 报告日期行
  const dateRow = html.match(/<strong>报告日期<\/strong><\/td>((?:<td>[^<]*<\/td>)+)/);
  if (dateRow) {
    for (const d of dateRow[1].matchAll(/<td>([^<]+)<\/td>/g)) dates.push(d[1].trim());
  }

  // 指标行：<td width='200px'...><a...>名</a></td><td>v</td>...
  const rowRe = /<td width='200px'[^>]*>(?:<a[^>]*>)?([^<]+)(?:<\/a>)?<\/td>((?:<td>[^<]*<\/td>)+)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const name = m[1].trim();
    const vals = Array.from(m[2].matchAll(/<td>([^<]*)<\/td>/g)).map((x) => x[1].trim());
    if (name && !rows.has(name)) rows.set(name, vals);
  }
  return { dates, rows };
}

function toNum(s: string | null | undefined): number | null {
  if (!s || s === '--' || s === '') return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** 报告期 → 展示标签：2021H1 / 2021H2 / 2021Q1 / 2021Q3 */
export function periodLabel(date: string): string {
  const m = date.match(/^(\d{2})(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return date;
  const y = m[1] + m[2];
  const md = `${m[3]}-${m[4]}`;
  if (md === '12-31') return `${y}H2`;
  if (md === '06-30') return `${y}H1`;
  if (md === '03-31') return `${y}Q1`;
  if (md === '09-30') return `${y}Q3`;
  return date.slice(2);
}

export interface CompanyFinancials {
  periodKinds?: Record<string, string>;
  currency?: string;
  code: string;
  name: string;
  /** 报告期（升序） */
  periods: string[];
  /** 报告期展示标签 */
  periodLabels: string[];
  /** 指标 key → 各期数值（与 periods 对齐） */
  series: Record<string, (number | null)[]>;
  source: string;
}

/**
 * 抓取近 N 年财务指标（每年一页，并发抓取后按报告期合并升序）。
 * name 用于前端展示，由调用方传入（来自行情接口更可靠）。
 */
export async function fetchSinaFinancial(
  code: string,
  years = 6,
  name?: string,
): Promise<CompanyFinancials> {
  const thisYear = new Date().getFullYear();
  const yearList: number[] = [];
  for (let y = thisYear; yearList.length < Math.min(10,Math.max(1,years))+1 && y >= 1998; y--) yearList.push(y);

  const pages = await Promise.all(
    yearList.map(async (y) => {
      try {
        return await fetchIndicatorSourceYear(code,y);
      } catch {
        return null;
      }
    }),
  );

  const byDate = new Map<string, Record<string, number | null>>();
  for (const p of pages) {
    if (!p || p.dates.length === 0) continue;
    for (let i = 0; i < p.dates.length; i++) {
      const date = p.dates[i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const rec = byDate.get(date) ?? {};
      for (const def of INDICATORS) {
        const raw = p.rows.get(def.sina);
        if (raw && raw[i] !== undefined) rec[def.key] = toNum(raw[i]);
      }
      byDate.set(date, rec);
    }
  }

  const debt = await fetchDebtRatios(code, years).catch(() => new Map<string, number | null>());
  for (const [date, value] of debt) {
    const rec = byDate.get(date) ?? {};
    rec.interestDebtRatio = value;
    byDate.set(date, rec);
  }
  const periods = Array.from(byDate.keys()).sort();
  const series: Record<string, (number | null)[]> = {};
  for (const def of INDICATORS) {
    series[def.key] = periods.map((d) => byDate.get(d)?.[def.key] ?? null);
  }

  if (periods.length === 0) {
    throw new Error(`新浪财务指标：${code} 未取得任何报告期数据`);
  }

  return {
    code,
    name: name ?? code,
    periods,
    periodLabels: periods.map(periodLabel),
    series,
    source: [...new Set([...pages.filter((p):p is IndicatorSourcePage=>!!p).map(p=>financialPageSource(p,'sina:reported-indicators')),
      ...(debt.size?['eastmoney:explicit-interest-debt-ratio']:[])])].join(' + '),
  };
}

/** Annual source unit for bounded background collection; foreground readers share these rows. */
export function fetchIndicatorSourceYear(code:string,year:number,options: { forceRefresh?: boolean; requiredDates?:string[] } = {}){
  const url=URL_TEMPLATE.replace('{code}',code).replace('{year}',String(year));
  const age=new Date().getUTCFullYear()-year;
  const validate=(value:IndicatorSourcePage)=>{if(!value.dates.length || !value.rows.size
    || ![...value.rows.values()].some(values=>values.some(v=>toNum(v)!==null)))throw Error('财务指标来源为空');
    const missing=missingIndicatorReports(value,options.requiredDates??[]);
    if(missing.length)throw Error(`财务指标缺少有效报告期: ${missing.join(',')}`);
  };
  return cachedMarketInput<IndicatorSourcePage>(`source-sina-indicators:v1:${code}:${year}`,'source-sina-indicators','sina:reported-indicators',age<=1?1800e3:7*864e5,
    async()=>{
      try{const value=parsePage(await fetchText(url,{encoding:'gbk',timeoutMs:10000,retries:0}));validate(value);return value;}
      catch(primary){
        try{const value=await fetchEastmoneyIndicators(code,year);validate(value);return value;}
        catch(backup){throw Error(`公网财务指标均不可用（新浪：${primary instanceof Error?primary.message:'不可用'}；东方财富：${backup instanceof Error?backup.message:'不可用'}）`);}
      }
    },validate,value=>financialPageSource(value,'sina:reported-indicators'),options);
}

/**
 * 报告期粒度筛选：
 * - annual  年报：仅 12-31
 * - semi    中报：06-30 + 12-31（半年报口径，理杏仁默认视图）
 * - quarter 季报：03-31 / 06-30 / 09-30 / 12-31 全部报告期
 */
export type Granularity = 'annual' | 'semi' | 'quarter';

export function matchesGranularity(date: string, g: Granularity): boolean {
  if (g === 'annual') return date.endsWith('-12-31');
  if (g === 'semi') return date.endsWith('-12-31') || date.endsWith('-06-30');
  return true;
}

/** 按报告期粒度筛选（年报 / 中报 / 季报） */
export function filterByGranularity(f: CompanyFinancials, g: Granularity = 'semi'): CompanyFinancials {
  if (g === 'quarter') return f;
  const keep = f.periods
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => matchesGranularity(p, g));
  return {
    ...f,
    periods: keep.map((k) => k.p),
    periodLabels: keep.map((k) => f.periodLabels[k.i]),
    series: Object.fromEntries(
      Object.entries(f.series).map(([k, arr]) => [k, keep.map((x) => arr[x.i])]),
    ),
  };
}

