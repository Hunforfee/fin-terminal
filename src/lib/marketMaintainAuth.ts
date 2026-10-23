import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { marketRecord, type MarketStore } from './marketStore';

/**
 * 维护端专用 API 凭证。
 *
 * 与以下凭证完全隔离，可单独撤销/轮换（仅改本环境变量并重启）：
 * - MARKET_DATA_API_TOKEN / MARKET_READONLY_TOKEN（只读数据接口）
 * - AUTH_SESSION_SECRET（用户登录会话）
 * - MARKET_UPDATE_WORKER_TOKEN（后台执行器）
 *
 * 授权范围仅限公共股票数据维护（查询/补齐/修正/复核），
 * 不提供账号、个人资料、服务器命令或任意 SQL 能力。
 */

/** 读取维护令牌；未配置或过短一律视为未启用（fail closed）。 */
export function maintainToken(): string | null {
  const token = process.env.MARKET_MAINTENANCE_TOKEN?.trim();
  return token && token.length >= 32 ? token : null;
}

export interface MaintainIdentity {
  /** 令牌指纹，不可反推令牌本体；用于审计与修正记录的操作身份。 */
  tokenId: string;
  /** 操作人标签：优先取调用方通过 x-fin-maintain-operator 自报的身份，否则为令牌指纹。 */
  operator: string;
  /** 每次请求唯一编号，贯穿审计日志与修正记录。 */
  requestId: string;
}

const digest = (value: string) => createHash('sha256').update(value).digest();
const fingerprint = (token: string) => digest(token).toString('hex');

/** 校验维护令牌。通过返回身份（含请求编号），否则返回 null。 */
export function readMaintainIdentity(request: NextRequest): MaintainIdentity | null {
  const expected = maintainToken();
  if (!expected) return null;
  const supplied = request.headers.get('x-fin-maintain-token')
    ?? request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
  if (!supplied || supplied.length > 512) return null;
  if (!timingSafeEqual(digest(supplied), digest(expected))) return null;
  const reported = (request.headers.get('x-fin-maintain-operator') ?? '').trim().slice(0, 64);
  const fp = fingerprint(expected);
  return {
    tokenId: `maintain:${fp.slice(0, 12)}`,
    operator: reported || `maintain-token:${fp.slice(0, 8)}`,
    requestId: randomUUID(),
  };
}

/** fail-closed 拒绝原因；null 表示通过。 */
export function denyMaintainReason(request: NextRequest): string | null {
  if (!maintainToken()) return '服务器未配置维护接口令牌，维护接口已禁用';
  if (!readMaintainIdentity(request)) return '维护接口凭证无效';
  return null;
}

const LOG_KEY = 'market-maintain-log:v1';
const LOG_LIMIT = 500;

/** 维护审计日志：滚动保留最近 500 条，每条含请求编号与操作身份。 */
export async function appendMaintainLog(store: MarketStore, entry: {
  at?: string; requestId: string; tokenId: string; operator: string;
  action: string; ok: boolean; detail?: unknown; error?: string;
}): Promise<void> {
  const row = { ...entry, at: entry.at ?? new Date().toISOString() };
  for (let attempt = 0; attempt < 3; attempt++) {
    const old = await store.read<{ entries: unknown[] }>(LOG_KEY).catch(() => null);
    const entries = [...(old?.payload?.entries ?? []), row].slice(-LOG_LIMIT);
    if (await store.write(marketRecord(LOG_KEY, 'market-maintain-log', 'maintain', { entries }, 365 * 864e5), old?.digest ?? null)) return;
  }
}

/** 读取最近维护审计日志（不含任何凭证内容）。 */
export async function readMaintainLog(store: MarketStore, limit = 50): Promise<unknown[]> {
  const entries = (await store.read<{ entries: unknown[] }>(LOG_KEY).catch(() => null))?.payload?.entries ?? [];
  return entries.slice(-Math.max(1, Math.min(200, limit))).reverse();
}
