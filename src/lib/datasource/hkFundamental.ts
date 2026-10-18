import { fetchJson, UpstreamError } from './http';

/**
 * 港股估值基础指标（东方财富港股 F10 主要财务指标，RPT_HKF10_FN_MAININDICATOR）。
 *
 * 港股在腾讯行情（qt.gtimg.cn）里**不提供** PB 与股息率：
 * 字段 72 实测为「52 周低」、字段 58 为「年内涨幅%」，按这两个位置取值会得到错误结果，
 * 因此一律不用行情快照推断估值，改由本模块提供「每股净资产 BPS」与「每股派息 DPS」，
 * 再由 PB = 最新价 / BPS、股息率 = DPS / 最新价 计算。
 *
 * 口径说明：
 * - BPS 取最新一期已披露报告（含中报），与东方财富港股页 PB_TTM 同源；
 * - DPS_HKD 为该报告期对应的最近一个财年税前每股派息（HKD），
 *   因此股息率是「最近年度股息 / 现价」的静态口径，与 A 股预期股息率不是同一算法，
 *   返回给前端时用 method 字段标明，避免混用。
 */

export interface HkFundamental {
  /** 报告期（YYYY-MM-DD） */
  reportDate: string;
  reportType: string;
  /** 每股净资产（港元） */
  bps: number | null;
  /** 每股派息（港元，税前） */
  dps: number | null;
  /** 报表口径的总市值（港元），用于校验价格单位 */
  totalMarketCap: number | null;
  /** 东方财富给出的 PB_TTM，仅作交叉校验 */
  pbTtm: number | null;
}

type Row = Record<string, unknown>;
type Response = { success: boolean; result?: { pages: number; data: Row[] } | null };

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const dateOnly = (v: unknown): string => {
  const s = typeof v === 'string' ? v.slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
};

export function parseHkFundamental(rows: Row[]): HkFundamental | null {
  for (const row of rows) {
    const reportDate = dateOnly(row.REPORT_DATE);
    if (!reportDate) continue;
    const bps = num(row.BPS);
    const dps = num(row.DPS_HKD);
    if (bps === null && dps === null) continue;
    return {
      reportDate,
      reportType: typeof row.REPORT_TYPE === 'string' ? row.REPORT_TYPE : '',
      bps,
      dps,
      totalMarketCap: num(row.TOTAL_MARKET_CAP),
      pbTtm: num(row.PB_TTM),
    };
  }
  return null;
}

/** 取港股最新一期主要财务指标；代码为 5 位（如 00700） */
export async function fetchHkFundamental(code: string): Promise<HkFundamental | null> {
  if (!/^\d{5}$/.test(code)) throw new Error('港股代码无效');
  const url = new URL('https://datacenter.eastmoney.com/securities/api/data/v1/get');
  url.search = new URLSearchParams({
    reportName: 'RPT_HKF10_FN_MAININDICATOR',
    columns: 'ALL',
    filter: `(SECURITY_CODE="${code}")`,
    pageSize: '6',
    sortColumns: 'REPORT_DATE',
    sortTypes: '-1',
  }).toString();
  const data = await fetchJson<Response>(url.toString(), {
    timeoutMs: 15000,
    headers: { Referer: 'https://emweb.securities.eastmoney.com/' },
  });
  if (!data.success || !data.result || !Array.isArray(data.result.data)) {
    throw new UpstreamError('港股财务指标不可用', url.toString(), 'parse');
  }
  return parseHkFundamental(data.result.data);
}

export interface HkValuation {
  /** 市净率 = 最新价 / 每股净资产 */
  pb: number | null;
  /** 股息率 % = 每股派息 / 最新价 */
  dividendYield: number | null;
  reportDate: string | null;
  reportType: string | null;
}

/** 由基本面与现价计算 PB / 股息率；价格必须与 BPS 同为港元计价 */
export function computeHkValuation(
  f: HkFundamental | null,
  price: number | null,
): HkValuation {
  const p = price !== null && Number.isFinite(price) && price > 0 ? price : null;
  if (!f || p === null) {
    return { pb: null, dividendYield: null, reportDate: f?.reportDate ?? null, reportType: f?.reportType ?? null };
  }
  // 价格与每股净资产必须同量级，避免把「分」当成「元」（A 股快照单位是元）
  const pb = f.bps && f.bps > 0 ? Math.round((p / f.bps) * 1000) / 1000 : null;
  const dividendYield = f.dps && f.dps > 0 ? Math.round((f.dps / p) * 10000) / 100 : null;
  return {
    pb: pb !== null && pb > 0 && pb < 1000 ? pb : null,
    dividendYield,
    reportDate: f.reportDate,
    reportType: f.reportType,
  };
}
