import type { NextRequest } from 'next/server';
import { readSession, sameOriginMutation, SESSION_COOKIE } from './auth/session';

/**
 * 管理员数据导入鉴权。
 * - 必须是本站登录会话（签名 Cookie），绝不信任浏览器提交的用户 ID。
 * - 白名单在服务器环境变量 MARKET_IMPORT_ADMIN_IDS（逗号分隔的稳定用户 ID）。
 * - 未配置白名单或 ID 不匹配一律拒绝（fail closed）。
 */
export function importAdminIds(): string[] {
  return (process.env.MARKET_IMPORT_ADMIN_IDS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

export interface ImportIdentity { userId: string }

/** 校验登录 + 白名单；通过返回身份，否则返回 null（由调用方决定错误码）。 */
export function readImportIdentity(request: NextRequest): ImportIdentity | null {
  const ids = importAdminIds();
  if (!ids.length) return null; // 未配置白名单：默认禁止
  const user = readSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!user || !user.id) return null;
  return ids.includes(user.id) ? { userId: user.id } : null;
}

/** 写操作额外要求同源请求。返回 null 表示通过，否则为拒绝原因。 */
export function denyReason(request: NextRequest, mutation: boolean): string | null {
  if (mutation && !sameOriginMutation(request)) return '请求来源无效';
  if (!importAdminIds().length) return '服务器未配置导入管理员白名单，导入已禁用';
  const user = readSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!user) return '请先登录';
  if (!importAdminIds().includes(user.id)) return '当前账号不在导入管理员白名单';
  return null;
}
