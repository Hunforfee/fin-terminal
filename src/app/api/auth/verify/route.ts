import { NextRequest, NextResponse } from 'next/server';
import {
  createSession,
  normalizePhone,
  maskPhone,
  sameOriginMutation,
  sessionSecret,
  SESSION_COOKIE,
  SESSION_SECONDS,
} from '@/lib/auth/session';
import {
  phoneLoginConfigured,
  verifyPhoneCode,
} from '@/lib/auth/phoneProvider';
import { allowAttempt } from '@/lib/auth/limits';
export const runtime = 'nodejs';
export async function POST(request: NextRequest) {
  const fail = (error: string, status: number) =>
    NextResponse.json(
      { ok: false, error },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  if (!sameOriginMutation(request)) return fail('请求来源无效', 403);
  const secret = sessionSecret();
  if (!phoneLoginConfigured() || !secret)
    return fail('短信登录服务待 WorkBuddy 接入', 503);
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 1024) return fail('请求过大', 413);
    body = JSON.parse(raw);
  } catch {
    return fail('请求格式无效', 400);
  }
  const phone = normalizePhone(body?.phone);
  if (!phone || typeof body?.code !== 'string' || !/^\d{4,8}$/.test(body.code))
    return fail('请输入有效的手机号和验证码', 400);
  if (!allowAttempt('verify:' + phone, 10, 600000))
    return fail('尝试过于频繁，请稍后再试', 429);
  try {
    const identity = await verifyPhoneCode(phone, body.code);
    if (
      normalizePhone(identity.phone) !== phone ||
      typeof identity.id !== 'string' ||
      !identity.id ||
      identity.id.length > 200
    )
      return fail('登录身份校验失败', 401);
    const user = { id: identity.id, phone: maskPhone(phone) };
    const response = NextResponse.json(
      { ok: true, data: { user } },
      { headers: { 'Cache-Control': 'no-store' } },
    );
    response.cookies.set(SESSION_COOKIE, createSession(user, secret), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_SECONDS,
    });
    return response;
  } catch {
    return fail('验证码无效或已过期', 401);
  }
}
