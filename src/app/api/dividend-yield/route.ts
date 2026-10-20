import { getValuationPlans, getValuationDividends } from '@/lib/valuationInputs';
import type { NextRequest } from 'next/server';
import { ok, fail, sp } from '@/lib/api';
import { normalizeStockCode } from '@/lib/datasource/codes';
import { fetchDividendPlans } from '@/lib/datasource/dividendPlans';
import { fetchDividends } from '@/lib/datasource/sinaBonus';
import { getKLine, getQuote, getHkCurrentValuation } from '@/lib/datasource';
import type { Quote } from '@/lib/datasource/types';
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
  /** 股息率 %，null 表示数据不可用 */
  dy: number | null;
  /** announced-forward：A股公告方案延续法（预期）；hk-static：港股最近年度静态 */
  method: 'announced-forward' | 'hk-static';
  fiscalYear?: string | null;
  perShare?: Quote['dividendPerShare'];
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

/**
 * 港股静态股息率 %：最新完整财年已实施现金派息（含特别现金息）/ 现价。
 * 与港股列表和详情共用数据；它不是对未来一年派息的预测。
 */
async function hkYield(
  symbol: string,
): Promise<Omit<DividendYieldRow, 'symbol'>> {
  try {
    const quote = await getQuote(symbol);
    const v = await getHkCurrentValuation(symbol, quote?.stale ? null : quote?.price ?? null);
    return { dy: v.dividendYield, method: 'hk-static', fiscalYear: v.fiscalYear,
      perShare: { ordinary: v.ordinaryDps, special: v.specialDps, total: v.ttmDps } };
  } catch {
    return { dy: null, method: 'hk-static', fiscalYear: null };
  }
}

/** 只缓存方案与派息记录，分母使用行情自身的短缓存。 */
async function expectedYield(symbol: string): Promise<number | null> {
  try {
    const [plans, dividends, kline] = await Promise.all([
      cached(`expected-dividend-plans-v2:${symbol}`, 1800e3,
        () => getValuationPlans(symbol.slice(2))).catch(() => null),
      cached(`expected-dividend-events-v2:${symbol}`, 1800e3,
        () => getValuationDividends(symbol.slice(2))).catch(() => null),
      getKLine(symbol, 'day', 'none', 5),
    ]);
    if (!plans || !dividends || kline.stale || !kline.candles.length) return null;
    const map = buildExpectedDividendYieldByDate(plans, kline.candles, dividends);
    const latest = map.get(kline.candles.at(-1)!.date);
    return typeof latest === 'number' && Number.isFinite(latest) ? latest : null;
  } catch {
    return null;
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
    const data = await mapLimit(symbols, 4, async (symbol) => ({
      symbol,
      ...(symbol.startsWith('hk')
        ? await hkYield(symbol)
        : { dy: await expectedYield(symbol), method: 'announced-forward' as const }),
    }));
    return ok(data satisfies DividendYieldRow[]);
  } catch (e) {
    return fail(e instanceof Error ? e.message : '预期股息率获取失败', 502, e);
  }
}
