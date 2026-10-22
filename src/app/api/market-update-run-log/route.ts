import { NextRequest, NextResponse } from 'next/server';
import { getMarketStore } from '@/lib/marketStore';
import { MarketUpdateQueue, UpdateQueueError } from '@/lib/marketUpdateQueue';
import { updateIdentity } from '@/lib/marketUpdateAuth';
import { getRunLog } from '@/lib/marketUpdateRunLog';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const failure = (e: unknown) => json({ ok: false, error: e instanceof UpdateQueueError ? e.message : '更新服务暂不可用，请稍后再试' }, e instanceof UpdateQueueError ? e.status : 503);
/** GET /api/market-update-run-log —— 运行日志（原因+结果）与调度场实时进度。 */
export async function GET(request: NextRequest) {
  try {
    if (process.env.MARKET_UPDATE_WORKER_ENABLED !== '1' || (process.env.MARKET_UPDATE_WORKER_TOKEN?.length ?? 0) < 32) throw new UpdateQueueError('后台更新服务尚未配置', 503);
    const store = getMarketStore(); if (!store) throw new UpdateQueueError('市场数据库尚未配置', 503);
    // 仅登录用户可查看；未同步自选也放行（与 /api/market-updates 一致）。
    try { await updateIdentity(request, 'all'); }
    catch (e) { if (e instanceof UpdateQueueError && e.status === 409) await updateIdentity(request); else throw e; }
    const q = new MarketUpdateQueue(store);
    const [live, runs] = await Promise.all([q.systemCloseProgress(), getRunLog(store)]);
    return json({ ok: true, data: { live, runs } });
  }
  catch (e) { return failure(e); }
}
