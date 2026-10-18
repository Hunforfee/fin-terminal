import { NextRequest, NextResponse } from 'next/server';
import { readSession, sessionSecret, SESSION_COOKIE } from '@/lib/auth/session';
import { phoneLoginConfigured } from '@/lib/auth/phoneProvider';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  return NextResponse.json(
    {
      ok: true,
      data: {
        user: readSession(request.cookies.get(SESSION_COOKIE)?.value),
        phoneLoginReady: phoneLoginConfigured() && !!sessionSecret(),
        dataSyncReady: !!process.env.DATABASE_URL,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
