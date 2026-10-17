import type { NextRequest } from 'next/server';
import { ok, fail, sp } from '@/lib/api';
import { getQuote, getQuotes } from '@/lib/datasource';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/quote?code=600519 或 ?codes=600519,000858 */
export async function GET(request: NextRequest) {
  const params = sp(request);
  const codes = params.get('codes');
  try {
    if (codes) {
      const list = codes.split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length === 0) return fail('codes 为空', 400);
      if (list.length > 200) return fail('单次最多查询 200 个标的', 400);
      return ok(await getQuotes(list));
    }
    const code = params.get('code');
    if (!code) return fail('缺少 code 参数', 400);
    const q = await getQuote(code);
    if (!q) return fail(`未找到 ${code} 的行情`, 404);
    return ok(q);
  } catch (e) {
    return fail(e instanceof Error ? e.message : '行情获取失败', 502, e);
  }
}
