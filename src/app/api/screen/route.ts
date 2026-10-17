import type { NextRequest } from 'next/server';
import { ok, fail, sp } from '@/lib/api';
import { screen } from '@/lib/datasource';
import type { ScreenCriteria } from '@/lib/datasource/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function num(v: string | null): number | undefined {
  if (v === null || v === '' || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** GET /api/screen?peMin=0&peMax=30&roeMin=15&industry=银行&limit=50 */
export async function GET(request: NextRequest) {
  const p = sp(request);
  const criteria: ScreenCriteria = {
    market: (p.get('market') as ScreenCriteria['market']) ?? 'all',
    peMin: num(p.get('peMin')),
    peMax: num(p.get('peMax')),
    pbMin: num(p.get('pbMin')),
    pbMax: num(p.get('pbMax')),
    roeMin: num(p.get('roeMin')),
    marketCapMin: num(p.get('marketCapMin')),
    marketCapMax: num(p.get('marketCapMax')),
    changePctMin: num(p.get('changePctMin')),
    changePctMax: num(p.get('changePctMax')),
    industry: p.get('industry') ?? undefined,
    limit: Math.min(num(p.get('limit')) ?? 100, 300),
  };
  try {
    return ok(await screen(criteria));
  } catch (e) {
    return fail(e instanceof Error ? e.message : '筛选失败', 502, e);
  }
}
