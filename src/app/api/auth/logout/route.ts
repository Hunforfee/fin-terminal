import { NextRequest, NextResponse } from 'next/server';
import { sameOriginMutation, SESSION_COOKIE } from '@/lib/auth/session';
export async function POST(request: NextRequest) {
  if (!sameOriginMutation(request))
    return NextResponse.json(
      { ok: false, error: '请求来源无效' },
      { status: 403 },
    );
  const response = NextResponse.json(
    { ok: true },
    { headers: { 'Cache-Control': 'no-store' } },
  );
  response.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return response;
}
