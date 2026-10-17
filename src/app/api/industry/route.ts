import type { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api';
import { getIndustryBoard } from '@/lib/datasource';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/industry —— 行业板块估值表（中位数口径 + 横截面分位） */
export async function GET(_request: NextRequest) {
  try {
    return ok(await getIndustryBoard());
  } catch (e) {
    return fail(e instanceof Error ? e.message : '行业数据获取失败', 502, e);
  }
}
