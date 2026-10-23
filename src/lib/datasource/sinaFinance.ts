import { HISTORY_YEARS } from '../marketHistoryPlan';
/**
 * 新浪财务指标页（`vFD_FinancialGuideLine`）——用于还原历史真实估值。
 *
 * 端点（HTML，GBK，按「年份分页」返回该年的 4 个报告期）：
 *   https://money.finance.sina.com.cn/corp/go.php/vFD_FinancialGuideLine/stockid/{code}/ctrl/{year}/displaytype/4.phtml
 *
 * 页面结构：表头为报告期（2025-12-31 / 2025-09-30 …），每行一个指标，
 * 指标名带 `typecode=financialratiosNN` 链接，可稳定定位（名称含 Ⅱ 等异体字也不受影响）。
 *
 * 采用的字段（均为**累计值**，元/元-每股）：
 *   40 摊薄每股收益        85 每股净资产_调整前       54 每股净资产_调整后
 *   59 净资产收益率(%)     58 总资产(元)
 *
 * 用途：为历史 PE/PB 提供真实分母，替代「当前 EPS × 复合增速倒推」的估算。
 */

import { fetchText } from './http';
import { fetchEastmoneyShareHistory } from './eastmoneyCapital';

export interface PeriodFinancial {
  /** 报告期 YYYY-MM-DD */
  date: string;
  /** 摊薄每股收益（累计，元） */
  eps: number | null;
  /** 每股净资产（元，按可用顺序取调整后 / 调整前） */
  bps: number | null;
  /** 净资产收益率（累计，%） */
  roe: number | null;
  /** 总资产（元） */
  totalAssets: number | null;
  /** 派生：净利润（累计，元）= EPS × 股本；股本未知时为 null */
  netProfit: number | null;
  /** 派生：净利润（累计，亿元） */
  netProfitYi: number | null;
}

const PAGE = (code: string, year: number) =>
  `https://money.finance.sina.com.cn/corp/go.php/vFD_FinancialGuideLine/stockid/${code}/ctrl/${year}/displaytype/4.phtml`;

/** 抓取单一年份的 4 个报告期；无数据返回 [] */
export async function fetchYearlyPeriods(code: string, year: number): Promise<PeriodFinancial[]> {
  let html: string;
  try {
    html = await fetchText(PAGE(code, year), {
      timeoutMs: 15000,
      encoding: 'gbk',
      headers: { Referer: 'https://finance.sina.com.cn' },
    });
  } catch {
    return [];
  }
  return parseFinancialGuideLine(html).filter((p) => p.date.startsWith(String(year)));
}

/** 解析财务指标页 */
export function parseFinancialGuideLine(html: string): PeriodFinancial[] {
  // 表头：报告日期行
  const headMatch = html.match(/报告日期[\s\S]{0,80}?<\/td>([\s\S]*?)<\/tr>/);
  const dates: string[] = headMatch
    ? [...headMatch[1].matchAll(/(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1])
    : [];
  if (dates.length === 0) return [];

  /** 按 typecode 取一行数值（按表头列序对齐） */
  const row = (typecode: string): (string | null)[] => {
    const re = new RegExp(
      `typecode=${typecode}'>[\\s\\S]*?</a></td>([\\s\\S]*?)</tr>`,
      'i',
    );
    const m = html.match(re);
    if (!m) return dates.map(() => null);
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(
      (x) => x[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim(),
    );
    return dates.map((_, i) => cells[i] ?? null);
  };

  const num = (s: string | null): number | null => {
    if (s === null || s === '' || s === '--') return null;
    const v = Number(s.replace(/,/g, ''));
    return Number.isFinite(v) ? v : null;
  };

  const eps = row('financialratios40');
  // 54 每股净资产_调整后 = 归属母公司股东权益 / 股本（与行情 PB 口径一致）
  const bpsAdj = row('financialratios54');
  const bpsRaw = row('financialratios85');
  const roe = row('financialratios59');
  const ta = row('financialratios58');

  return dates
    .map((date, i) => {
      const bps = num(bpsAdj[i]) ?? num(bpsRaw[i]);
      return {
        date,
        eps: num(eps[i]),
        bps: bps !== null && bps > 0 ? bps : null,
        roe: num(roe[i]),
        totalAssets: num(ta[i]),
        netProfit: null,
        netProfitYi: null,
      };
    })
    .filter((p) => p.eps !== null || p.bps !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface ShareChange {
  source?: 'sina-shares' | 'eastmoney-equity';
  noticeDate?: string;
  precisionShares?: number;
  reference?: string;
  /** 变动日期 */
  date: string;
  /** 总股本（万股） */
  sharesWan: number;
}

/**
 * 总股本变动史（新浪 `vCI_StockStructureHistory`，图表里带 hoverText 日期与 value 万股）。
 * 用于还原「每个报告期当时」的股本，从而由 EPS × 股本 得到当期净利润。
 */
export async function fetchShareHistory(code: string): Promise<ShareChange[]> {
  if(!/^\d{6}$/.test(code))throw Error('实际股本股票代码无效');
  const url = `https://money.finance.sina.com.cn/corp/go.php/vCI_StockStructureHistory/stockid/${code}/stocktype/TotalStock.phtml`;
  try {
    const html = await fetchText(url, {
      timeoutMs: 10000,retries:0,
      encoding: 'gbk',
      headers: { Referer: 'https://finance.sina.com.cn' },
    });
    const rows=parseShareHistory(html),today=new Date(Date.now()+8*3600e3).toISOString().slice(0,10);
    if(!rows.length || rows.some(r=>r.date>today || !Number.isFinite(Date.parse(r.date+'T00:00:00Z'))))throw Error('新浪实际股本历史为空或日期无效');
    return rows.map(r=>({...r,source:'sina-shares' as const}));
  } catch(primary) {
    try{return await fetchEastmoneyShareHistory(code);}
    catch(backup){throw Error(`公网实际股本均不可用（新浪：${primary instanceof Error?primary.message:'不可用'}；东方财富：${backup instanceof Error?backup.message:'不可用'}）`);}
  }
}
export const shareHistorySource=(rows:ShareChange[])=>[...new Set(rows.map(r=>r.source??'existing-share-evidence'))].sort().join('+')+':10000shares';

export function parseShareHistory(html: string): ShareChange[] {
  const out: ShareChange[] = [];
  for (const m of html.matchAll(/value='([\d.]+)'\s+hoverText='(\d{4}-\d{2}-\d{2})'/g)) {
    const sharesWan = Number(m[1]);
    if (!Number.isFinite(sharesWan) || sharesWan <= 0) continue;
    out.push({ date: m[2], sharesWan });
  }
  const byDate = new Map<string, number>();
  for (const e of out) byDate.set(e.date, e.sharesWan);
  return [...byDate.entries()]
    .map(([date, sharesWan]) => ({ date, sharesWan }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 取某日期的总股本（万股）：最近一个变动日 ≤ date */
export function sharesAt(history: ShareChange[], date: string): number | null {
  let best: number | null = null;
  for (const h of history) {
    if (h.date <= date) best = h.sharesWan;
    else break;
  }
  return best;
}

/**
 * 抓取多年报告期（按年分页并发抓取）。
 * @param years 需要回溯的年数（含当年）
 */
export async function fetchFinancialPeriods(code: string, years = HISTORY_YEARS+2): Promise<PeriodFinancial[]> {
  const thisYear = new Date().getFullYear();
  const ys: number[] = [];
  for (let i = 0; i < years; i++) ys.push(thisYear - i);
  const pages = await Promise.all(ys.map((y) => fetchYearlyPeriods(code, y)));
  const byDate = new Map<string, PeriodFinancial>();
  for (const p of pages.flat()) {
    if (!p.date) continue;
    const prev = byDate.get(p.date);
    if (!prev || (prev.bps === null && p.bps !== null) || (prev.eps === null && p.eps !== null)) {
      byDate.set(p.date, p);
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}


/* ------------------------------------------------------------ 利润表 */

/**
 * 抓取单一年份利润表（`vFD_ProfitStatement`，单位：万元）。
 * 结构：`<table id="ProfitStatementNewTable0">` 内，首行 `报表日期` 为表头，
 * 之后每行是 `<a ...type=NETPROFIT&...>五、净利润</a>` 形式的科目 + 各期数值。
 *
 * 用利润表而非财务指标页的 EPS：新浪 EPS 在送转/追溯调整时口径会跳变
 * （例如五粮液 2025 年报 EPS 2.40 与三季报 5.72 不同口径），
 * 而净利润金额本身是持续可比的。
 */
export async function fetchYearlyProfit(code: string, year: number): Promise<{ date: string; netProfit: number }[]> {
  let html: string;
  try {
    html = await fetchText(
      `https://money.finance.sina.com.cn/corp/go.php/vFD_ProfitStatement/stockid/${code}/ctrl/${year}/displaytype/4.phtml`,
      { timeoutMs: 15000, encoding: 'gbk', headers: { Referer: 'https://finance.sina.com.cn' } },
    );
  } catch {
    return [];
  }
  return parseProfitStatement(html).filter((p) => p.date.startsWith(String(year)));
}

/** 解析利润表页，返回 [{date, netProfit(元)}] */
export function parseProfitStatement(html: string): { date: string; netProfit: number }[] {
  const headMatch = html.match(/报表日期[\s\S]{0,120}?<\/td>([\s\S]*?)<\/tr>/);
  if (!headMatch) return [];
  const dates = [...headMatch[1].matchAll(/(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);
  if (dates.length === 0) return [];

  const m = html.match(/type=NETPROFIT&[^>]*>[\s\S]*?<\/a><\/td>([\s\S]*?)<\/tr>/i);
  if (!m) return [];
  const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) =>
    x[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim(),
  );

  const out: { date: string; netProfit: number }[] = [];
  for (let i = 0; i < dates.length; i++) {
    const raw = cells[i];
    if (!raw || raw === '--') continue;
    const wan = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(wan)) continue;
    out.push({ date: dates[i], netProfit: wan * 1e4 }); // 万元 → 元
  }
  return out;
}

/** 抓取多年利润表 */
export async function fetchProfitPeriods(code: string, years = HISTORY_YEARS+2): Promise<{ date: string; netProfit: number }[]> {
  const thisYear = new Date().getFullYear();
  const ys: number[] = [];
  for (let i = 0; i < years; i++) ys.push(thisYear - i);
  const pages = await Promise.all(ys.map((y) => fetchYearlyProfit(code, y)));
  const byDate = new Map<string, number>();
  for (const p of pages.flat()) byDate.set(p.date, p.netProfit);
  return [...byDate.entries()]
    .map(([date, netProfit]) => ({ date, netProfit }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
