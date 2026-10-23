import { marketRecord, type MarketStore } from './marketStore';

/**
 * 数据修正长效存档。
 *
 * 每条修正独立存档为 `market-correction:v1:<symbol>:<requestId>` 记录：
 * - 普通 market 记录本身没有 TTL 清理（只有显式 remove 才删除），
 *   且每个请求编号对应唯一键，不会进入 revisions 的「每键 4 版 / 7 天」滚动清理；
 * - 该键族不属于公开数据白名单（PUBLIC_MARKET_FAMILIES），只经维护端查询。
 */

export interface CorrectionEntry {
  /** 规范代码，如 sh600415 / hk00700。 */
  symbol: string;
  /** 被修正的公开数据记录键。 */
  key: string;
  /** 修正前完整记录体（payload + 元信息）。 */
  oldValue: unknown;
  /** 修正后完整记录体。 */
  newValue: unknown;
  /** 来源依据：公告/交易所原文、链接或可复核说明。 */
  basis: string;
  /** 操作身份（令牌指纹或调用方自报标签）。 */
  operator: string;
  /** 请求编号，与审计日志一致。 */
  requestId: string;
  /** 备注（可选）。 */
  note?: string;
}

export const correctionKey = (symbol: string, requestId: string) => `market-correction:v1:${symbol}:${requestId}`;
export const CORRECTION_PREFIX = 'market-correction:v1:';

/** 写入一条修正存档。expected=null 仅新建；请求编号冲突（实际不可发生）时返回 false。 */
export async function archiveCorrection(store: MarketStore, entry: CorrectionEntry, now = Date.now()): Promise<boolean> {
  return store.write(marketRecord(correctionKey(entry.symbol, entry.requestId), 'market-correction', 'maintain', entry, 100 * 365 * 864e5, now), null);
}

/** 查询某股票的全部修正存档（按时间倒序，含旧值/新值/依据/身份/请求编号）。 */
export async function readCorrections(store: MarketStore, symbol: string, limit = 50): Promise<CorrectionEntry[]> {
  if (!store.scanPrefix) return [];
  const cap = Math.max(1, Math.min(200, limit));
  const metas = await store.scanPrefix(`${CORRECTION_PREFIX}${symbol}:`, cap + 1);
  if (!metas.length) return [];
  const rows = await Promise.all(metas.map(m => store.read<CorrectionEntry>(m.key).catch(() => null)));
  return rows
    .filter((r): r is NonNullable<typeof r> => !!r && r.payload?.symbol === symbol)
    .sort((a, b) => Date.parse(b.acquiredAt) - Date.parse(a.acquiredAt))
    .map(r => r.payload)
    .slice(0, cap);
}
