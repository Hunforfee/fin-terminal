import { NextRequest, NextResponse } from 'next/server';
import {
  normalizePhone,
  sameOriginMutation,
  sessionSecret,
} from '@/lib/auth/session';
import { phoneLoginConfigured, sendPhoneCode } from '@/lib/auth/phoneProvider';
import { allowAttempt } from '@/lib/auth/limits';
export const runtime = 'nodejs';
export async function POST(request: NextRequest) {
  const fail = (error: string, status: number) =>
    NextResponse.json(
      { ok: false, error },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  if (!sameOriginMutation(request)) return fail('请求来源无效', 403);
  if (!phoneLoginConfigured() || !sessionSecret())
    return fail('短信登录服务待 WorkBuddy 接入', 503);
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 512) return fail('请求过大', 413);
    body = JSON.parse(raw);
  } catch {
    return fail('请求格式无效', 400);
  }
  const phone = normalizePhone(body?.phone);
  if (!phone) return fail('请输入有效的手机号', 400);
  if (
    !allowAttempt('send-hour:' + phone, 5, 3600000) ||
    !allowAttempt('send-minute:' + phone, 1, 60000)
  )
    return fail('发送过于频繁，请稍后再试', 429);
  try {
    await sendPhoneCode(phone);
    return NextResponse.json(
      { ok: true, data: { retryAfter: 60 } },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return fail('验证码发送失败，请稍后重试', 502);
  }
}
