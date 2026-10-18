import type { NextRequest } from 'next/server';
import { ok, fail, sp } from '@/lib/api';
import { getCompanyProfile } from '@/lib/datasource';

export const runtime = 'nodejs';

/** GET /api/company-profile?code=600519 —— 控股股东/实控人/行业资料 */
export async function GET(request: NextRequest) {
  const code = sp(request).get('code')?.trim();
  if (!code) return fail('缺少 code 参数，如 code=600519', 400);
  try {
    return ok(await getCompanyProfile(code), { cacheSeconds: 3600 });
  } catch (e) {
    return fail(e instanceof Error ? e.message : '公司资料获取失败', 502, e);
  }
}
