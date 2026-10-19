/**
 * 主营业务数据源（东财 F10）：
 *   CompanySurvey  → jbzl[0].ORG_PROFILE（公司简介，含主营业务描述）
 *   BusinessAnalysis → zyfw[0].BUSINESS_SCOPE（经营范围）+ zygcfx（主营构成，按报告期）
 *
 * 已实测可用（沙箱 2026-10）：
 *   https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=SH600415
 *   https://emweb.securities.eastmoney.com/PC_HSF10/BusinessAnalysis/PageAjax?code=SH600415
 */

import { fetchJson } from './http';

export interface BusinessSegment {
  /** 业务/产品名称 */
  name: string;
  /** 主营业务收入（元） */
  income: number | null;
  /** 收入占比（小数，0.53 = 53%） */
  incomeRatio: number | null;
  /** 利润占比（小数） */
  profitRatio: number | null;
  /** 毛利率（小数） */
  grossMargin: number | null;
}

export interface BusinessInfo {
  /** 公司简介（含主营业务描述） */
  summary: string | null;
  /** 经营范围 */
  scope: string | null;
  /** 主营构成（按最新报告期，取前 N 项） */
  segments: BusinessSegment[];
  /** 报告期 YYYY-MM-DD */
  reportDate: string | null;
  source: string;
}

const EM_REFERER = 'https://emweb.securities.eastmoney.com/';

function cleanDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const d = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

async function fetchA(code: string): Promise<BusinessInfo> {
  const prefix = /^(4|8|9)/.test(code) ? 'BJ' : code.startsWith('6') ? 'SH' : 'SZ';
  const pj = `${prefix}${code}`;
  const opts = { timeoutMs: 10000, headers: { Referer: EM_REFERER } };

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
  const scope =
    Array.isArray(analysis?.zyfw) && analysis.zyfw[0]?.BUSINESS_SCOPE
      ? String(analysis.zyfw[0].BUSINESS_SCOPE).trim()
      : null;

  const rows = (Array.isArray(analysis?.zygcfx) ? analysis.zygcfx : [])
    .slice()
    .sort((a: any, b: any) =>
      String(b?.REPORT_DATE ?? '').localeCompare(String(a?.REPORT_DATE ?? '')),
    );
  const reportDate = cleanDate(rows[0]?.REPORT_DATE);
  const segments: BusinessSegment[] = rows.slice(0, 8).map((r: any) => ({
    name: r?.ITEM_NAME ?? '—',
    income: typeof r?.MAIN_BUSINESS_INCOME === 'number' ? r.MAIN_BUSINESS_INCOME : null,
    incomeRatio: typeof r?.MBI_RATIO === 'number' ? r.MBI_RATIO : null,
    profitRatio: typeof r?.MBR_RATIO === 'number' ? r.MBR_RATIO : null,
    grossMargin: typeof r?.GROSS_RPOFIT_RATIO === 'number' ? r.GROSS_RPOFIT_RATIO : null,
  }));

  return { summary, scope, segments, reportDate, source: 'eastmoney-f10' };
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
