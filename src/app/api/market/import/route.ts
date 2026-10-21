import { NextRequest, NextResponse } from 'next/server';
import { getMarketStore, marketRecord } from '@/lib/marketStore';
import { importDailyPrices, importedBarsKey } from '@/lib/marketImportedBars';
import { denyReason, importAdminIds, readImportIdentity } from '@/lib/marketImportAuth';
import { klineCrossConflicts, writeDividendImplemented, writeDividendPlans, writeFinancialHistory, writeFinanceStatements } from '@/lib/marketImportRecords';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

const LOG_KEY = 'import-log:v1';
const LOG_LIMIT = 200;
interface LogEntry { at: string; userId: string; action: string; detail?: unknown }

async function appendLog(store: NonNullable<ReturnType<typeof getMarketStore>>, entry: LogEntry) {
  for (let i = 0; i < 3; i++) {
    const old = await store.read<{ entries: LogEntry[] }>(LOG_KEY).catch(() => null);
    const entries = [...(old?.payload?.entries ?? []), entry].slice(-LOG_LIMIT);
    if (await store.write(marketRecord(LOG_KEY, 'import-log', 'admin:import', { entries }, 365 * 864e5, Date.now()), old?.digest ?? null)) return;
  }
}

/** GET /api/market/import —— 身份与白名单自检 + 最近导入日志 */
export async function GET(request: NextRequest) {
  const identity = readImportIdentity(request);
  const store = getMarketStore();
  const log = identity && store ? (await store.read<{ entries: LogEntry[] }>(LOG_KEY).catch(() => null))?.payload?.entries ?? [] : [];
  return json({
    ok: true,
    authorized: !!identity,
    userId: identity?.userId ?? null,
    adminConfigured: importAdminIds().length > 0,
    log: log.slice(-50).reverse(),
  });
}

/** POST /api/market/import —— 分类型导入：kline / finance / dividend-plans / dividend-impl */
export async function POST(request: NextRequest) {
  const denied = denyReason(request, true);
  if (denied) return json({ ok: false, error: denied }, denied.includes('登录') ? 401 : 403);
  const identity = readImportIdentity(request)!;
  const store = getMarketStore();
  if (!store) return json({ ok: false, error: '市场数据库不可用' }, 503);

  let body: { type?: string; record?: unknown };
  try {
    const raw = await request.text();
    if (raw.length > 4_000_000) return json({ ok: false, error: '请求超过 4MB 限制' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: '请求格式无效' }, 400);
  }
  const rec = body?.record as Record<string, unknown> | undefined;
  if (!rec || typeof rec !== 'object') return json({ ok: false, error: '缺少 record' }, 400);

  try {
    let result: Record<string, unknown>;
    if (body.type === 'kline') {
      const symbol = String(rec.symbol ?? '');
      const rawCandles = Array.isArray(rec.candles) ? rec.candles : [];
      const candles = rawCandles.map((c: Record<string, unknown>) => ({
        date: String(c.date), open: Number(c.open), high: Number(c.high),
        low: Number(c.low), close: Number(c.close),
      }));
      if (!candles.length) return json({ ok: false, error: 'K线为空' }, 400);
      const conflicts = await klineCrossConflicts(store, symbol, candles);
      if (conflicts.length) {
        await appendLog(store, { at: new Date().toISOString(), userId: identity.userId, action: 'kline-conflict', detail: { symbol, conflicts } });
        return json({ ok: false, error: `与库内行情冲突 ${conflicts.length} 处，未写入`, conflicts }, 409);
      }
      // 增量合并：与已有 canonical 按日期并集合并（重叠日以本次为准）。
      // 重叠日价差 ≤1% 视为显示精度差异、以本次覆盖；>1% 视为冲突拒绝。
      // 完全一致则幂等跳过，支持分批上传与重复上传。
      const oldRow = await store.read<{ candles: { date: string; open: number; high: number; low: number; close: number }[] }>(importedBarsKey(symbol)).catch(() => null);
      const oldCandles = oldRow?.payload?.candles ?? [];
      const incoming = new Map(candles.map(c => [c.date, c]));
      let merged = candles;
      if (oldCandles.length) {
        const bigConflicts: unknown[] = [];
        for (const o of oldCandles) {
          const c = incoming.get(o.date);
          if (!c) continue;
          const base = Math.max(Math.abs(o.close), 1e-8);
          if (['open', 'high', 'low', 'close'].some(f => Math.abs(c[f as 'close'] - o[f as 'close']) > base * 0.01))
            bigConflicts.push({ date: o.date, incoming: c.close, existing: o.close, source: 'canonical' });
        }
        if (bigConflicts.length) {
          await appendLog(store, { at: new Date().toISOString(), userId: identity.userId, action: 'kline-conflict', detail: { symbol, conflicts: bigConflicts } });
          return json({ ok: false, error: `与已有 canonical 数据冲突 ${bigConflicts.length} 处，未写入`, conflicts: bigConflicts }, 409);
        }
        const changed = oldCandles.some(o => {
          const c = incoming.get(o.date);
          return c && ['open', 'high', 'low', 'close'].some(f => Math.abs(c[f as 'close'] - o[f as 'close']) > 1e-8);
        });
        const union = new Map(oldCandles.map(c => [c.date, c]));
        for (const [d, c] of incoming) union.set(d, c);
        merged = [...union.values()].sort((a, b) => a.date.localeCompare(b.date));
        if (!changed && union.size === oldCandles.length) {
          await appendLog(store, { at: new Date().toISOString(), userId: identity.userId, action: 'import:kline', detail: { symbol, skipped: true } });
          return json({ ok: true, type: 'kline', result: { symbol, skipped: true, imported: 0 } });
        }
        // 重叠日存在微小差异（原记录为其他来源样本）：删除旧记录后整体重写为本次口径
        if (changed && store.remove && oldRow)
          await store.remove(importedBarsKey(symbol), oldRow.digest);
      }
      const r = await importDailyPrices(store, {
        symbol, source: 'qmt',
        candles: merged as never,
        listingDate: typeof rec.listingDate === 'string' ? rec.listingDate : undefined,
      });
      result = { imported: incoming.size, from: r.from, to: r.to, symbol: r.symbol, total: r.count };
    } else if (body.type === 'finance') {
      result = await writeFinanceStatements(store, rec as never) as unknown as Record<string, unknown>;
    } else if (body.type === 'financial-history') {
      result = await writeFinancialHistory(store, rec as never) as unknown as Record<string, unknown>;
    } else if (body.type === 'dividend-plans') {
      result = await writeDividendPlans(store, String(rec.symbol ?? ''), rec.plans as never) as unknown as Record<string, unknown>;
    } else if (body.type === 'dividend-impl') {
      result = await writeDividendImplemented(store, String(rec.symbol ?? ''), rec.rows as never) as unknown as Record<string, unknown>;
    } else {
      return json({ ok: false, error: `未知类型: ${body.type}` }, 400);
    }
    await appendLog(store, { at: new Date().toISOString(), userId: identity.userId, action: `import:${body.type}`, detail: { symbol: rec.symbol ?? rec.code, ...result } });
    return json({ ok: true, type: body.type, result });
  } catch (e) {
    const message = e instanceof Error ? e.message : '导入失败';
    await appendLog(store, { at: new Date().toISOString(), userId: identity.userId, action: `import:${body.type}:error`, detail: { symbol: (rec as { symbol?: string }).symbol, message } }).catch(() => {});
    return json({ ok: false, error: message }, 400);
  }
}
