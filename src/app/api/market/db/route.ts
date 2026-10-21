import { NextRequest, NextResponse } from 'next/server';
import { getMarketStore } from '@/lib/marketStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

function readToken(request: NextRequest): string | null {
  // 公网网关会覆盖 Authorization 头（注入自己的 JWT），所以优先读自定义头，
  // 再退回到 ?token= 查询参数，最后才是标准 Bearer。
  const header = request.headers.get('x-fin-readonly-token');
  if (header && header.length <= 512) return header;
  const query = request.nextUrl.searchParams.get('token');
  if (query && query.length <= 512) return query;
  const bearer = request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];
  return bearer ?? null;
}

/**
 * GET /api/market/db —— 服务器环境变量 MARKET_READONLY_TOKEN 鉴权的只读查询端点。
 * 严格只读：仅 store.read / store.scanPrefix，不提供任何写入、删除或 SQL。
 *
 * 用法（三选一参数）：
 *   ?key=kline:v2:sh600415:day:none:canonical:prices-only   精确读一条记录（含 payload）
 *   ?prefix=source-sina-page:v1:600415&limit=50             按前缀枚举（可选 payload=1 带出内容）
 *   ?keys=k1,k2,...                                         批量精确读（最多 20 个）
 *
 * 鉴权（任选其一）：
 *   Header  x-fin-readonly-token: <token>
 *   Query   ?token=<token>
 *   Header  Authorization: Bearer <token>   （仅本地直连有效，公网网关会覆盖该头）
 *
 * 未配置 MARKET_READONLY_TOKEN 时一律 404（fail closed）。
 */
export async function GET(request: NextRequest) {
  const expected = process.env.MARKET_READONLY_TOKEN;
  if (!expected || expected.length < 16) return json({ ok: false, error: 'not found' }, 404);
  const got = readToken(request);
  if (!got || got.length > 512 || got !== expected) return json({ ok: false, error: 'invalid token' }, 401);
  const store = getMarketStore();
  if (!store) return json({ ok: false, error: 'market store unavailable' }, 503);

  const sp = request.nextUrl.searchParams;
  const key = sp.get('key');
  const keysParam = sp.get('keys');
  const prefix = sp.get('prefix');

  try {
    if (key) {
      if (key.length > 300) return json({ ok: false, error: 'key too long' }, 400);
      const row = await store.read(key).catch(() => null);
      if (!row) return json({ ok: false, error: 'not found', key }, 404);
      return json({ ok: true, record: row });
    }
    if (keysParam) {
      const keys = keysParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
      const records = [];
      for (const k of keys) {
        const row = await store.read(k).catch(() => null);
        records.push(row ? { key: k, found: true, record: row } : { key: k, found: false });
      }
      return json({ ok: true, records });
    }
    if (prefix) {
      if (prefix.length > 200) return json({ ok: false, error: 'prefix too long' }, 400);
      const limit = Math.min(Math.max(Number(sp.get('limit') ?? 50), 1), 200);
      const withPayload = sp.get('payload') === '1';
      if (!store.scanPrefix) return json({ ok: false, error: 'store prefix scan not supported' }, 501);
      const rows = await store.scanPrefix(prefix, limit);
      const found: unknown[] = [];
      for (const r of rows) {
        if (withPayload) {
          const full = await store.read(r.key).catch(() => null);
          found.push(full ?? r);
        } else {
          found.push({ key: r.key, kind: r.kind, source: r.source, digest: r.digest, acquiredAt: r.acquiredAt, refreshAfter: r.refreshAfter });
        }
      }
      return json({ ok: true, prefix, count: found.length, records: found, truncated: rows.length >= limit });
    }
    return json({ ok: false, error: '需要 key、keys 或 prefix 参数' }, 400);
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : 'query failed' }, 500);
  }
}
