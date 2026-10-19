import { NextRequest, NextResponse } from 'next/server';
import { fetchCompanyProfile } from '@/lib/datasource/profile';
import { fetchBusiness } from '@/lib/datasource/business';
import { fetchReports } from '@/lib/datasource/research';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const code = (sp.get('code') ?? '').trim();
  const name = (sp.get('name') ?? '').trim();
  const market = (sp.get('market') ?? 'A') === 'HK' ? 'HK' : 'A';

  if (!code) {
    return NextResponse.json({ error: 'code required' }, { status: 400 });
  }

  try {
    const [profile, business, reports] = await Promise.all([
      fetchCompanyProfile(code, market).catch(() => null),
      fetchBusiness(code, market).catch(() => null),
      fetchReports(code, market).catch(() => []),
    ]);

    return NextResponse.json({
      name,
      code,
      market,
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
