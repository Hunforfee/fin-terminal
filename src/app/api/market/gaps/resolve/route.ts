import { NextRequest, NextResponse } from 'next/server';
import { getMarketStore } from '@/lib/marketStore';
import { denyReason, readImportIdentity } from '@/lib/marketImportAuth';
import { listFillGaps } from '@/lib/marketFillGaps';
import { resolveMarketGaps } from '@/lib/marketGapResolve';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

const MAX_SYMBOLS = 50;

/**
 * POST /api/market/gaps/resolve —— WorkBuddy 经 MCP 补齐数据后，逐 symbol 重跑覆盖复核。
 *
 * 鉴权与导入一致（管理员白名单 + 同源）。body:
 *   { symbols?: string[] }   省略时复核当前全部已登记缺口（上限 MAX_SYMBOLS）
 * 复核通过（coverage ready 或仅剩设计性缺口）→ 清除缺口登记；仍 partial → 更新缺口内容。
 */
export async function POST(request: NextRequest) {
  const denied = denyReason(request, true);
  if (denied) return json({ ok: false, error: denied }, denied.includes('登录') ? 401 : 403);
  const identity = readImportIdentity(request)!;
  const store = getMarketStore();
  if (!store) return json({ ok: false, error: '市场数据库不可用' }, 503);

  let body: { symbols?: unknown };
  try {
    body = JSON.parse(await request.text() || '{}');
  } catch {
    return json({ ok: false, error: '请求格式无效' }, 400);
  }

  let symbols: string[];
  if (Array.isArray(body.symbols)) {
    symbols = [...new Set(body.symbols.map(s => String(s ?? '').trim()).filter(Boolean))].slice(0, MAX_SYMBOLS);
    if (!symbols.length) return json({ ok: false, error: 'symbols 为空' }, 400);
  } else {
    const gaps = await listFillGaps(store, MAX_SYMBOLS);
    symbols = gaps.map(g => g.symbol);
    if (!symbols.length) return json({ ok: true, resolved: [], pending: 0, message: '当前没有已登记的缺口' });
  }

  console.info(`[gaps/resolve] user=${identity.userId} symbols=${symbols.length}`);
  const results = await resolveMarketGaps(store, symbols);

  const cleared = results.filter(r => r.cleared).length;
  return json({
    ok: true,
    resolved: results,
    total: results.length,
    cleared,
    remaining: results.length - cleared,
  });
}
