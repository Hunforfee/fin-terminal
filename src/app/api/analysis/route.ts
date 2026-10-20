import { NextRequest, NextResponse } from 'next/server';
import { fetchCompanyProfile } from '@/lib/datasource/profile';
import { fetchBusiness } from '@/lib/datasource/business';
import { fetchReports } from '@/lib/datasource/research';
import { getPreAnalysis } from '@/data/analyses';
import { normalizeStockCode } from '@/lib/datasource/codes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const stock = normalizeStockCode((sp.get('code') ?? '').trim());
  const code = stock?.code ?? '';
  const name = (sp.get('name') ?? '').trim();
  const market = stock?.market === 'HK' ? 'HK' : 'A';

  if (!code) {
    return NextResponse.json({ error: 'code required' }, { status: 400 });
  }

  try {
    // 预生成深度解析（服务端持有，避免把 100+ 份 JSON 打进客户端包）
    const pre = getPreAnalysis(code) ?? null;

    const [profile, business, reports] = await Promise.all([
      fetchCompanyProfile(code, market).catch(() => null),
      fetchBusiness(code, market).catch(() => null),
      fetchReports(code, market).catch(() => []),
    ]);

    return NextResponse.json({
      name: name && !/^(?:(?:sh|sz|bj|hk))?\d{1,6}(?:\.(?:sh|sz|bj|hk))?$/i.test(name) ? name : pre?.fullName || name || code,
      code,
      market,
      pre,
      analysisStatus: pre ? pre.researchStatus || 'legacy' : 'missing',
      profile: profile
        ? {
            holder: profile.holder,
            holderRatio: profile.holderRatio,
            controller: profile.controller,
            industry: profile.industry,
            industryPath: profile.industryPath,
          }
        : null,
      business,
      reports,
      reportCount: reports.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: String(e?.message ?? e) },
      { status: 500 },
    );
  }
}
