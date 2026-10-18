import { NextRequest, NextResponse } from 'next/server';
import { fetchAnnouncementContent } from '@/lib/datasource/announcements';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const artCode = request.nextUrl.searchParams.get('artCode') ?? '';
  if (!/^AN[\w-]+$/.test(artCode))
    return NextResponse.json(
      { ok: false, error: '参数无效' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  try {
    const data = await fetchAnnouncementContent(artCode);
    return NextResponse.json(
      { ok: true, data },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: '正文获取失败' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
