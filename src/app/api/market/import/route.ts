import { NextRequest, NextResponse } from 'next/server';
import { getMarketStore, marketRecord } from '@/lib/marketStore';
import { importDailyPrices } from '@/lib/marketImportedBars';
import { denyReason, importAdminIds, readImportIdentity } from '@/lib/marketImportAuth';
import { maintainToken, readMaintainIdentity } from '@/lib/marketMaintainAuth';
import { writeHkDividendEvents, writeHkIndicators, writeHkStatements } from '@/lib/marketHkImportRecords';
import { klineCrossConflicts, writeDividendImplemented, writeDividendPlans, writeFinancialHistory, writeFinanceStatements, writeShareHistory } from '@/lib/marketImportRecords';
import { importAIndicators, importDisclosureDates } from '@/lib/marketAImportRecords';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

const LOG_KEY = 'import-log:v1';
const LOG_LIMIT = 200;
interface LogEntry { at: string; userId: string; action: string; detail?: unknown }

/** 写入身份：浏览器管理员会话（原路径）或维护令牌（机器客户端，如异地维护端）。 */
interface ImportIdentity { userId: string; via: 'session' | 'maintain-token' }

/**
 * 鉴权解析顺序：
 * 1. 维护令牌（x-fin-maintain-token / Bearer）：无浏览器会话的机器客户端走此路，
 *    身份记为令牌指纹 maintain:<fp12>，可单独撤销/轮换，不读任何账号数据；
 * 2. 登录会话 + MARKET_IMPORT_ADMIN_IDS 白名单 + 同源校验：网站管理员原路径不变。
 * 两条路都不通时 fail closed。
 */
function authorizeImport(request: NextRequest): { identity: ImportIdentity } | { denied: string; status: number } {
  const machine = readMaintainIdentity(request);
  if (machine) return { identity: { userId: machine.tokenId, via: 'maintain-token' } };
  const denied = denyReason(request, true);
  if (denied) return { denied, status: denied.includes('登录') ? 401 : 403 };
  return { identity: { userId: readImportIdentity(request)!.userId, via: 'session' } };
}

async function appendLog(store: NonNullable<ReturnType<typeof getMarketStore>>, entry: LogEntry) {
  for (let i = 0; i < 3; i++) {
    const old = await store.read<{ entries: LogEntry[] }>(LOG_KEY).catch(() => null);
    const entries = [...(old?.payload?.entries ?? []), entry].slice(-LOG_LIMIT);
    if (await store.write(marketRecord(LOG_KEY, 'import-log', 'admin:import', { entries }, 365 * 864e5, Date.now()), old?.digest ?? null)) return;
  }
}

/** GET /api/market/import —— 身份自检（会话或维护令牌）+ 最近导入日志 */
export async function GET(request: NextRequest) {
  const machine = maintainToken() ? readMaintainIdentity(request) : null;
  const sessionIdentity = machine ? null : readImportIdentity(request);
  const store = getMarketStore();
  const log = (machine || sessionIdentity) && store ? (await store.read<{ entries: LogEntry[] }>(LOG_KEY).catch(() => null))?.payload?.entries ?? [] : [];
  return json({
    ok: true,
    authorized: !!(machine || sessionIdentity),
    via: machine ? 'maintain-token' : sessionIdentity ? 'session' : null,
    userId: machine?.tokenId ?? sessionIdentity?.userId ?? null,
    maintainTokenConfigured: !!maintainToken(),
    adminConfigured: importAdminIds().length > 0,
    log: log.slice(-50).reverse(),
  });
}

/** POST /api/market/import —— 分类型导入：kline / finance / financial-history / share-history / dividend-plans / dividend-impl / disclosure-dates / a-indicators / hk-statements / hk-indicators / hk-dividend-events */
export async function POST(request: NextRequest) {
  const auth = authorizeImport(request);
  if ('denied' in auth) return json({ ok: false, error: auth.denied }, auth.status);
  const identity = auth.identity;
  const store = getMarketStore();
  if (!store) return json({ ok: false, error: '市场数据库不可用' }, 503);

  let body: { type?: string; record?: unknown };
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, 'utf8') > 4_000_000) return json({ ok: false, error: '请求超过 4MB 限制' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: '请求格式无效' }, 400);
  }
  const rec = body?.record as Record<string, unknown> | undefined;
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return json({ ok: false, error: '缺少 record' }, 400);

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
      // Validate the whole incoming batch and merge with an atomic digest-checked write.
      // Never delete the old record, including on invalid input or storage failure.
      if (rec.adjust !== undefined && rec.adjust !== 'none') throw Error('仅接受不复权日线');
      if (rec.period !== undefined && rec.period !== 'day') throw Error('仅接受日线');
      if (rec.source !== undefined && rec.source !== 'qmt' && rec.source !== 'tdx') throw Error('导入来源仅支持 qmt / tdx');
      // tdx 语义：只补新日期、保留已有更高精度观测、价格冲突拒绝写入（MCP 抓取回补走此路）。
      const source = rec.source === 'tdx' ? 'tdx' : 'qmt';
      const r = await importDailyPrices(store, {
        symbol, source, mergeBatch: true, candles,
        listingDate: typeof rec.listingDate === 'string' ? rec.listingDate : undefined,
      });
      result = { imported: r.skipped ? 0 : candles.length, from: r.from, to: r.to, symbol: r.symbol, total: r.count,
        ...(r.skipped ? { skipped: true } : {}) };
    } else if (body.type === 'finance') {
      result = await writeFinanceStatements(store, rec as never) as unknown as Record<string, unknown>;
    } else if (body.type === 'financial-history') {
      result = await writeFinancialHistory(store, rec as never) as unknown as Record<string, unknown>;
    } else if (body.type === 'share-history') {
      result = await writeShareHistory(store, rec as never) as unknown as Record<string, unknown>;
    } else if (body.type === 'dividend-plans') {
      result = await writeDividendPlans(store, String(rec.symbol ?? ''), rec.plans as never) as unknown as Record<string, unknown>;
    } else if (body.type === 'dividend-impl') {
      result = await writeDividendImplemented(store, String(rec.symbol ?? ''), rec.rows as never) as unknown as Record<string, unknown>;
    } else if (body.type === 'hk-statements') {
      // overwrite 仅管理员导入路由可传：全量快照修正历史口径缺陷（如人民币折算值 → 原币值）。
      result = await writeHkStatements(store, { symbol: String(rec.symbol ?? ''), statement: String(rec.statement ?? ''), rows: (rec.rows ?? []) as never,
        completeReports: rec.completeReports as never }, Date.now(), { overwrite: rec.overwrite === true }) as unknown as Record<string, unknown>;
    } else if (body.type === 'hk-indicators') {
      result = await writeHkIndicators(store, { symbol: String(rec.symbol ?? ''), points: (rec.points ?? []) as never }) as unknown as Record<string, unknown>;
    } else if (body.type === 'disclosure-dates') {
      result = await importDisclosureDates(store, rec) as unknown as Record<string, unknown>;
    } else if (body.type === 'a-indicators') {
      result = await importAIndicators(store, rec) as unknown as Record<string, unknown>;
    } else if (body.type === 'hk-dividend-events') {
      result = await writeHkDividendEvents(store, { symbol: String(rec.symbol ?? ''), rows: (rec.rows ?? []) as never }) as unknown as Record<string, unknown>;
    } else {
      return json({ ok: false, error: `未知类型: ${body.type}` }, 400);
    }
    await appendLog(store, { at: new Date().toISOString(), userId: identity.userId, action: `import:${body.type}`, detail: { symbol: rec.symbol ?? rec.code, ...result } });
    return json({ ok: true, type: body.type, result });
  } catch (e) {
    const message = e instanceof Error ? e.message : '导入失败';
    await appendLog(store, { at: new Date().toISOString(), userId: identity.userId, action: `import:${body.type}:error`, detail: { symbol: (rec as { symbol?: string }).symbol, message } }).catch(() => {});
    return json({ ok: false, error: message }, message.includes('冲突') ? 409 : 400);
  }
}
