import { createHash, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { allowAttempt } from '@/lib/auth/limits';
import { getMarketReadStore } from '@/lib/marketStore';
import { MARKET_DATA_RESOURCES, PUBLIC_MARKET_FAMILIES, isMarketDataResource, marketDataMethodAllowed } from '@/lib/marketDataResources';
import { readMarketBody, remoteMarketDataEnabled, MarketDataApiError } from '@/lib/marketDataClient';
import { readPublicMarketRecords, MarketRecordQueryError } from '@/lib/marketDataRecords';
import { marketDataHandlers } from '@/lib/marketDataHandlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
const json = (body: unknown, status = 200, extra?: Record<string, string>) => {
  if (Buffer.byteLength(JSON.stringify(body)) > 33554432) {
    body = { ok: false, error: '数据体积过大，请缩小查询范围' }; status = 413;
  }
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Fin-Data-Version': '1', ...extra } });
};
const digest = (value: string) => createHash('sha256').update(value).digest();
let activeRequests = 0;

async function serve(request: NextRequest): Promise<Response> {
  const expected = process.env.MARKET_DATA_API_TOKEN ?? process.env.MARKET_READONLY_TOKEN;
  if (!expected || expected.length < 32) return json({ ok: false, error: '数据 API 尚未启用' }, 404);
  const supplied = request.headers.get('x-fin-data-token') ?? request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];
  if (!supplied || supplied.length > 512 || !timingSafeEqual(digest(supplied), digest(expected)))
    return json({ ok: false, error: '数据接口凭证无效' }, 401);
  if (remoteMarketDataEnabled()) return json({ ok: false, error: '此服务器为数据使用端，不提供转发链' }, 503);
  if (!allowAttempt(`market-data-api:${digest(supplied).toString('hex')}`, 240, 60000))
    return json({ ok: false, error: '数据接口请求过于频繁，请稍后重试' }, 429, { 'Retry-After': '60' });
  const params = request.nextUrl.searchParams;
  if (['token', 'sql', 'api_key'].some(key => params.has(key)))
    return json({ ok: false, error: '凭证只能放在请求头中，且不支持 SQL 查询' }, 400);
  const resource = params.get('resource') ?? 'catalog';
  if (!isMarketDataResource(resource)) return json({ ok: false, error: '未知的数据类型，请查询 catalog' }, 404);
  if (!marketDataMethodAllowed(resource, request.method)) return json({ ok: false, error: '此数据类型不支持该方法' }, 405,
    { Allow: MARKET_DATA_RESOURCES[resource].join(', ') });
  if (activeRequests >= 8) return json({ ok: false, error: '数据服务正忙，请稍后重试' }, 429, { 'Retry-After': '5' });
  activeRequests++;
  try {
    if (resource === 'catalog') return json({ ok: true, data: {
      version: 1, resources: MARKET_DATA_RESOURCES, recordFamilies: PUBLIC_MARKET_FAMILIES,
      limits: { requestsPerMinutePerInstance: 240, requestBytes: 65536, responseBytes: 33554432, recordsPerPage: 20 },
      updatedAt: new Date().toISOString(),
    } });
    if (resource === 'diagnostics') {
      const { normalizeStockCode } = await import('@/lib/datasource/codes');
      const n=normalizeStockCode(params.get('code')??'');
      if(!n)return json({ok:false,error:'无效股票代码'},400);
      const store=getMarketReadStore();if(!store)return json({ok:false,error:'股票数据库尚未连接'},503);
      const { diagnoseMarketData }=await import('@/lib/marketDiagnostics');
      return json({ok:true,data:await diagnoseMarketData(store,n.symbol)});
    }
    if (resource === 'records') {
      const store = getMarketReadStore();
      if (!store) return json({ ok: false, error: '股票数据库尚未连接' }, 503);
      return json({ ok: true, data: await readPublicMarketRecords(store, params) });
    }
    if (resource === 'hk-valuation') {
      const { normalizeStockCode } = await import('@/lib/datasource/codes');
      const stock = normalizeStockCode(params.get('code') ?? '');
      const price = params.has('price') ? Number(params.get('price')) : null;
      const asOf = params.get('asOf') ?? undefined;
      if (!stock || stock.market !== 'HK' || price !== null && (!Number.isFinite(price) || price <= 0)
        || asOf && (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || !Number.isFinite(Date.parse(asOf))
          || new Date(asOf).toISOString().slice(0, 10) !== asOf))
        return json({ ok: false, error: '港股代码、价格或日期无效' }, 400);
      const { getHkCurrentValuation } = await import('@/lib/datasource');
      return json({ ok: true, data: await getHkCurrentValuation(stock.symbol, price, asOf) });
    }
    let body: Uint8Array | undefined;
    if (request.method === 'POST') {
      body = await readMarketBody(request, 65536);
      let value: unknown;
      try { value = JSON.parse(new TextDecoder().decode(body)); } catch { return json({ ok: false, error: '请求体须为有效 JSON' }, 400); }
      // Only the data-only company pool query is shared; AI processing stays on its own server.
      if (resource === 'company-learning' && (!value || typeof value !== 'object' || !('action' in value) || value.action !== 'pool'))
        return json({ ok: false, error: '共享资料接口仅支持 pool 查询' }, 403);
    }
    const target = new URL(`/api/${resource}`, request.url);
    for (const [key, value] of params) if (key !== 'resource') target.searchParams.append(key, value);
    const forwarded = new NextRequest(target, { method: request.method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: body as BodyInit } : {}), signal: request.signal });
    const handlers = await marketDataHandlers[resource]() as { GET?: (request: NextRequest) => Promise<Response>; POST?: (request: NextRequest) => Promise<Response> };
    const handler = request.method === 'POST' ? handlers.POST : handlers.GET;
    if (!handler) return json({ ok: false, error: '此数据类型不支持该方法' }, 405);
    const response = await handler(forwarded);
    const bytes = await readMarketBody(response, 33554432);
    if (!response.headers.get('content-type')?.includes('application/json')) throw Error('Non-JSON handler');
    return new NextResponse(bytes as BodyInit, { status: response.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Fin-Data-Version': '1' } });
  } catch (error) {
    if (error instanceof MarketRecordQueryError) return json({ ok: false, error: error.message }, error.status);
    if (error instanceof MarketDataApiError && error.status === 413) return json({ ok: false, error: '数据体积过大，请缩小查询范围' }, 413);
    return json({ ok: false, error: '股票数据服务暂不可用，请稍后重试' }, 503);
  } finally { activeRequests--; }
}
export async function GET(request: NextRequest) { return serve(request); }
export async function POST(request: NextRequest) { return serve(request); }
