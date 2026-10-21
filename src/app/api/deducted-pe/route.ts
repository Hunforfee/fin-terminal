import type { NextRequest } from 'next/server';
import { ok, fail, sp } from '@/lib/api';
import { normalizeStockCode } from '@/lib/datasource/codes';
import { fetchDeductedPeriods, computeDeductedPe } from '@/lib/datasource/deductedPe';
import { getQuote } from '@/lib/datasource';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/deducted-pe?codes=600519,000858
 *
 * 扣非 PE-TTM：总市值 / 最近四个季度扣非归母净利润之和。
 * 数据不足（缺季度）或净利润为负时返回 null，不估算。
 */

export interface DeductedPeRow {
  symbol: string;
  /** 扣非 PE-TTM，null 表示不可得 */
  pe: number | null;
  /** 已算出的单季报告期（升序）；完整 TTM 为四期 */
  quarters: string[];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

async function one(symbol: string): Promise<DeductedPeRow> {
  // 港股 / 基金不适用 A 股扣非口径。
  if (!/^(sh|sz|bj)\d{6}$/.test(symbol)) return { symbol, pe: null, quarters: [] };
  try {
    const [periods, quote] = await Promise.all([
      // 只缓存更新较慢的财报；最终 PE 每次按行情层当前市值重新计算。
      fetchDeductedPeriods(symbol.slice(2)),
      getQuote(symbol).catch(() => null),
    ]);
    // 总市值单位为亿元，折算成元与净利润口径一致
    const cap =
      quote?.totalMarketCap != null ? quote.totalMarketCap * 1e8 : null;
    const r = computeDeductedPe(periods, cap);
    return { symbol, pe: r.pe, quarters: r.quarters };
  } catch {
    return { symbol, pe: null, quarters: [] };
  }
}

export async function GET(request: NextRequest) {
  const raw = sp(request).get('codes') ?? '';
  const symbols = [
    ...new Set(
      raw
        .split(',')
        .map((c) => normalizeStockCode(c)?.symbol)
        .filter((s): s is string => !!s),
    ),
  ].slice(0, 120);
  if (!symbols.length) return fail('缺少 codes 参数，如 codes=600519,000858', 400);

  try {
    const data = await mapLimit(symbols, 4, one);
    return ok(data satisfies DeductedPeRow[]);
  } catch (e) {
    return fail(e instanceof Error ? e.message : '扣非 PE 获取失败', 502, e);
  }
}
