import type { NextRequest } from 'next/server';
import { ok, fail, sp } from '@/lib/api';
import { getMinute } from '@/lib/datasource';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/minute?code=600519 —— 当日分时 */
export async function GET(request: NextRequest) {
  const code = sp(request).get('code');
  if (!code) return fail('缺少 code 参数', 400);
  try {
    return ok(await getMinute(code));
  } catch (e) {
    return fail(e instanceof Error ? e.message : '分时获取失败', 502, e);
  }
}
