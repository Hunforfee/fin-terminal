/**
 * 新浪财经-分红配送（现金分红事件）。
 *
 * 端点（HTML，GBK）：
 *   https://money.finance.sina.com.cn/corp/go.php/vISSUE_ShareBonus/stockid/{code}.phtml
 *
 * 表格结构（每 10 股口径）：
 *   公告日期 | 送股(股) | 转增(股) | 派息(税前)(元) | 进度 | 除权除息日 | 股权登记日 | ...
 *
 * 用途：计算历史股息率（TTM 每股现金分红 ÷ 不复权收盘价）。
 */

import { fetchText } from './http';
import { fetchEastmoneyImplementedDividends } from './eastmoneyBonus';

export const PROVIDER_NAME = 'sina-bonus';

export interface DividendEvent {
  /** Source facts are saved even when an independent proposal check is unavailable. */
  reconciliationPending?: boolean;
  /** 除权除息日 YYYY-MM-DD */
  exDate: string;
  /** 每股现金分红（税前，元）＝ 每10股派息 ÷ 10 */
  perShare: number;
  /** 每股送转股（元/股口径）：送股 + 转增，用于复权价格序列 */
  perShareStock?: number;
  /** Monetary resolution of this source's displayed amount, CNY/share. */
  precisionPerShare?: number;
  cashSource?: 'sina' | 'sina+eastmoney-rounding-reconciled' | 'eastmoney-implemented';
  implementationEvidence?: { reportDate:string; noticeDate:string; profile:string }[];
  /** Unresolved values remain evidence, and MUST NOT enter rolling cash-yield sums. */
  cashConflict?: { sina: number; eastmoney: number };
}

/** 抓取并解析分红事件（仅「实施」），按除权日升序 */
export async function fetchDividends(code: string): Promise<DividendEvent[]> {
  if(!/^\d{6}$/.test(code))throw Error('分红股票代码无效');
  const url = `https://money.finance.sina.com.cn/corp/go.php/vISSUE_ShareBonus/stockid/${code}.phtml`;
  try{
    const html = await fetchText(url, { timeoutMs: 10000, encoding: 'gbk',retries:0 });
    const events=parseBonusPage(html);
    if(!events.length)throw Error('新浪未返回已实施分红');
    return events;
  }catch(primary){
    try{
      const events=await fetchEastmoneyImplementedDividends(code);
      return events;
    }catch(backup){throw Error(`公网已实施分红均不可用（新浪：${primary instanceof Error?primary.message:'不可用'}；东方财富：${backup instanceof Error?backup.message:'不可用'}）`);}
  }
}

export function parseBonusPage(html: string): DividendEvent[] {
  const out: DividendEvent[] = [];
  const seenRows = new Set<string>();
  const identityAmounts = new Map<string, string>();
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html)) !== null) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) =>
      x[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim(),
    );
    // 0公告日期 1送股 2转增 3派息 4进度 5除权除息日
    if (tds.length < 6) continue;
    const announce = tds[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(announce)) continue;
    if (!/实施/.test(tds[4])) continue;
    const signature = JSON.stringify(tds.slice(0, 6));
    if (seenRows.has(signature)) continue;
    seenRows.add(signature);
    const identity = `${announce}:${tds[5]}`;
    const amounts = JSON.stringify([tds[1], tds[2], tds[3]]);
    if (identityAmounts.has(identity) && identityAmounts.get(identity) !== amounts)
      throw Error('同一分红实施记录出现不同金额，暂不合并');
    identityAmounts.set(identity, amounts);
    if (!tds[3].trim() || tds[3] === '--') continue;
    const per10 = Number(tds[3]);
    if (!Number.isFinite(per10) || per10 < 0) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tds[5])) continue;
    const exDate = tds[5];
    const song = Number(tds[1]);
    const zhuan = Number(tds[2]);
    const perShareStock =
      (Number.isFinite(song) && song > 0 ? song : 0) + (Number.isFinite(zhuan) && zhuan > 0 ? zhuan : 0);
    const decimals = tds[3].replace(/,/g, '').split('.')[1]?.length ?? 0;
    out.push({ exDate, perShare: per10 / 10, perShareStock: perShareStock / 10,
      precisionPerShare: 10 ** (-decimals - 1), cashSource: 'sina' });
  }
  // Only distinct implementation records may be aggregated; exact duplicates above are ignored.
  const byDate = new Map<string, DividendEvent>();
  for (const e of out) {
    const prev = byDate.get(e.exDate);
    byDate.set(e.exDate, {
      exDate: e.exDate,
      perShare: (prev?.perShare ?? 0) + e.perShare,
      perShareStock: (prev?.perShareStock ?? 0) + (e.perShareStock ?? 0),
      precisionPerShare: (prev?.precisionPerShare ?? 0) + (e.precisionPerShare ?? 0),
      cashSource: 'sina',
    });
  }
  return [...byDate.values()].sort((a, b) => a.exDate.localeCompare(b.exDate));
}

