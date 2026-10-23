import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { allowAttempt } from '@/lib/auth/limits';
import { getMarketStore, valuationRevisionKey, marketRecord, type MarketStore } from '@/lib/marketStore';
import { appendMaintainLog, maintainToken, readMaintainIdentity, readMaintainLog } from '@/lib/marketMaintainAuth';
import { archiveCorrection, correctionKey, readCorrections } from '@/lib/marketCorrections';
import { allowedPublicMarketKey } from '@/lib/marketDataResources';
import { listFillGaps, readFillGap } from '@/lib/marketFillGaps';
import { resolveMarketGaps } from '@/lib/marketGapResolve';
import { MarketUpdateQueue, UpdateQueueError, type UpdateMode } from '@/lib/marketUpdateQueue';
import { coverageKey } from '@/lib/marketHistoryPlan';
import { normalizeStockCode } from '@/lib/datasource/codes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * 维护端 API（令牌鉴权，与登录会话/读取令牌/worker 凭证全部隔离）。
 *
 * GET  ?action=catalog|diagnostics|gaps|corrections|history|updates|log
 * POST {action:'updates'|'updates/retry'|'updates/cancel'|'correct'|'rebuild'|'resolve'}
 *
 * 数据写入（kline/财务/股本/分红等 8 类导入）统一走既有 /api/market/import，
 * 该路由已开放同一维护令牌通道，不在此重复实现。
 *
 * 范围仅限公共股票数据维护；不提供账号、个人资料、服务器命令或任意 SQL。
 * 补齐任务必须明确指定代码（≤20 只/批），daily 必须带目标日期；
 * 不提供「一键全市场重跑」入口，全部任务继续走全局队列的限速/去重/优先级。
 */

/** 单批任务股票上限：小批量，避免维护端一次挤占全站采集预算。 */
const MAX_CODES = 20;
/** 复核上限（与管理员复核路由一致）。 */
const MAX_RESOLVE = 50;
/** 维护动作请求体上限：修正/任务/复核均不带批量数据，1MB 足够。 */
const MAX_BODY_BYTES = 1_000_000;
const JOB_MODES: UpdateMode[] = ['recent', 'ten-year', 'daily'];

const json = (body: unknown, status = 200, extra?: Record<string, string>) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Fin-Data-Version': '1', ...extra } });

/** 队列归属：一个维护令牌同一时间只有一个活跃任务（由队列自身的冲突规则保证）。 */
const ownerOf = (tokenId: string) => tokenId;

function publicStock(input: unknown): string | null {
  const n = normalizeStockCode(String(input ?? ''));
  return n?.kind === 'stock' ? n.symbol : null;
}

async function audit(store: MarketStore, identity: { tokenId: string; operator: string; requestId: string }, action: string, ok: boolean, detail?: unknown, error?: string) {
  await appendMaintainLog(store, { requestId: identity.requestId, tokenId: identity.tokenId, operator: identity.operator, action, ok, detail, error }).catch(() => null);
}

export async function GET(request: NextRequest) {
  const identity = readMaintainIdentity(request);
  if (!maintainToken()) return json({ ok: false, error: '服务器未配置维护接口令牌，维护接口已禁用' }, 404);
  if (!identity) return json({ ok: false, error: '维护接口凭证无效' }, 401);
  const params = request.nextUrl.searchParams;
  if (['token', 'sql', 'api_key'].some(k => params.has(k)))
    return json({ ok: false, error: '凭证只能放在请求头中，且不支持 SQL 查询' }, 400);
  const store = getMarketStore();
  if (!store) return json({ ok: false, error: '市场数据库不可用' }, 503);
  const action = params.get('action') ?? 'catalog';

  if (action === 'catalog') {
    return json({
      ok: true,
      data: {
        version: 1,
        authentication: ['x-fin-maintain-token: <令牌>', 'Authorization: Bearer <令牌>'],
        actions: {
          'GET diagnostics': '单只股票诊断（三表缺口/来源行情范围/估值状态），参数 code',
          'GET gaps': '缺口台账；参数 code 可选，缺省列全部（≤100）',
          'GET corrections': '某股票的全部修正存档（旧值/新值/依据/身份/请求编号），参数 code',
          'GET history': '某公开数据键的最近版本，参数 key',
          'GET updates': '当前维护任务进度',
          'GET log': '最近维护审计日志（含请求编号）',
          'POST updates': '提交补齐任务：{codes[≤20], mode: recent|ten-year|daily, targetDate?}；daily 必须显式指定目标日期',
          'POST updates/retry': '重试当前任务中失败的公司：{codes}',
          'POST updates/cancel': '停止当前维护任务',
          'POST correct': '修正公开数据：{code, key, value, basis, note?}；修正记录长效存档',
          'POST rebuild': '递增估值输入版本，触发跨进程估值重算：{code}',
          'POST resolve': '复核缺口（最多 50 只）：{codes?}',
          '写入(导入)': '统一走 POST /api/market/import（同一维护令牌），类型：kline/finance/financial-history/share-history/dividend-plans/dividend-impl/hk-statements/hk-indicators/hk-dividend-events',
        },
        limits: {
          maxCodesPerJob: MAX_CODES,
          maxResolveSymbols: MAX_RESOLVE,
          jobModes: JOB_MODES,
          allMarketResubmit: '禁止；必须明确指定代码',
          note: 'recent 对未初始化股票会按全量历史采集执行，不等于轻量任务',
        },
      },
    });
  }

  if (action === 'diagnostics') {
    const symbol = publicStock(params.get('code'));
    if (!symbol) return json({ ok: false, error: '无效股票代码（仅支持 A 股/港股个股）' }, 400);
    const { diagnoseMarketData } = await import('@/lib/marketDiagnostics');
    return json({ ok: true, data: await diagnoseMarketData(store, symbol) });
  }

  if (action === 'gaps') {
    const raw = params.get('code');
    if (raw) {
      const symbol = publicStock(raw);
      if (!symbol) return json({ ok: false, error: '无效股票代码' }, 400);
      const gap = await readFillGap(store, symbol).catch(() => null);
      return json({ ok: true, data: { symbol, gap } });
    }
    const limit = Math.min(100, Math.max(1, Number(params.get('limit') ?? 100) || 100));
    return json({ ok: true, data: { gaps: await listFillGaps(store, limit) } });
  }

  if (action === 'corrections') {
    const symbol = publicStock(params.get('code'));
    if (!symbol) return json({ ok: false, error: '无效股票代码' }, 400);
    const limit = Math.min(100, Math.max(1, Number(params.get('limit') ?? 50) || 50));
    return json({ ok: true, data: { symbol, corrections: await readCorrections(store, symbol, limit) } });
  }

  if (action === 'history') {
    const key = (params.get('key') ?? '').trim();
    if (!key || !allowedPublicMarketKey(key)) return json({ ok: false, error: '仅支持查询公开市场数据键' }, 400);
    if (!store.readVersions) return json({ ok: false, error: '当前存储不支持版本查询' }, 501);
    const versions = await store.readVersions(key, 4);
    return json({ ok: true, data: { key, versions } });
  }

  if (action === 'updates') {
    const queue = new MarketUpdateQueue(store);
    return json({ ok: true, data: await queue.status(ownerOf(identity.tokenId)) });
  }

  if (action === 'log') {
    const limit = Math.min(200, Math.max(1, Number(params.get('limit') ?? 50) || 50));
    return json({ ok: true, data: { entries: await readMaintainLog(store, limit) } });
  }

  return json({ ok: false, error: `未知动作: ${action}` }, 404);
}

export async function POST(request: NextRequest) {
  const identity = readMaintainIdentity(request);
  if (!maintainToken()) return json({ ok: false, error: '服务器未配置维护接口令牌，维护接口已禁用' }, 404);
  if (!identity) return json({ ok: false, error: '维护接口凭证无效' }, 401);
  if (!allowAttempt(`market-maintain:${identity.tokenId}`, 120, 60000))
    return json({ ok: false, error: '维护接口请求过于频繁，请稍后重试' }, 429, { 'Retry-After': '60' });
  const store = getMarketStore();
  if (!store) return json({ ok: false, error: '市场数据库不可用' }, 503);

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return json({ ok: false, error: '请求超过 1MB 限制' }, 413);
    body = JSON.parse(raw || '{}');
  } catch {
    return json({ ok: false, error: '请求格式无效' }, 400);
  }
  const action = String(body.action ?? '');

  try {
    // ---------- 补齐任务 ----------
    if (action === 'updates' || action === 'updates/retry') {
      const retry = action === 'updates/retry';
      const rawCodes = body.codes;
      if (!Array.isArray(rawCodes) || !rawCodes.length || rawCodes.length > MAX_CODES)
        return json({ ok: false, error: `codes 必须为 1—${MAX_CODES} 只股票的数组；不提供一键全市场重跑` }, 400);
      const symbols = rawCodes.map(publicStock);
      if (symbols.some(s => !s)) return json({ ok: false, error: 'codes 含无效股票代码（仅支持 A 股/港股个股）' }, 400);
      const mode = (body.mode ?? 'recent') as UpdateMode;
      if (!JOB_MODES.includes(mode)) return json({ ok: false, error: `mode 仅支持 ${JOB_MODES.join(' / ')}` }, 400);
      const targetDate = body.targetDate === undefined ? undefined : String(body.targetDate);
      if (mode === 'daily' && !targetDate) return json({ ok: false, error: 'daily 任务必须显式指定 targetDate（YYYY-MM-DD）' }, 400);
      const queue = new MarketUpdateQueue(store);
      const progress = await queue.submit(ownerOf(identity.tokenId), symbols, retry, mode, targetDate);
      // recent 对未初始化股票会扩大为全量采集：如实标注，不按模式名蒙蔽调用方。
      const warnings: string[] = [];
      if (mode === 'recent' || mode === 'ten-year') {
        for (const symbol of symbols) {
          const coverage = (await store.read<{ status?: string }>(coverageKey(symbol!)).catch(() => null))?.payload;
          if (coverage?.status !== 'ready')
            warnings.push(`${symbol} 尚未完成初始化，${mode === 'ten-year' ? '十年' : 'recent'} 任务将按全量历史采集执行（耗时与请求量远高于增量更新）`);
        }
      }
      await audit(store, identity, action, true, { codes: symbols, mode, targetDate, job: progress.id, warnings });
      return json({ ok: true, data: { ...progress, warnings } });
    }

    if (action === 'updates/cancel') {
      const queue = new MarketUpdateQueue(store);
      const progress = await queue.cancel(ownerOf(identity.tokenId));
      await audit(store, identity, action, true, { job: progress?.id });
      return json(progress ? { ok: true, data: progress } : { ok: false, error: '当前没有进行中的维护任务' }, progress ? 200 : 404);
    }

    // ---------- 修正 ----------
    if (action === 'correct') {
      const symbol = publicStock(body.code);
      if (!symbol) return json({ ok: false, error: '无效股票代码（仅支持 A 股/港股个股）' }, 400);
      const key = String(body.key ?? '').trim();
      if (!key || !allowedPublicMarketKey(key) || !key.includes(symbol))
        return json({ ok: false, error: 'key 必须是属于该股票的公开市场数据键' }, 400);
      const value = body.value;
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return json({ ok: false, error: 'value 必须为修正后的完整数据对象' }, 400);
      const basis = String(body.basis ?? '').trim();
      if (basis.length < 5 || basis.length > 500)
        return json({ ok: false, error: 'basis 须为 5—500 字的来源依据（公告/交易所原文或可复核说明）' }, 400);
      const note = body.note === undefined ? undefined : String(body.note).slice(0, 500);

      const old = await store.read(key);
      if (!old) return json({ ok: false, error: '记录不存在，无法修正（新增请走导入）' }, 404);
      const ttl = Math.max(864e5, Date.parse(old.refreshAfter) - Date.parse(old.acquiredAt));
      const next = marketRecord(key, old.kind, 'maintain', value, ttl);
      if (next.digest === old.digest) return json({ ok: false, error: '修正后的内容与当前记录一致，未写入' }, 409);

      // 先长效存档（旧值/新值/依据/身份/请求编号），再落新值；存档失败不写库。
      const archived = await archiveCorrection(store, {
        symbol, key, oldValue: old, newValue: next, basis,
        operator: identity.operator, requestId: identity.requestId, ...(note ? { note } : {}),
      });
      if (!archived) return json({ ok: false, error: '修正存档写入冲突，请重试' }, 409);
      const written = await store.write(next, old.digest);
      if (!written) return json({ ok: false, error: '记录已被其他操作修改，请重新读取后再修正' }, 409);
      await audit(store, identity, action, true, { symbol, key, correction: correctionKey(symbol, identity.requestId), basis });
      return json({ ok: true, data: { symbol, key, digest: next.digest, correctionKey: correctionKey(symbol, identity.requestId), archived: true } });
    }

    // ---------- 估值重建 ----------
    if (action === 'rebuild') {
      const symbol = publicStock(body.code);
      if (!symbol) return json({ ok: false, error: '无效股票代码（仅支持 A 股/港股个股）' }, 400);
      const key = valuationRevisionKey(symbol);
      let version: string | null = null;
      for (let attempt = 0; attempt < 12 && !version; attempt++) {
        const old = await store.read(key).catch(() => null);
        version = randomUUID();
        if (await store.write(marketRecord(key, 'valuation-input-version', 'maintain', { version }, 365 * 864e5), old?.digest ?? null)) break;
        version = null;
      }
      if (!version) return json({ ok: false, error: '估值版本更新冲突，请重试' }, 409);
      await audit(store, identity, action, true, { symbol, version });
      return json({ ok: true, data: { symbol, version } });
    }

    // ---------- 缺口复核 ----------
    if (action === 'resolve') {
      let symbols: string[];
      if (Array.isArray(body.codes)) {
        if (!body.codes.length || body.codes.length > MAX_RESOLVE)
          return json({ ok: false, error: `codes 必须为 1—${MAX_RESOLVE} 只股票的数组` }, 400);
        const normalized = body.codes.map(publicStock);
        if (normalized.some(s => !s)) return json({ ok: false, error: 'codes 含无效股票代码' }, 400);
        symbols = normalized as string[];
      } else {
        const gaps = await listFillGaps(store, MAX_RESOLVE);
        symbols = gaps.map(g => g.symbol);
        if (!symbols.length) return json({ ok: true, data: { resolved: [], pending: 0, message: '当前没有已登记的缺口' } });
      }
      const results = await resolveMarketGaps(store, symbols);
      await audit(store, identity, action, true, { symbols: symbols.length, cleared: results.filter(r => r.cleared).length });
      return json({ ok: true, data: { resolved: results, total: results.length, cleared: results.filter(r => r.cleared).length, remaining: results.length - results.filter(r => r.cleared).length } });
    }

    return json({ ok: false, error: `未知动作: ${action || '(缺失)'}` }, 400);
  } catch (e) {
    if (e instanceof UpdateQueueError) {
      await audit(store, identity, action, false, undefined, e.message);
      return json({ ok: false, error: e.message }, e.status);
    }
    const message = e instanceof Error ? e.message : '操作失败';
    await audit(store, identity, action, false, undefined, message);
    return json({ ok: false, error: message }, 500);
  }
}
