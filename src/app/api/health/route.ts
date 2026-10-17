import { ok, fail } from '@/lib/api';
import { health } from '@/lib/datasource';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/health —— 各数据源可用性体检 */
export async function GET() {
  try {
    return ok(await health());
  } catch (e) {
    return fail(e instanceof Error ? e.message : '体检失败', 502, e);
  }
}
