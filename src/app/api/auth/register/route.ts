import { NextRequest, NextResponse } from 'next/server';
import {
  createSession,
  sameOriginMutation,
  sessionSecret,
  SESSION_COOKIE,
  SESSION_SECONDS,
} from '@/lib/auth/session';
import { checkPasswordStrength, registerUser } from '@/lib/auth/userStore';
import { allowAttempt } from '@/lib/auth/limits';

export const runtime = 'nodejs';

/** POST /api/auth/register { username, password } —— 注册并直接登录 */
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

  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = body.password;
  if (!/^[\w\u4e00-\u9fa5-]{3,24}$/.test(username))
    return fail('用户名需 3-24 位字母、数字、下划线、中文或连字符', 400);
  const weak = checkPasswordStrength(password);
  if (weak) return fail(weak, 400);
  if (!allowAttempt('register-ip', 10, 3600000))
    return fail('注册过于频繁，请稍后再试', 429);

  try {
    const user = registerUser(username, password as string);
    const response = NextResponse.json(
      {
        ok: true,
        data: { user: { id: user.id, phone: user.name } },
      },
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
    return fail(e instanceof Error ? e.message : '注册失败', 400);
  }
}
