import { ok, fail } from '@/lib/api';
import { getMarketOverview } from '@/lib/datasource';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/market —— 主要指数概览 */
export async function GET() {
  try {
    return ok(await getMarketOverview());
  } catch (e) {
    return fail(e instanceof Error ? e.message : '大盘数据获取失败', 502, e);
  }
}
