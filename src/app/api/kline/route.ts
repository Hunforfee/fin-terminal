import type { NextRequest } from 'next/server';
import { ok, fail, sp } from '@/lib/api';
import { getKLine } from '@/lib/datasource';
import type { Period, Adjust } from '@/lib/datasource/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/kline?code=600519&period=day&adjust=qfq&count=320 */
export async function GET(request: NextRequest) {
  const p = sp(request);
  const code = p.get('code');
  if (!code) return fail('缺少 code 参数', 400);

  const period = (p.get('period') ?? 'day') as Period;
  const adjust = (p.get('adjust') ?? 'qfq') as Adjust;
  const rawCount = Number(p.get('count') ?? 320);
  if (!Number.isInteger(rawCount) || rawCount < 1) return fail('count 必须为正整数', 400);
  const count = Math.min(rawCount, 3200);
  const startDate = p.get('start') ?? undefined;
  if (startDate && (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
    !Number.isFinite(Date.parse(`${startDate}T00:00:00Z`)) ||
    new Date(`${startDate}T00:00:00Z`).toISOString().slice(0, 10) !== startDate))
    return fail('start 必须为有效日期 YYYY-MM-DD', 400);

  if (!['day', 'week', 'month'].includes(period)) return fail('period 只能是 day/week/month', 400);
  if (!['none', 'qfq', 'hfq'].includes(adjust)) return fail('adjust 只能是 none/qfq/hfq', 400);

  try {
    return ok(await getKLine(code, period, adjust, count, startDate));
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'K 线获取失败', 502, e);
  }
}
