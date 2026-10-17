import type { NextRequest } from 'next/server';
import { ok, fail, sp } from '@/lib/api';
import { search } from '@/lib/datasource';

export const runtime = 'nodejs';

/** GET /api/search?q=茅台 */
export async function GET(request: NextRequest) {
  const q = sp(request).get('q')?.trim();
  if (!q) return ok([]);
  try {
    return ok(await search(q), { cacheSeconds: 300 });
  } catch (e) {
    return fail(e instanceof Error ? e.message : '搜索失败', 502, e);
  }
}
