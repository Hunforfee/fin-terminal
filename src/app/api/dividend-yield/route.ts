import type { NextRequest } from 'next/server';
import { ok, fail, sp } from '@/lib/api';
import { normalizeStockCode } from '@/lib/datasource/codes';
import { fetchDividendPlans } from '@/lib/datasource/dividendPlans';
import { fetchDividends } from '@/lib/datasource/sinaBonus';
import { getKLine } from '@/lib/datasource';
import { buildExpectedDividendYieldByDate } from '@/lib/dividends';
import { cached } from '@/lib/datasource/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/dividend-yield?codes=600519,000858
 *
 * 批量「预期股息率」：与个股估值页使用同一算法（公告方案延续法，
 * buildExpectedDividendYieldByDate），以最新收盘价为分母。
 * 单只取数失败时该只返回 null，不猜测、不填 0。
 */

export interface DividendYieldRow {
  symbol: string;
  /** 预期股息率 %，null 表示数据不可用 */
  dy: number | null;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
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

/** 单只股票的预期股息率（30 分钟缓存，分红方案按日更新） */
async function expectedYield(symbol: string): Promise<number | null> {
  return cached(`expected-dy:${symbol}`, 1800e3, async () => {
    const [plans, dividends, kline] = await Promise.all([
      fetchDividendPlans(symbol.slice(2)).catch(() => null),
      fetchDividends(symbol.slice(2)).catch(() => []),
      getKLine(symbol, 'day', 'none', 5),
    ]);
    if (!plans || !kline.candles.length) return null;
    const map = buildExpectedDividendYieldByDate(plans, kline.candles, dividends);
    const latest = map.get(kline.candles.at(-1)!.date);
    return typeof latest === 'number' && Number.isFinite(latest) ? latest : null;
  }).catch(() => null);
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
    const data = await mapLimit(symbols, 4, async (symbol) => ({
      symbol,
      dy: await expectedYield(symbol),
    }));
    return ok(data satisfies DividendYieldRow[]);
  } catch (e) {
    return fail(e instanceof Error ? e.message : '预期股息率获取失败', 502, e);
  }
}
