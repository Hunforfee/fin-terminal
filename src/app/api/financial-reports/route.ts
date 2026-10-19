import { NextRequest, NextResponse } from 'next/server';
import { normalizeStockCode } from '@/lib/datasource/codes';
import { getFinancialReports } from '@/lib/datasource/financialReports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code') ?? '';
  if (!normalizeStockCode(code)) return NextResponse.json({ ok: false, error: '股票代码无效' }, { status: 400 });
  try {
    const data = await getFinancialReports(code, request.nextUrl.searchParams.get('calendarYear') === '1');
    return NextResponse.json({ ok: true, data }, { headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch {
    return NextResponse.json({ ok: false, error: '原文目录暂不可用' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
