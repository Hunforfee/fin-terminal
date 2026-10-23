import { NextRequest, NextResponse } from 'next/server';
import { getMarketStore } from '@/lib/marketStore';
import { MarketUpdateQueue, UpdateQueueError, updateSymbols } from '@/lib/marketUpdateQueue';
import { localUpdatePreview, updateIdentity } from '@/lib/marketUpdateAuth';
import { denyReason } from '@/lib/marketImportAuth';
import { sameOriginMutation } from '@/lib/auth/session';
import { registerCollection } from '@/lib/marketCollection';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
function queue(request: NextRequest) {
  const local = localUpdatePreview(request);
  if (process.env.MARKET_UPDATE_WORKER_ENABLED !== '1' || (process.env.MARKET_UPDATE_WORKER_TOKEN?.length ?? 0) < 32) throw new UpdateQueueError('后台更新服务尚未配置', 503);
  if (!local && !process.env.MARKET_DATABASE_URL && !process.env.DATABASE_URL) throw new UpdateQueueError('请先连接市场数据库', 503);
  const store = getMarketStore(); if (!store) throw new UpdateQueueError('市场数据库尚未配置', 503);
  return new MarketUpdateQueue(store);
}
const failure = (e: unknown) => json({ ok: false, error: e instanceof UpdateQueueError ? e.message : '更新服务暂不可用，请稍后再试' }, e instanceof UpdateQueueError ? e.status : 503);
async function readBody(request: NextRequest): Promise<string> {
  if (Number(request.headers.get('content-length') ?? 0) > 25000) throw new UpdateQueueError('更新范围过大', 413);
  const reader = request.body?.getReader(); if (!reader) throw new UpdateQueueError('请求格式无效', 400);
  const decoder = new TextDecoder(); let size = 0, text = '';
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 25000) { await reader.cancel(); throw new UpdateQueueError('更新范围过大', 413); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}
export async function GET(request: NextRequest) {
  try {
    const q = queue(request);
    let identity;
    try {
      identity = await updateIdentity(request, 'all');
    } catch (e) {
      // 未同步自选的登录用户（个股页单只补齐即属此类）：降级为仅 owner 身份，仍可轮询自己的进度。
      if (e instanceof UpdateQueueError && e.status === 409) identity = await updateIdentity(request);
      else throw e;
    }
    if(identity.allowed)await registerCollection(getMarketStore()!,identity.owner,identity.allowed);
    return json({ ok: true, data: await q.status(identity.owner), workerPausedUntil: await q.workerPausedUntil() });
  }
  catch (e) { return failure(e); }
}
export async function POST(request: NextRequest) {
  if (!sameOriginMutation(request)) return json({ ok: false, error: '请求来源无效' }, 403);
  try {
    const q = queue(request);
    await updateIdentity(request); // Reject unauthenticated uploads before reading a body.
    const raw = await readBody(request);
    let body; try { body = JSON.parse(raw); } catch { throw new UpdateQueueError('请求格式无效', 400); }
    // 单只补齐（个股页入口）：不要求自选云同步，只要登录；仍走同一全局队列与冷却。
    const single = body?.single === true;
    if (!single && (typeof body?.groupId !== 'string' || body.groupId.length > 100)) throw new UpdateQueueError('请选择自选分组', 400);
    const codes = updateSymbols(body.codes);
    if (single && codes.length !== 1) throw new UpdateQueueError('单只补齐只接受一只股票', 400);
    const identity = await updateIdentity(request, single ? undefined : body.groupId);
    if (!single && identity.allowed && codes.some(c => !identity.allowed!.includes(c))) throw new UpdateQueueError('只能更新当前已同步分组中的公司', 403);
    // Manual actions always fill ten years; daily/recent are internal scheduler modes.
    if(body.mode!==undefined && !['ten-year','five-year'].includes(body.mode))throw new UpdateQueueError('仅支持补齐十年数据',400);
    const data=await q.submit(identity.owner, codes, body.retry === true,'ten-year');
    // 个股补齐是一次性请求，不替换自动更新订阅；拒绝的提交也不得改变订阅。
    if (!single) {
      const all = await updateIdentity(request, 'all');
      await registerCollection(getMarketStore()!,identity.owner,all.allowed??codes);
    }
    return json({ ok: true, data });
  } catch (e) { return failure(e); }
}
/** DELETE /api/market-updates —— 停止当前用户未完成的补齐/更新任务（在飞阶段最多再跑完当前阶段）。 */
export async function DELETE(request: NextRequest) {
  if (!sameOriginMutation(request)) return json({ ok: false, error: '请求来源无效' }, 403);
  try {
    const q = queue(request);
    const identity = await updateIdentity(request);
    const data = await q.cancel(identity.owner);
    return json({ ok: true, data });
  } catch (e) { return failure(e); }
}

/**
 * PUT /api/market-updates —— 管理员主动暂停/恢复后台队列消费（body: {paused: boolean, hours?}）。
 * 暂停期间后台执行器不再派发新任务（在飞阶段照常收尾）；已排队的任务保留，恢复后继续。
 */
export async function PUT(request: NextRequest) {
  if (!sameOriginMutation(request)) return json({ ok: false, error: '请求来源无效' }, 403);
  try {
    const q = queue(request);
    const denied = denyReason(request, true);
    if (denied) return json({ ok: false, error: denied }, denied.includes('登录') ? 401 : 403);
    let body: { paused?: unknown; hours?: unknown };
    try { body = JSON.parse(await readBody(request)); } catch { throw new UpdateQueueError('请求格式无效', 400); }
    if (typeof body.paused !== 'boolean') throw new UpdateQueueError('paused 必须是布尔值', 400);
    const hours = body.hours === undefined ? 24 : Number(body.hours);
    const data = await q.setWorkerPaused(body.paused, hours * 3600e3);
    return json({ ok: true, data: { pausedUntil: data } });
  } catch (e) { return failure(e); }
}
