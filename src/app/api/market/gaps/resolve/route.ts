import { NextRequest, NextResponse } from 'next/server';
import { getMarketStore } from '@/lib/marketStore';
import { denyReason, readImportIdentity } from '@/lib/marketImportAuth';
import { collectHistoryPhase, coverageKey } from '@/lib/marketHistoryCollection';
import { applyGapClassification, classifyCoverage, listFillGaps, readFillGap } from '@/lib/marketFillGaps';
import { normalizeStockCode } from '@/lib/datasource/codes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/** 单个 symbol 复核超时：phase 12 以库内复核为主，30s 足够，超时按未解决处理。 */
const PER_SYMBOL_TIMEOUT = 30e3;
const MAX_SYMBOLS = 50;

export interface GapResolveItem {
  symbol: string;
  status: 'cleared' | 'remaining' | 'error';
  cleared: boolean;
  remaining?: { mcp: string[]; manual: string[] };
  error?: string;
}

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

  const results: GapResolveItem[] = [];
  console.info(`[gaps/resolve] user=${identity.userId} symbols=${symbols.length}`);
  for (const raw of symbols) {
    const n = normalizeStockCode(raw);
    if (!n || n.kind !== 'stock') {
      results.push({ symbol: raw, status: 'error', cleared: false, error: '证券代码无效' });
      continue;
    }
    const symbol = n.symbol;
    try {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(Error('复核超时')), PER_SYMBOL_TIMEOUT);
      let phaseError: Error | null = null;
      try {
        await collectHistoryPhase(symbol, 12, abort.signal);
      } catch (e) {
        phaseError = e instanceof Error ? e : new Error(String(e));
      } finally {
        clearTimeout(timer);
      }
      // phase 12 覆盖不足时抛「已保存可用数据；…」（记录已落库），属预期结果；其余错误（超时等）按失败处理。
      if (phaseError && !phaseError.message.startsWith('已保存可用数据')) throw phaseError;
      const coverage = (await store.read<Record<string, unknown>>(coverageKey(symbol)))?.payload ?? null;
      if (!coverage || !['ready', 'partial'].includes(String(coverage.status))) throw Error('覆盖复核结果缺失或无效');
      const classified = classifyCoverage(coverage as { status?: string; missingInputs?: unknown; gaps?: unknown } | null);
      const gap = await applyGapClassification(store, symbol, classified, { mode: 'ten-year' });
      if (gap) results.push({ symbol, status: 'remaining', cleared: false, remaining: { mcp: gap.mcp, manual: gap.manual } });
      else results.push({ symbol, status: 'cleared', cleared: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : '复核失败';
      const gap = await readFillGap(store, symbol).catch(() => null);
      results.push({ symbol, status: 'error', cleared: false, error: message, ...(gap ? { remaining: { mcp: gap.mcp, manual: gap.manual } } : {}) });
    }
  }

  const cleared = results.filter(r => r.cleared).length;
  return json({
    ok: true,
    resolved: results,
    total: results.length,
    cleared,
    remaining: results.length - cleared,
  });
}
