import type { NextRequest } from 'next/server';
import { ok, fail, sp } from '@/lib/api';
import { getPeers } from '@/lib/datasource';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/peers?code=600519 —— 同行业对比 */
export async function GET(request: NextRequest) {
  const code = sp(request).get('code');
  if (!code) return fail('缺少 code 参数', 400);
  try {
    return ok(await getPeers(code));
  } catch (e) {
    return fail(e instanceof Error ? e.message : '行业对比失败', 502, e);
  }
}
