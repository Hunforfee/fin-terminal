import { NextRequest, NextResponse } from 'next/server';
import {
  createSession,
  sameOriginMutation,
  sessionSecret,
  SESSION_COOKIE,
  SESSION_SECONDS,
} from '@/lib/auth/session';
import {
  AccountStoreError,
  normalizeUsername,
  verifyUser,
} from '@/lib/auth/userStore';
import { allowAttempt } from '@/lib/auth/limits';

export const runtime = 'nodejs';

/** POST /api/auth/login { username, password } —— 用户名密码登录 */
export async function POST(request: NextRequest) {
  const fail = (error: string, status: number) =>
    NextResponse.json(
      { ok: false, error },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  if (!sameOriginMutation(request)) return fail('请求来源无效', 403);
  const secret = sessionSecret();
  if (!secret) return fail('登录服务未配置会话密钥', 503);

  let body: { username?: unknown; password?: unknown };
  try {
    const raw = await request.text();
    if (raw.length > 512) return fail('请求过大', 413);
    body = JSON.parse(raw);
  } catch {
    return fail('请求格式无效', 400);
  }

  const username = normalizeUsername(body?.username);
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!username || !password || password.length > 128)
    return fail('请输入有效的用户名和密码', 400);
  if (!allowAttempt('login:' + username.toLowerCase(), 10, 600000))
    return fail('尝试过于频繁，请稍后再试', 429);

  try {
    const user = verifyUser(username, password);
    const response = NextResponse.json(
      { ok: true, data: { user: { id: user.id, phone: user.name } } },
      { headers: { 'Cache-Control': 'no-store' } },
    );
    response.cookies.set(
      SESSION_COOKIE,
      createSession({ id: user.id, phone: user.name }, secret),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_SECONDS,
      },
    );
    return response;
  } catch (e) {
    if (e instanceof AccountStoreError)
      return fail('账号服务暂不可用，请稍后重试', 503);
    return fail(e instanceof Error ? e.message : '登录失败', 401);
  }
}
