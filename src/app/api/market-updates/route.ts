import { NextRequest, NextResponse } from 'next/server';
import { getMarketStore } from '@/lib/marketStore';
import { MarketUpdateQueue, UpdateQueueError, updateSymbols } from '@/lib/marketUpdateQueue';
import { localUpdatePreview, updateIdentity } from '@/lib/marketUpdateAuth';
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
    const q = queue(request); const identity = await updateIdentity(request,'all');
    if(identity.allowed)await registerCollection(getMarketStore()!,identity.owner,identity.allowed);
    return json({ ok: true, data: await q.status(identity.owner) });
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
    if (typeof body?.groupId !== 'string' || body.groupId.length > 100) throw new UpdateQueueError('请选择自选分组', 400);
    const codes = updateSymbols(body.codes);
    const identity = await updateIdentity(request, body.groupId);
    if (identity.allowed && codes.some(c => !identity.allowed!.includes(c))) throw new UpdateQueueError('只能更新当前已同步分组中的公司', 403);
    if(body.mode!==undefined && !['recent','five-year'].includes(body.mode))throw new UpdateQueueError('更新模式无效',400);
    const all=await updateIdentity(request,'all');
    await registerCollection(getMarketStore()!,identity.owner,all.allowed??codes);
    const data=await q.submit(identity.owner, codes, body.retry === true,body.mode??'recent');
    return json({ ok: true, data });
  } catch (e) { return failure(e); }
}
