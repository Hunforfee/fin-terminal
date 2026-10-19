/**
 * 主营业务数据源（东方财富 F10，公开接口、无需鉴权）：
 *   CompanySurvey   → jbzl[0].ORG_PROFILE（公司简介 / 主营定位）
 *                    jbzl[0].INDUSTRYCSRC1（所属行业）
 *   BusinessAnalysis → zyfw[0].BUSINESS_SCOPE（经营范围）
 *                     jyps[0].BUSINESS_REVIEW（经营评述 / 管理层业务深度讨论，长文本）
 *                     zygcfx（主营构成，按 MAINOP_TYPE 分行业/产品/地区，多报告期）
 *
 * 已实测可用（沙箱 2026-10）：
 *   https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=SH600415
 *   https://emweb.securities.eastmoney.com/PC_HSF10/BusinessAnalysis/PageAjax?code=SH600415
 *
 * 说明：通达信 / iFinD 等 MCP 接口虽能返回更厚的聚合数据（如关联概念、公司地位），
 * 但其服务端需要私有 token，部署后的网站后端无法直接调用；上述东财公开 F10 已覆盖
 * 「深入主营业务」所需的核心字段（经营评述 + 三维主营构成 + 行业 + 公司定位）。
 */

import { fetchJson } from './http';
import { isResearchDate, todayResearchDate } from '../researchNotes';

export interface BusinessSegment {
  /** 业务 / 产品 / 地区名称 */
  name: string;
  /** 主营业务收入（元） */
  income: number | null;
  /** 收入占比（小数，0.53 = 53%） */
  incomeRatio: number | null;
  /** 主营毛利占比（小数），不是归母净利润占比 */
  profitRatio: number | null;
  /** 毛利率（小数） */
  grossMargin: number | null;
}

export interface BusinessGroup {
  /** 维度标签：按行业 / 按产品 / 按地区 */
  label: string;
  /** 该维度最新报告期 YYYY-MM-DD */
  date: string | null;
  items: BusinessSegment[];
}

export interface BusinessInfo {
  /** 公司简介（含主营业务定位描述） */
  summary: string | null;
  /** 经营范围 */
  scope: string | null;
  /** 所属行业（证监会 / 申万） */
  industry: string | null;
  /** 经营评述 / 业务深度分析（管理层讨论，长文本） */
  review: string | null;
  /** 经营评述对应报告期 YYYY-MM-DD */
  reviewDate: string | null;
  /** 主营构成（按行业 / 按产品 / 按地区，各取最新报告期） */
  groups: BusinessGroup[];
  /** 每日公司速读兼容字段：单报告期、单维度的主营构成。 */
  segments: BusinessSegment[];
  /** 报告期 YYYY-MM-DD */
  reportDate: string | null;
  source: string;
  /** One dimension and one report period only; categories must never be added across dimensions. */
  dimension?: '产品' | '行业' | '地区';
}

export function parseBusinessComposition(input: unknown): Pick<BusinessInfo,'segments'|'reportDate'|'dimension'> {
  const rows: any[] = (Array.isArray(input)?input:[]).filter(r=>cleanDate(r?.REPORT_DATE));
  rows.sort((a,b)=>String(b.REPORT_DATE).localeCompare(String(a.REPORT_DATE)));
  const reportDate=cleanDate(rows[0]?.REPORT_DATE);
  const period=rows.filter(r=>cleanDate(r.REPORT_DATE)===reportDate);
  const type=['2','1','3'].find(t=>period.some(r=>String(r.MAINOP_TYPE)===t));
  const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:null;
  const selected=type?period.filter(r=>String(r.MAINOP_TYPE)===type):[];
  const unique=new Map<string,BusinessSegment>();
  for (const r of selected) {
    const name=typeof r.ITEM_NAME==='string'?r.ITEM_NAME.trim():'';
    if(!name)continue;
    unique.set(name,{name,income:number(r.MAIN_BUSINESS_INCOME),incomeRatio:number(r.MBI_RATIO),profitRatio:number(r.MBR_RATIO),grossMargin:number(r.GROSS_RPOFIT_RATIO)});
  }
  return {reportDate,dimension:({'2':'产品','1':'行业','3':'地区'} as const)[type as '1'|'2'|'3'],segments:[...unique.values()].sort((a,b)=>(b.income??-Infinity)-(a.income??-Infinity)).slice(0,8)};
}

const EM_REFERER = 'https://emweb.securities.eastmoney.com/';

/** MAINOP_TYPE → 维度标签（1 行业 / 2 产品 / 3 地区） */
const MAINOP_LABELS: Record<string, string> = {
  '1': '按行业',
  '2': '按产品',
  '3': '按地区',
};

function cleanDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const d = raw.slice(0, 10);
  return isResearchDate(d) ? d : null;
}

export function parseBusinessReview(input: unknown, today = todayResearchDate()): Pick<BusinessInfo,'review'|'reviewDate'> {
  const rows = (Array.isArray(input) ? input : []).filter(row => {
    const date = cleanDate(row?.REPORT_DATE);
    return date && date <= today && typeof row?.BUSINESS_REVIEW === 'string' && row.BUSINESS_REVIEW.trim();
  }).sort((a,b) => String(b.REPORT_DATE).localeCompare(String(a.REPORT_DATE)));
  const latest = rows[0];
  return {review: latest?.BUSINESS_REVIEW.trim() || null, reviewDate: cleanDate(latest?.REPORT_DATE)};
}

function mapRow(r: any): BusinessSegment {
  return {
    name: r?.ITEM_NAME ?? '—',
    income: typeof r?.MAIN_BUSINESS_INCOME === 'number' ? r.MAIN_BUSINESS_INCOME : null,
    incomeRatio: typeof r?.MBI_RATIO === 'number' ? r.MBI_RATIO : null,
    profitRatio: typeof r?.MBR_RATIO === 'number' ? r.MBR_RATIO : null,
    grossMargin: typeof r?.GROSS_RPOFIT_RATIO === 'number' ? r.GROSS_RPOFIT_RATIO : null,
  };
}

async function fetchA(code: string): Promise<BusinessInfo> {
  const prefix = /^(4|8|9)/.test(code) ? 'BJ' : code.startsWith('6') ? 'SH' : 'SZ';
  const pj = `${prefix}${code}`;
  const opts = { timeoutMs: 12000, headers: { Referer: EM_REFERER } };

  const [survey, analysis] = await Promise.all([
    fetchJson<any>(
      `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=${pj}`,
      opts,
    ).catch(() => null),
    fetchJson<any>(
      `https://emweb.securities.eastmoney.com/PC_HSF10/BusinessAnalysis/PageAjax?code=${pj}`,
      opts,
    ).catch(() => null),
  ]);

  const jbzl = Array.isArray(survey?.jbzl) ? survey.jbzl[0] : undefined;
  const summary =
    jbzl?.ORG_PROFILE != null ? String(jbzl.ORG_PROFILE).trim() : null;
  const industry =
    jbzl?.INDUSTRYCSRC1 != null ? String(jbzl.INDUSTRYCSRC1).trim() : null;

  const zyfw = Array.isArray(analysis?.zyfw) ? analysis.zyfw[0] : undefined;
  const scope =
    zyfw?.BUSINESS_SCOPE ? String(zyfw.BUSINESS_SCOPE).trim() : null;

  // 主营构成：按 MAINOP_TYPE 分组，每组取各自最新报告期（行业多仅在年报披露）
  const rows = (Array.isArray(analysis?.zygcfx) ? analysis.zygcfx : [])
    .filter((r: any) => r && r.MAINOP_TYPE != null && r.ITEM_NAME);
  const groups: BusinessGroup[] = [];
  for (const t of ['1', '2', '3']) {
    const tr = rows
      .filter((r: any) => String(r.MAINOP_TYPE) === t)
      .slice()
      .sort((a: any, b: any) =>
        String(b?.REPORT_DATE ?? '').localeCompare(String(a?.REPORT_DATE ?? '')),
      );
    if (!tr.length) continue;
    const date = cleanDate(tr[0]?.REPORT_DATE);
    const items = tr
      .filter((r: any) => cleanDate(r.REPORT_DATE) === date)
      .map(mapRow)
      .slice(0, 12);
    groups.push({ label: MAINOP_LABELS[t], date, items });
  }

  return { summary, scope, industry, groups, ...parseBusinessReview(analysis?.jyps), ...parseBusinessComposition(analysis?.zygcfx), source: 'eastmoney-f10' };
}

export async function fetchBusiness(
  code: string,
  market: 'A' | 'HK',
): Promise<BusinessInfo | null> {
  if (market === 'HK') return null; // 港股暂未覆盖 F10 概况
  try {
    return await fetchA(code);
  } catch {
    return null;
  }
}
