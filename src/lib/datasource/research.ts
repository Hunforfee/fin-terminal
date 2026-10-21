/**
 * 券商研报数据源（东方财富 reportapi）：
 *   https://reportapi.eastmoney.com/report/list
 * 返回结构化研报：机构、东财评级、目标价、发布日期、标题。
 * 已实测可用（沙箱 2026-10，code=600415 返回 2026 年最新多家券商研报）。
 */

import { fetchJson } from './http';
import { cachedMarketInput } from '../marketInputs';

export interface ResearchReport {
  /** 研究机构 */
  orgName: string | null;
  /** 评级（东财综合评级，如 买入 / 增持 / 中性） */
  rating: string | null;
  /** 目标价（元，取上限） */
  targetPrice: number | null;
  /** 发布日期 YYYY-MM-DD */
  date: string | null;
  /** 研报标题（本身即观点句） */
  title: string;
  /** 跳转链接（东财个股研报页） */
  url: string;
}

function cleanDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const d = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

export async function fetchReports(
  code: string,
  market: 'A' | 'HK',
): Promise<ResearchReport[]> {
  if(market==='HK')return [];
  return cachedMarketInput(`company-reports:v1:${code}`,'company-reports','eastmoney:research',6*3600e3,
    ()=>fetchReportSource(code,market),value=>{if(!Array.isArray(value))throw Error('研报目录无效');}).catch(()=>[]);
}
async function fetchReportSource(code:string,market:'A'|'HK'):Promise<ResearchReport[]>{
  if (market === 'HK') return []; // 研报接口主要覆盖 A 股
  const today = new Date().toISOString().slice(0, 10);
  const past = new Date(Date.now() - 2 * 365 * 864e5).toISOString().slice(0, 10);
  const url =
    `https://reportapi.eastmoney.com/report/list?code=${code}` +
    `&qType=0&pageSize=8&pageNo=1&beginTime=${past}&endTime=${today}&rt=1`;
  try {
    const j = await fetchJson<any>(url, {
      timeoutMs: 12000,
      headers: { Referer: 'https://emweb.securities.eastmoney.com/' },
    });
    if(!Array.isArray(j?.data))throw Error('研报目录未有效返回');
    const rows = j.data;
    return rows
      .map((r: any) => ({
        orgName: r?.orgName ?? null,
        rating: r?.emRatingName ?? r?.sRatingName ?? null,
        targetPrice:
          typeof r?.indvAimPriceT === 'number' ? r.indvAimPriceT : null,
        date: cleanDate(r?.publishDate),
        title: String(r?.title ?? ''),
        url: `https://data.eastmoney.com/report/stock/${code}.html`,
      }))
      .filter((r: ResearchReport) => r.title.length > 0);
  } catch (error) {
    throw error;
  }
}
