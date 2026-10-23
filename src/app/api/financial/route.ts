import type { NextRequest } from 'next/server';
import { marketOk, fail, sp } from '@/lib/api';
import { getFinancial } from '@/lib/datasource';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/financial?code=600519 —— 优先复用库内披露财报，缺失时保留明确标识的备用口径。 */
export async function GET(request: NextRequest) {
  const code = sp(request).get('code');
  if (!code) return fail('缺少 code 参数', 400);
  try {
    return await marketOk(() => getFinancial(code));
  } catch (e) {
    return fail(e instanceof Error ? e.message : '财务数据获取失败', 502, e);
  }
}
