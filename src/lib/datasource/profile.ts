/**
 * 公司资料 Provider：控股股东、实际控制人、所属行业。
 *
 * 已实测可用端点（沙箱 2026-10）：
 *   A 股  https://emweb.securities.eastmoney.com/PC_HSF10/ShareholderResearch/PageAjax?code=SH600519
 *         → sdgd（十大股东，rank1 即控股股东）、sjkzr（实际控制人）
 *   A 股行业：申万 2021 三级（本地 sw2021.json，5659 只全覆盖）
 *   港股  RPT_HKF10_INFO_ORGPROFILE → BELONG_INDUSTRY（东财港股行业，无股东数据）
 */

import { fetchJson } from './http';
import { swAllNodes } from '../sw2021';

export interface CompanyProfile {
  /** 控股股东名称 */
  holder: string | null;
  /** 控股股东持股比例 % */
  holderRatio: number | null;
  /** 实际控制人 */
  controller: string | null;
  /** 所属行业（A 股 = 申万三级行业；港股 = 东财行业） */
  industry: string | null;
  /** 行业路径（A 股为「一级 · 二级 · 三级」） */
  industryPath: string | null;
  source: string;
}

export const PROVIDER_NAME = 'eastmoney-f10';

/** 申万三级行业反查表（code → 节点），懒加载 */
let l3ByStock: Map<string, { l3: string; l2: string; l1: string }> | null = null;
function swL3Index() {
  if (l3ByStock) return l3ByStock;
  const m = new Map<string, { l3: string; l2: string; l1: string }>();
  for (const n of swAllNodes()) {
    if (n.level !== 3) continue;
    for (const c of n.stocks) {
      if (!m.has(c)) m.set(c, { l3: n.name, l2: n.l2 ?? '', l1: n.l1 });
    }
  }
  l3ByStock = m;
  return m;
}

interface PageAjaxRow {
  END_DATE?: string;
  HOLDER_RANK?: number;
  HOLDER_NAME?: string;
  HOLD_NUM_RATIO?: number;
}

interface PageAjax {
  sdgd?: PageAjaxRow[];
  sjkzr?: { HOLDER_NAME?: string }[];
}

/** A 股公司资料（东财 HSF10 聚合接口 + 本地申万三级） */
async function fetchAProfile(code: string): Promise<CompanyProfile> {
  const prefix = /^(4|8|9)/.test(code) ? 'BJ' : code.startsWith('6') ? 'SH' : 'SZ';
  const pjCode = `${prefix}${code}`;
  const j = await fetchJson<PageAjax>(
    `https://emweb.securities.eastmoney.com/PC_HSF10/ShareholderResearch/PageAjax?code=${pjCode}`,
    { timeoutMs: 10000, headers: { Referer: 'https://emweb.securities.eastmoney.com/' } },
  );
  // 控股股东 = 最新报告期 rank1 股东
  const rows = (j.sdgd ?? []).slice().sort((a, b) => String(b.END_DATE ?? '').localeCompare(String(a.END_DATE ?? '')));
  const top = rows.find((r) => r.HOLDER_RANK === 1) ?? rows[0] ?? null;
  const controller = j.sjkzr?.[0]?.HOLDER_NAME ?? null;

  const sw = swL3Index().get(code) ?? null;
  return {
    holder: top?.HOLDER_NAME ?? null,
    holderRatio: typeof top?.HOLD_NUM_RATIO === 'number' ? top.HOLD_NUM_RATIO : null,
    controller,
    industry: sw?.l3 ?? null,
    industryPath: sw ? `${sw.l1} · ${sw.l2} · ${sw.l3}` : null,
    source: PROVIDER_NAME,
  };
}

/** 港股公司资料（东财 HKF10 概况；暂无控股股东/实控人公开报表） */
async function fetchHkProfile(secucode: string): Promise<CompanyProfile> {
  const url =
    'https://datacenter.eastmoney.com/securities/api/data/v1/get' +
    `?reportName=RPT_HKF10_INFO_ORGPROFILE&columns=ALL&filter=${encodeURIComponent(`(SECUCODE="${secucode}")`)}` +
    '&pageNumber=1&pageSize=1&source=F10&client=PC';
  const j = await fetchJson<{ result?: { data?: { BELONG_INDUSTRY?: string }[] } | null }>(url, {
    timeoutMs: 10000,
    headers: { Referer: 'https://emweb.securities.eastmoney.com/' },
  });
  const row = j.result?.data?.[0];
  const industry = row?.BELONG_INDUSTRY ?? null;
  return {
    holder: null,
    holderRatio: null,
    controller: null,
    industry,
    industryPath: industry,
    source: PROVIDER_NAME,
  };
}

export async function fetchCompanyProfile(
  code: string,
  market: 'A' | 'HK',
): Promise<CompanyProfile> {
  if (market === 'HK') return fetchHkProfile(`${code}.HK`);
  return fetchAProfile(code);
}
