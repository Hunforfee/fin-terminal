import { fetchJson, UpstreamError } from './http';

/**
 * 港股估值指标数据源。
 *
 * 港股在腾讯行情（qt.gtimg.cn）里**不提供** PB 与股息率：
 * 字段 72 实测为「52 周低」、字段 58 为「年内涨幅%」，按这两个位置取值会得到错误结果，
 * 因此估值指标一律由本模块的基本面数据计算，不用行情快照推断。
 *
 * 口径对齐同花顺 / 理杏仁（港股）：
 * - PB = 最新价 / 每股净资产，净资产取最新一期已披露报告（含中报）；
 * - 股息率 = 近 12 个月已实施每股派息之和 / 最新价。
 *   港股多为「中期 + 末期」一年派两次，单取一个报告期会明显偏低；
 *   同一除息日重复披露（如「末期」与「特别分配」金额相同）需去重，否则会翻倍。
 */

export interface HkDividendRecord {
  /** 除息日（YYYY-MM-DD） */
  exDate: string;
  /** 公告日（YYYY-MM-DD） */
  noticeDate: string;
  /** 每股派息（港元，税前） */
  dps: number | null;
  period: string;
  special: boolean;
}

export interface HkFundamental {
  /** 报告期（YYYY-MM-DD） */
  reportDate: string;
  reportType: string;
  /** 每股净资产（港元） */
  bps: number | null;
  /** 报表口径的总市值（港元），用于校验价格单位 */
  totalMarketCap: number | null;
}

export interface HkValuation {
  /** 市净率 = 最新价 / 每股净资产 */
  pb: number | null;
  /** 股息率 % = 近 12 个月每股派息之和 / 最新价 */
  dividendYield: number | null;
  /** 参与计算的每股派息合计（港元） */
  ttmDps: number | null;
  /** 股息率口径对应的财年（如 2025），便于前端展示 */
  fiscalYear: string | null;
  /** 该财年已计入的派息批次（1=只有末期或中期，2=中期+末期） */
  batches: number;
  reportDate: string | null;
  reportType: string | null;
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

const HK_HEADERS = { Referer: 'https://emweb.securities.eastmoney.com/' };

export function parseHkFundamental(rows: Row[]): HkFundamental | null {
  for (const row of rows) {
    const reportDate = dateOnly(row.REPORT_DATE);
    if (!reportDate) continue;
    const bps = num(row.BPS);
    if (bps === null) continue;
    return {
      reportDate,
      reportType: typeof row.REPORT_TYPE === 'string' ? row.REPORT_TYPE : '',
      bps,
      totalMarketCap: num(row.TOTAL_MARKET_CAP),
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
  const data = await fetchJson<Response>(url.toString(), { timeoutMs: 15000, headers: HK_HEADERS });
  if (!data.success || !data.result || !Array.isArray(data.result.data)) {
    throw new UpstreamError('港股财务指标不可用', url.toString(), 'parse');
  }
  return parseHkFundamental(data.result.data);
}

/** 从「每股派港币5.3元」这类说明里取港元金额（优先括号内折算值） */
export function parseHkDps(explain: string): number | null {
  const text = String(explain ?? '');
  // 股份分派（如「每10股分派1股美团…相当于每股派18.13港元」）的港元金额只是等效说明，
  // 不是可预期的现金股息，必须排除，否则会虚增股息率。
  if (/每\s*\d+\s*股\s*分派\s*\d*\s*股|分派.*普通股|实物分派/.test(text)) return null;
  // 优先取「相当于港币X元」
  const conv = text.match(/相当于(?:每股派)?港币\s*([\d.]+)\s*元/);
  if (conv) {
    const n = Number(conv[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (!/港[币元]/.test(text)) return null; // 只有人民币/美元且无折算值时不猜测汇率
  const m = text.match(/港币\s*([\d.]+)\s*元/) ?? text.match(/每股派\s*([\d.]+)\s*港元/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseHkDividends(rows: Row[]): HkDividendRecord[] {
  const out: HkDividendRecord[] = [];
  for (const row of rows) {
    const exDate = dateOnly(row.EX_DIVIDEND_DATE);
    if (!exDate) continue;
    const progress = String(row.ASSIGN_PROGRESS ?? '');
    // 只有已实施/已除息的派息才计入滚动股息，取消或未实施方案不计
    if (/取消|终止|不实施|未实施/.test(progress)) continue;
    const period = String(row.ASSIGN_PERIOD ?? '');
    out.push({
      exDate,
      noticeDate: dateOnly(row.NOTICE_DATE) || exDate,
      dps: parseHkDps(String(row.PLAN_EXPLAIN ?? '')),
      period,
      special: /特别|特殊/.test(period),
    });
  }
  return out.sort((a, b) => b.exDate.localeCompare(a.exDate));
}

/**
 * 「最近一个完整财年」的已实施每股派息合计。
 *
 * 港股一年通常派两次（中期 + 末期），且末期在次年 2-5 月才除息。
 * 因此不能按「除息日滚动 12 个月」相加 —— 那会把上一财年末期和本财年中期拼在一起，
 * 结果明显偏高。正确做法是按 ASSIGN_PERIOD 的财年标签分组：
 *   FY2025 = 2025中期 + 2025末期，两者加总即为该财年全年派息。
 * 取「已凑齐两个批次」或「最新一个含末期的财年」作为口径年度，与同花顺 / 理杏仁一致。
 */
export function sumTtmDividend(
  records: HkDividendRecord[],
): { ttmDps: number | null; fiscalYear: string | null; batches: number } {
  const byFy = new Map<string, Map<string, number>>();
  for (const r of records) {
    if (!r.dps) continue;
    const m = r.period.match(/^(\d{4})(末期|中期)/);
    if (!m) continue; // 「特别分配」等无财年标签的单独派息不计入常规股息率
    const fy = m[1];
    const kind = m[2];
    if (!byFy.has(fy)) byFy.set(fy, new Map());
    const slot = byFy.get(fy)!;
    // 同一财年同类型若重复披露（取消后重发），取最新一条的金额（records 已按日期倒序）
    if (!slot.has(kind)) slot.set(kind, r.dps);
  }
  if (byFy.size === 0) return { ttmDps: null, fiscalYear: null, batches: 0 };

  // 优先选「中期 + 末期」都齐全的最近财年；否则退回最近一个含末期的财年
  const years = [...byFy.keys()].sort().reverse();
  const complete = years.find((y) => byFy.get(y)!.size >= 2);
  const withFinal = years.find((y) => byFy.get(y)!.has('末期'));
  const fy = complete ?? withFinal ?? years[0];
  const slot = byFy.get(fy)!;
  // 只有末期才代表完整年度；只有中期说明该财年还没结束，属可用的最新数据
  let sum = 0;
  for (const v of slot.values()) sum += v;
  return {
    ttmDps: Math.round(sum * 1e6) / 1e6,
    fiscalYear: fy,
    batches: slot.size,
  };
}

/** 取港股分红明细（只取最近两页足够覆盖滚动 12 个月） */
export async function fetchHkDividends(code: string): Promise<HkDividendRecord[]> {
  if (!/^\d{5}$/.test(code)) throw new Error('港股代码无效');
  const rows: Row[] = [];
  for (let page = 1; page <= 2; page++) {
    const url = new URL('https://datacenter.eastmoney.com/securities/api/data/v1/get');
    url.search = new URLSearchParams({
      reportName: 'RPT_HKF10_INFO_DIVIDEND',
      columns: 'ALL',
      filter: `(SECURITY_CODE="${code}")`,
      pageSize: '50',
      pageNumber: String(page),
      sortColumns: 'NOTICE_DATE',
      sortTypes: '-1',
    }).toString();
    const data = await fetchJson<Response>(url.toString(), { timeoutMs: 15000, headers: HK_HEADERS });
    if (!data.success) throw new UpstreamError('港股分红明细不可用', url.toString(), 'parse');
    const list = data.result?.data;
    if (!Array.isArray(list) || list.length === 0) break;
    rows.push(...list);
    if (!(data.result && data.result.pages > page)) break;
  }
  // 无分红记录是合法状态（如小米），不是错误
  return parseHkDividends(rows);
}

/** 由基本面、分红与现价计算 PB / 股息率；价格必须与 BPS 同为港元计价 */
export function computeHkValuation(
  f: HkFundamental | null,
  dividends: HkDividendRecord[] | null,
  price: number | null,
): HkValuation {
  const p = price !== null && Number.isFinite(price) && price > 0 ? price : null;
  const pb = f && f.bps && p !== null ? Math.round((p / f.bps) * 1000) / 1000 : null;
  const ttm = dividends && p !== null ? sumTtmDividend(dividends) : null;
  const dividendYield =
    ttm?.ttmDps != null && p !== null ? Math.round((ttm.ttmDps / p) * 10000) / 100 : null;
  return {
    pb: pb !== null && pb > 0 && pb < 1000 ? pb : null,
    dividendYield,
    ttmDps: ttm?.ttmDps ?? null,
    fiscalYear: ttm?.fiscalYear ?? null,
    batches: ttm?.batches ?? 0,
    reportDate: f?.reportDate ?? null,
    reportType: f?.reportType ?? null,
  };
}
