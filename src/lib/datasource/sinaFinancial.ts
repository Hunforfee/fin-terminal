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

const URL_TEMPLATE =
  'https://money.finance.sina.com.cn/corp/go.php/vFD_FinancialGuideLine/stockid/{code}/ctrl/{year}/displaytype/4.phtml';

export const PROVIDER_NAME = 'sina-financial';

/* ------------------------------------------------------- 指标目录 */

export type IndicatorGroup = 'profit' | 'growth' | 'solvency' | 'cashflow' | 'pershare';

export interface IndicatorDef {
  key: string;
  /** 新浪页面上的指标名（用于解析定位） */
  sina: string;
  label: string;
  group: IndicatorGroup;
  /** 数值单位：pct=百分比，yuan=元，ratio=倍，wan=万元（三大报表口径） */
  unit: 'pct' | 'yuan' | 'ratio' | 'wan';
  /** 数值越小越好的指标（用于着色语义） */
  lowerBetter?: boolean;
}

/** 统一指标目录 —— 页面与图表都以此为准 */
export const INDICATORS: IndicatorDef[] = [
  // 盈利能力
  { key: 'roe', sina: '净资产收益率(%)', label: '净资产收益率 ROE', group: 'profit', unit: 'pct' },
  { key: 'netMargin', sina: '销售净利率(%)', label: '销售净利率', group: 'profit', unit: 'pct' },
  { key: 'operatingMargin', sina: '营业利润率(%)', label: '营业利润率', group: 'profit', unit: 'pct' },
  { key: 'mainMargin', sina: '主营业务利润率(%)', label: '主营业务利润率', group: 'profit', unit: 'pct' },
  { key: 'roa', sina: '资产报酬率(%)', label: '总资产报酬率 ROA', group: 'profit', unit: 'pct' },
  // 成长性
  { key: 'revenueGrowth', sina: '主营业务收入增长率(%)', label: '营业收入增长率', group: 'growth', unit: 'pct' },
  { key: 'profitGrowth', sina: '净利润增长率(%)', label: '净利润增长率', group: 'growth', unit: 'pct' },
  { key: 'equityGrowth', sina: '净资产增长率(%)', label: '净资产增长率', group: 'growth', unit: 'pct' },
  { key: 'assetGrowth', sina: '总资产增长率(%)', label: '总资产增长率', group: 'growth', unit: 'pct' },
  // 偿债能力
  { key: 'debtRatio', sina: '资产负债率(%)', label: '资产负债率', group: 'solvency', unit: 'pct', lowerBetter: true },
  { key: 'currentRatio', sina: '流动比率', label: '流动比率', group: 'solvency', unit: 'ratio' },
  { key: 'quickRatio', sina: '速动比率', label: '速动比率', group: 'solvency', unit: 'ratio' },
  { key: 'cashRatio', sina: '现金比率(%)', label: '现金比率', group: 'solvency', unit: 'pct' },
  { key: 'equityRatio', sina: '股东权益比率(%)', label: '股东权益比率', group: 'solvency', unit: 'pct' },
  // 现金流
  { key: 'ocfPerShare', sina: '每股经营性现金流(元)', label: '每股经营现金流', group: 'cashflow', unit: 'yuan' },
  { key: 'ocfToRevenue', sina: '经营现金净流量对销售收入比率(%)', label: '经营现金流 / 营业收入', group: 'cashflow', unit: 'pct' },
  { key: 'ocfToProfit', sina: '经营现金净流量与净利润的比率(%)', label: '经营现金流 / 净利润', group: 'cashflow', unit: 'pct' },
  { key: 'cashFlowRatio', sina: '现金流量比率(%)', label: '现金流量比率', group: 'cashflow', unit: 'pct' },
  // 每股指标
  { key: 'eps', sina: '摊薄每股收益(元)', label: '每股收益 EPS', group: 'pershare', unit: 'yuan' },
  { key: 'bps', sina: '每股净资产_调整前(元)', label: '每股净资产 BPS', group: 'pershare', unit: 'yuan' },
  { key: 'undistPerShare', sina: '每股未分配利润(元)', label: '每股未分配利润', group: 'pershare', unit: 'yuan' },
];

export const GROUP_META: Record<IndicatorGroup, { label: string; desc: string }> = {
  profit: { label: '盈利能力', desc: '赚钱的效率与质量' },
  growth: { label: '成长性', desc: '收入与利润的扩张速度' },
  solvency: { label: '偿债能力', desc: '负债水平与短期流动性' },
  cashflow: { label: '现金流', desc: '经营造血能力' },
  pershare: { label: '每股指标', desc: '按股本折算的股东视角' },
};

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
  for (let y = thisYear; yearList.length < years && y >= 1998; y--) yearList.push(y);

  const pages = await Promise.all(
    yearList.map(async (y) => {
      const url = URL_TEMPLATE.replace('{code}', code).replace('{year}', String(y));
      try {
        const html = await fetchText(url, { encoding: 'gbk', timeoutMs: 10000 });
        return parsePage(html);
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
    source: PROVIDER_NAME,
  };
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

