import { NextRequest, NextResponse } from 'next/server';
import { normalizeStockCode } from '@/lib/datasource/codes';
import {
  getCompanyAnnouncements,
  type CompanyAnnouncement,
} from '@/lib/datasource/announcements';
import { getQuotes } from '@/lib/datasource';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export interface WindowEntry extends CompanyAnnouncement {
  code: string;
  symbol: string;
  name: string;
}

/** 受控并发跑任务，避免冷启动时一次性打满上游/实例资源 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 自选公司公告聚合流（每家最近 8 条，按时间倒序，最多 120 条） */
export async function GET(request: NextRequest) {
  const codesParam = request.nextUrl.searchParams.get('codes') ?? '';
  const codes = [
    ...new Set(
      codesParam
        .split(',')
        .map((c) => normalizeStockCode(c))
        .filter(
          (n): n is NonNullable<ReturnType<typeof normalizeStockCode>> => !!n,
        ),
    ),
  ].slice(0, 40);
  if (!codes.length) return json({ ok: true, data: [] });

  // 名称映射（行情内部自带分批，失败时退回代码作名称）
  const symbols = codes.map((c) => c.symbol);
  const quotes = await getQuotes(symbols).catch(() => []);
  const nameOf = new Map(quotes.map((q) => [q.symbol, q.name]));

  // 并发限制 5，防止冷缓存时 60 路外抓同时打满实例
  const perStock = await mapLimit(codes, 5, async (c) => {
    const list = await getCompanyAnnouncements(c.code, 8);
    return list.map((a) => ({
      ...a,
      code: c.code,
      symbol: c.symbol,
      name: nameOf.get(c.symbol) || c.symbol,
    }));
  });

  const data: WindowEntry[] = perStock
    .flat()
    .filter((a) => a.date)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 120);

  return json({ ok: true, data });
}
