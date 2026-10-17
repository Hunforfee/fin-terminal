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

export const PROVIDER_NAME = 'sina-bonus';

export interface DividendEvent {
  /** 除权除息日 YYYY-MM-DD */
  exDate: string;
  /** 每股现金分红（税前，元）＝ 每10股派息 ÷ 10 */
  perShare: number;
  /** 每股送转股（元/股口径）：送股 + 转增，用于复权价格序列 */
  perShareStock?: number;
}

/** 抓取并解析分红事件（仅「实施」），按除权日升序 */
export async function fetchDividends(code: string): Promise<DividendEvent[]> {
  const url = `https://money.finance.sina.com.cn/corp/go.php/vISSUE_ShareBonus/stockid/${code}.phtml`;
  const html = await fetchText(url, { timeoutMs: 15000, encoding: 'gbk' });
  return parseBonusPage(html);
}

export function parseBonusPage(html: string): DividendEvent[] {
  const out: DividendEvent[] = [];
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
    const per10 = Number(tds[3]);
    if (!Number.isFinite(per10) || per10 <= 0) continue;
    const exDate = /^\d{4}-\d{2}-\d{2}$/.test(tds[5]) ? tds[5] : announce;
    const song = Number(tds[1]);
    const zhuan = Number(tds[2]);
    const perShareStock =
      (Number.isFinite(song) && song > 0 ? song : 0) + (Number.isFinite(zhuan) && zhuan > 0 ? zhuan : 0);
    out.push({ exDate, perShare: per10 / 10, perShareStock: perShareStock / 10 });
  }
  // 同日可能多条（罕见），去重求和
  const byDate = new Map<string, DividendEvent>();
  for (const e of out) {
    const prev = byDate.get(e.exDate);
    byDate.set(e.exDate, {
      exDate: e.exDate,
      perShare: (prev?.perShare ?? 0) + e.perShare,
      perShareStock: (prev?.perShareStock ?? 0) + (e.perShareStock ?? 0),
    });
  }
  return [...byDate.values()].sort((a, b) => a.exDate.localeCompare(b.exDate));
}
