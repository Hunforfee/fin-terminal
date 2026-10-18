import { NextRequest, NextResponse } from 'next/server';
import { readSession, sessionSecret, SESSION_COOKIE } from '@/lib/auth/session';
import { phoneLoginConfigured } from '@/lib/auth/phoneProvider';
import { dataSyncReady } from '@/lib/auth/accountData';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  return NextResponse.json(
    {
      ok: true,
      data: {
        user: readSession(request.cookies.get(SESSION_COOKIE)?.value),
        phoneLoginReady: phoneLoginConfigured() && !!sessionSecret(),
        dataSyncReady: dataSyncReady(),
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
