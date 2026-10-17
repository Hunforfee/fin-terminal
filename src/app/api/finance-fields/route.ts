import type { NextRequest } from 'next/server';
import { ok, fail, sp } from '@/lib/api';
import { getFinanceFieldsCatalog } from '@/lib/datasource';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/finance-fields?code=600519
 * 返回三大报表全部披露科目的字段目录（按表 → 分组 → 科目），供自定义指标选择器使用。
 */
export async function GET(request: NextRequest) {
  const p = sp(request);
  const code = p.get('code');
  if (!code) return fail('缺少 code 参数，如 code=600519', 400);

  try {
    return ok(await getFinanceFieldsCatalog(code));
  } catch (e) {
    return fail(e instanceof Error ? e.message : '财务字段目录获取失败', 502, e);
  }
}
